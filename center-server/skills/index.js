// Center-managed per-Bot skill service.
//
// openSkillManager({dataRoot, store, packages, notify}) ->
//   { execute(identity, input), learningTool(identity, name, args), review(identity, input),
//     reportUse(identity, input), readInstallationFiles(installationId),
//     writeInstallationFiles(installationId, files, options), prepareInlineSkill(input),
//     LEARNING_SKILL_TOOLS, close() }
//
// identity = {deviceId, botId, origin?: 'foreground'|'background_review'|'curator',
//             sessionId?, requestId?}. origin drives upstream provenance and guards:
//   - 'background_review'/'curator': agent-created provenance, read-before-write
//     enforcement and locked protections.
//   - 'foreground' (default): owner-driven management; hard delete, no read guard.
//
// Storage: own SQLite at dataRoot/skills/skills.sqlite (skills, skill_usage,
// skill_requests). Managed skill files live directly in skills.files; writes
// sync immediately to a kind=skill artifact package through packages
// (uploadArtifact -> install/update -> enable -> Bot binding -> reconcile + notify).
//
// The learningTool() adapter maps upstream tools (skills_list, skill_view,
// skill_manage, read_file, search_files) and skill_usage.*/skill_provenance.*
// function calls onto this service; upstream-shaped results (success/_change)
// keep agent/background_review.py and agent/curator.py summaries working.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as tar from 'tar';
import { extractArtifact } from '../../host-core/managed-install/archive.js';
import { normalizeSkillReviewInput } from '../../host-core/skill-review-protocol.js';
import * as U from './upstream.js';
import { LEARNING_SKILL_TOOLS } from './learning-tools.js';

const error = (code, message, details) => Object.assign(new Error(message), { code, details });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value);
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const AUTONOMOUS_ORIGINS = new Set(['background_review', 'curator']);
const PUBLISH_WAIT_MS = 8000;
const CONTENT_CACHE_LIMIT = 6;
const CONTENT_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const REVIEW_FILE_JSON_MAX_BYTES = 14 * 1024 * 1024;

export async function openSkillManager({ dataRoot, store, packages, notify = () => {} }) {
  const root = path.join(dataRoot, 'skills');
  await mkdir(root, { recursive: true });
  const db = new DatabaseSync(path.join(root, 'skills.sqlite'));
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      name TEXT NOT NULL,
      fm_name TEXT,
      category TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      head_rev INTEGER NOT NULL DEFAULT 0,
      installation_id TEXT,
      package_id TEXT,
      published_rev INTEGER,
      files TEXT NOT NULL DEFAULT '{}',
      learning_source TEXT,
      source TEXT NOT NULL DEFAULT 'managed',
      json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(device_id, bot_id, name)
    );
    CREATE TABLE IF NOT EXISTS skill_usage (
      device_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      json TEXT NOT NULL,
      PRIMARY KEY (device_id, bot_id, name)
    );
    CREATE TABLE IF NOT EXISTS skill_requests (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const skillCols = new Set(db.prepare('PRAGMA table_info(skills)').all().map((column) => column.name));
  if (!skillCols.has('files')) {
    db.exec("ALTER TABLE skills ADD COLUMN files TEXT NOT NULL DEFAULT '{}'");
  }
  if (!skillCols.has('learning_source')) {
    db.exec('ALTER TABLE skills ADD COLUMN learning_source TEXT');
  }
  const hasLegacyRevisions = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'skill_revisions'").get(),
  );
  if (hasLegacyRevisions) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const latestRevStmt = db.prepare(
        'SELECT * FROM skill_revisions WHERE skill_id = ? ORDER BY rev DESC LIMIT 1',
      );
      const migrateSkillStmt = db.prepare(
        'UPDATE skills SET files = ?, learning_source = COALESCE(learning_source, ?) WHERE id = ?',
      );
      for (const skillRow of db.prepare('SELECT id FROM skills').all()) {
        const rev = latestRevStmt.get(skillRow.id);
        if (!rev) continue;
        let learningSource = rev.learning_source ?? null;
        if (!learningSource && rev.origin) {
          const mode = rev.origin === 'curator' ? 'curate' : rev.origin === 'foreground' ? 'learn' : 'review';
          learningSource = json({ mode, createdAt: rev.created_at });
        }
        migrateSkillStmt.run(rev.files ?? '{}', learningSource, skillRow.id);
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }
  db.exec(`
    DROP TABLE IF EXISTS skill_revisions;
    DROP TABLE IF EXISTS skill_snapshots;
    DROP TABLE IF EXISTS skill_artifacts;
  `);

  const stmts = {
    skillById: db.prepare('SELECT * FROM skills WHERE id = ?'),
    skillByName: db.prepare('SELECT * FROM skills WHERE device_id = ? AND bot_id = ? AND name = ?'),
    skillByScopedName: db.prepare('SELECT * FROM skills WHERE device_id = ? AND bot_id = ? AND category = ? AND name = ?'),
    skillsByFm: db.prepare('SELECT * FROM skills WHERE device_id = ? AND bot_id = ? AND fm_name = ?'),
    skillsFor: db.prepare('SELECT * FROM skills WHERE device_id = ? AND bot_id = ? ORDER BY name'),
    allSkills: db.prepare('SELECT * FROM skills ORDER BY created_at, id'),
    skillByInstallationId: db.prepare('SELECT * FROM skills WHERE installation_id = ?'),
    insertSkill: db.prepare('INSERT INTO skills (id, device_id, bot_id, name, fm_name, category, revision, head_rev, installation_id, package_id, published_rev, files, learning_source, source, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    updateSkill: db.prepare('UPDATE skills SET fm_name = ?, revision = ?, installation_id = ?, package_id = ?, files = ?, learning_source = ?, json = ?, updated_at = ? WHERE id = ?'),
    updateSkillDeployment: db.prepare('UPDATE skills SET installation_id = ?, package_id = ?, updated_at = ? WHERE id = ?'),
    deleteSkill: db.prepare('DELETE FROM skills WHERE id = ?'),
    usageGet: db.prepare('SELECT revision, json FROM skill_usage WHERE device_id = ? AND bot_id = ? AND name = ?'),
    usagePut: db.prepare('INSERT INTO skill_usage (device_id, bot_id, name, revision, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id, bot_id, name) DO UPDATE SET revision = excluded.revision, json = excluded.json'),
    usageDel: db.prepare('DELETE FROM skill_usage WHERE device_id = ? AND bot_id = ? AND name = ?'),
    usageAll: db.prepare('SELECT name, json FROM skill_usage WHERE device_id = ? AND bot_id = ?'),
    reqGet: db.prepare('SELECT * FROM skill_requests WHERE id = ?'),
    reqPut: db.prepare('INSERT INTO skill_requests (id, device_id, bot_id, fingerprint, json, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  };

  let txDepth = 0;
  // Nested calls join the outer transaction so the atomic skill_manage batch
  // (and multi-step writes) roll back as one unit.
  function tx(fn) {
    if (txDepth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    txDepth = 1;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original */ }
      throw err;
    } finally { txDepth = 0; }
  }

  // --- identity / queue -------------------------------------------------------
  function normalizeCronRefs(value) {
    if (!value) return null;
    const raw = Array.isArray(value) || value instanceof Set
      ? value
      : (Array.isArray(value?.skills) ? value.skills : (Array.isArray(value?.skillNames) ? value.skillNames : null));
    if (!raw) return null;
    return [...new Set([...raw].filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))];
  }

  function normalizeIdentity(identity) {
    if (!identity || typeof identity !== 'object') throw error('INVALID_ARGUMENT', 'identity is required');
    const { deviceId, botId } = identity;
    if (typeof deviceId !== 'string' || !deviceId || typeof botId !== 'string' || !botId) {
      throw error('INVALID_ARGUMENT', 'identity requires deviceId and botId');
    }
    const origin = identity.origin === undefined || identity.origin === null ? 'foreground' : String(identity.origin);
    if (!['foreground', 'background_review', 'curator'].includes(origin)) {
      throw error('INVALID_ARGUMENT', `Invalid identity origin '${origin}'`);
    }
    const cronRefs = normalizeCronRefs(identity.cronReferencedSkills ?? identity.cron_referenced_skills);
    return {
      deviceId, botId, origin,
      sessionId: typeof identity.sessionId === 'string' ? identity.sessionId : null,
      requestId: typeof identity.requestId === 'string' ? identity.requestId : null,
      ...(cronRefs ? { cronReferencedSkills: cronRefs } : {}),
    };
  }

  function assertBot(id) {
    if (!store.listDeviceBots(id.deviceId).some((bot) => bot.botId === id.botId)) {
      throw error('NOT_FOUND', 'Bot not found');
    }
  }

  const queues = new Map();
  function enqueue(id, work) {
    const key = id.deviceId + '\0' + id.botId;
    const previous = queues.get(key) || Promise.resolve();
    const result = previous.then(work);
    const tracked = result.catch(() => {});
    queues.set(key, tracked);
    tracked.finally(() => { if (queues.get(key) === tracked) queues.delete(key); });
    return result;
  }

  async function waitFor(check, timeoutMs, stepMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(stepMs);
    }
  }

  // --- managed skill rows -----------------------------------------------------
  const skillFiles = (row) => JSON.parse(row?.files || '{}');
  const displayPath = (row) => (row.category ? row.category + '/' + row.name : row.name);

  function getManaged(id, ref) {
    if (!ref) return null;
    const byId = stmts.skillById.get(ref);
    if (byId && byId.device_id === id.deviceId && byId.bot_id === id.botId) return byId;
    return stmts.skillByName.get(id.deviceId, id.botId, ref)
      ?? (ref.includes('/') ? stmts.skillByScopedName.get(id.deviceId, id.botId, ref.split('/')[0], ref.slice(ref.indexOf('/') + 1)) : null)
      ?? null;
  }

  /** Upstream _find_skill analog for the managed tier: dir name, category/name, then frontmatter name. */
  function resolveManaged(id, name) {
    const direct = getManaged(id, name);
    if (direct) return direct;
    const fm = stmts.skillsByFm.all(id.deviceId, id.botId, name);
    if (fm.length === 1) return fm[0];
    if (fm.length > 1) throw error('INVALID_ARGUMENT', `Skill name '${name}' is ambiguous (${fm.length} managed skills claim it); use the directory name`);
    return null;
  }

  /** Adapter-tier resolution: archived managed skills moved out of the live set (upstream .archive/). */
  function resolveManagedLive(id, name) {
    const row = resolveManaged(id, name);
    if (row && usageRow(id, row.name).record?.state === U.STATE_ARCHIVED) return null;
    return row;
  }

  /** True when a Bot-managed skill is shared beyond its owner Bot and exempt from single-Bot auto-archival. */
  function isSharedSkill(row) {
    if (!row?.installation_id) return false;
    const installation = store.getInstallation(row.installation_id);
    if (!installation) return false;
    if (installation.visibilityScope === 'assigned' || installation.visibilityScope === 'global') return true;
    return store.listBotBindings({ installationId: row.installation_id })
      .some((b) => b.enabled && (b.deviceId !== row.device_id || b.botId !== row.bot_id));
  }

  function cronReferencedSkillsFor(id, a) {
    const names = new Set();
    for (const src of [id?.cronReferencedSkills, a?.cron_referenced_skills, a?.cronReferencedSkills]) {
      const normalized = normalizeCronRefs(src);
      if (normalized) {
        for (const item of normalized) names.add(item);
      }
    }
    const jobId = id?.learningSource?.jobId ?? id?.sessionId ?? null;
    if (names.size === 0 && id?.origin === 'curator' && jobId) {
      const learningDbPath = path.join(dataRoot, 'learning.sqlite');
      if (existsSync(learningDbPath)) {
        let ldb = null;
        try {
          ldb = new DatabaseSync(learningDbPath, { readOnly: true });
          const row = ldb.prepare(
            "SELECT result FROM learning_calls WHERE job_id = ? AND method = 'schedule.call' AND answered = 1 AND answered_by = 'host' AND result IS NOT NULL ORDER BY seq DESC LIMIT 1",
          ).get(jobId);
          if (row?.result) {
            const normalized = normalizeCronRefs(JSON.parse(row.result));
            if (normalized) {
              for (const item of normalized) names.add(item);
            }
          }
        } catch {
          // Best-effort lookup when learning.sqlite is present and readable.
        } finally {
          try { ldb?.close(); } catch { /* ignore */ }
        }
      }
    }
    return names;
  }

  function isCronReferenced(row, rawName, cronSet) {
    if (!cronSet || cronSet.size === 0) return false;
    if (row?.name && cronSet.has(row.name)) return true;
    if (row?.fm_name && cronSet.has(row.fm_name)) return true;
    if (typeof rawName === 'string' && cronSet.has(rawName.trim())) return true;
    return false;
  }

  // --- usage records ----------------------------------------------------------
  function usageRow(id, name) {
    const row = stmts.usageGet.get(id.deviceId, id.botId, name);
    return row ? { revision: row.revision, record: JSON.parse(row.json) } : { revision: 0, record: null };
  }

  function usageWrite(id, name, revision, record) {
    stmts.usagePut.run(id.deviceId, id.botId, name, revision, json(record));
  }

  /** Load-or-create record, apply mutator, save when it returned a result. Mirrors _mutate. */
  function usageMutate(id, name, mutator, { eligibleOnly = false, installedList = [] } = {}) {
    if (!name) return null;
    if (eligibleOnly && !isCurationEligible(id, name, installedList)) return null;
    return tx(() => {
      const current = usageRow(id, name);
      const record = current.record ?? U.emptyRecord();
      const result = mutator(record);
      usageWrite(id, name, current.revision + 1, record);
      return result;
    });
  }

  const bumpView = (id, name) => usageMutate(id, name, (rec) => U.bumpViewApply(rec));
  const bumpUse = (id, name) => usageMutate(id, name, (rec) => U.bumpUseApply(rec));
  const bumpPatch = (id, name) => usageMutate(id, name, (rec) => U.bumpPatchApply(rec));
  const forget = (id, name) => {
    if (name) stmts.usageDel.run(id.deviceId, id.botId, name);
  };
  const seedRecord = (id, name, installedList = []) => {
    if (!name || !isCurationEligible(id, name, installedList)) return null;
    return tx(() => {
      const current = usageRow(id, name);
      if (current.record) return null;
      usageWrite(id, name, current.revision + 1, { ...U.emptyRecord(), first_seen_at: now() });
      return null;
    });
  };

  // --- installed (bound skill packages) ---------------------------------------
  /** Bound kind=skill host installations for this Bot, excluding this service's own managed ones. */
  function boundSkillInstallations(id) {
    const managedIds = new Set(stmts.skillsFor.all(id.deviceId, id.botId)
      .map((row) => row.installation_id).filter(Boolean));
    return store.listBotBindings({ deviceId: id.deviceId })
      .filter((binding) => binding.botId === id.botId && !managedIds.has(binding.installationId))
      .map((binding) => ({ binding, installation: store.getInstallation(binding.installationId) }))
      .filter((entry) => entry.installation && entry.installation.kind === 'skill' && entry.installation.target === 'host');
  }

  const metaCache = new Map();   // artifactRef -> [{dir,name,description,files:[rel]}]
  const contentCache = new Map(); // artifactRef -> [{dir,name,description,files:Map<rel,utf8>}]

  function cachePut(map, key, value, limit) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
  }

  async function installedPackage(ref) {
    const cached = metaCache.get(ref);
    if (cached) return cached;
    const bytes = await packages.readArtifact(ref);
    const dir = path.join(root, 'extract-' + randomUUID());
    try {
      await extractArtifact(bytes, dir);
      const skills = [];
      const scan = async (base) => {
        const entries = await readdir(base, { withFileTypes: true });
        if (entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile())) {
          const content = await readFile(path.join(base, 'SKILL.md'), 'utf8');
          const files = [];
          const walk = async (sub, rel) => {
            for (const entry of await readdir(sub, { withFileTypes: true })) {
              const next = path.join(sub, entry.name);
              const relPath = rel ? rel + '/' + entry.name : entry.name;
              if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') await walk(next, relPath);
              else if (entry.isFile()) files.push(relPath);
            }
          };
          await walk(base, '');
          skills.push({
            dir: path.relative(dir, base).split(path.sep).join('/') || '.',
            name: fmNameOf(content) || path.basename(base),
            description: U.descriptionOf(content),
            files: files.sort(),
          });
          return;
        }
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') await scan(path.join(base, entry.name));
        }
      };
      await scan(dir);
      cachePut(metaCache, ref, skills, 64);
      return skills;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Extract an installed package with full file contents (bounded). */
  async function installedPackageContent(ref) {
    const cached = contentCache.get(ref);
    if (cached) return cached;
    const bytes = await packages.readArtifact(ref);
    const dir = path.join(root, 'extract-' + randomUUID());
    try {
      await extractArtifact(bytes, dir);
      const skills = await installedPackage(ref);
      const out = [];
      let total = 0;
      for (const skill of skills) {
        const files = new Map();
        for (const rel of skill.files) {
          const file = path.join(dir, skill.dir === '.' ? rel : skill.dir + '/' + rel);
          const buf = await readFile(file);
          total += buf.length;
          if (total > CONTENT_CACHE_MAX_BYTES) throw error('PAYLOAD_TOO_LARGE', 'Installed skill package is too large to read');
          files.set(rel, buf.toString('utf8'));
        }
        out.push({ ...skill, files });
      }
      cachePut(contentCache, ref, out, CONTENT_CACHE_LIMIT);
      return out;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  function fmNameOf(content) {
    try {
      const parsed = U.parseFrontmatter(content);
      const name = parsed?.frontmatter?.name;
      return typeof name === 'string' && name.trim() ? name.trim().slice(0, U.MAX_NAME_LENGTH) : null;
    } catch { return null; }
  }

  /** [{installation,binding,version,artifactRef,skills:[{dir,name,description,files}]}] for this Bot. */
  async function installedSkills(id) {
    const out = [];
    for (const { binding, installation } of boundSkillInstallations(id)) {
      const version = store.getPackageVersion(installation.packageId, installation.targetVersion);
      let skills = [];
      if (version?.artifactRef) {
        try { skills = await installedPackage(version.artifactRef); }
        catch { skills = []; } // unreadable package stays listable, just not resolvable
      }
      out.push({ binding, installation, version, artifactRef: version?.artifactRef ?? null, skills });
    }
    return out;
  }

  /** Name -> installed skill entry (shadowed by managed names elsewhere). */
  function resolveInstalled(installedList, name) {
    const matches = [];
    for (const entry of installedList) {
      for (const skill of entry.skills) {
        if (skill.name === name || (skill.dir !== '.' && skill.dir === name) ||
            entry.installation.displayName === name) {
          matches.push({ entry, skill });
        }
      }
    }
    if (matches.length > 1) {
      throw error('INVALID_ARGUMENT', `Skill name '${name}' is ambiguous across installed packages; use the installationId`);
    }
    return matches[0] ?? null;
  }

  // --- provenance --------------------------------------------------------------
  function managedRow(id, name) { return stmts.skillByName.get(id.deviceId, id.botId, name) ?? null; }
  function installedClaims(installedList, name) { return resolveInstalled(installedList ?? [], name) !== null; }
  /** is_hub_installed analog: bound package claims the name and no managed skill shadows it. */
  function isHubInstalled(id, name, installedList = []) {
    return !managedRow(id, name) && installedClaims(installedList, name);
  }
  function isCurationEligible(id, name, installedList = []) {
    if (isHubInstalled(id, name, installedList)) return false;
    return true; // managed or unknown names are local/eligible (upstream parity)
  }
  function isCuratorManaged(id, name) {
    return U.isCuratorManagedRecord(usageRow(id, name).record);
  }
  function provenanceOf(id, name, installedList) {
    return isHubInstalled(id, name, installedList) ? 'hub' : 'agent';
  }
  function telemetryProvenance(id, name, installedList) {
    if (isHubInstalled(id, name, installedList)) return 'installed';
    const { record } = usageRow(id, name);
    const label = { installed: 'installed', agent: 'agent_created' }[record?.created_by];
    if (label) return label;
    if (installedList && installedClaims(installedList, name)) return 'external';
    return managedRow(id, name) || record ? 'local' : 'unknown';
  }

  // --- read-before-write marks -------------------------------------------------
  const readMarks = new Map(); // scopeKey -> Map<skillName, Set<filePath>>
  const markKey = (id) => [id.deviceId, id.botId, id.sessionId || id.requestId || 'foreground'].join('\0');
  function markRead(id, skillName, filePath) {
    const key = markKey(id);
    let marks = readMarks.get(key);
    if (!marks) { marks = new Map(); readMarks.set(key, marks); }
    let files = marks.get(skillName);
    if (!files) { files = new Set(); marks.set(skillName, files); }
    files.add(filePath);
    if (readMarks.size > 256) readMarks.delete(readMarks.keys().next().value);
  }
  function wasRead(id, skillName, filePath) {
    return Boolean(readMarks.get(markKey(id))?.get(skillName)?.has(filePath));
  }
  /** Upstream _background_review_read_before_write_guard: autonomous origins only, existing files only. */
  function readBeforeWriteGuard(id, skillName, fileExists, filePath, label) {
    if (!AUTONOMOUS_ORIGINS.has(id.origin) || !fileExists) return null;
    if (wasRead(id, skillName, filePath)) return null;
    return U.refusal(`Read '${label}' via skill_view(name='${skillName}'` +
      (filePath === 'SKILL.md' ? ')' : `, file_path='${filePath}')`) +
      ' or read_file during this review before modifying it. New skills and new files need no prior read.');
  }

  const lockedGuard = (id, name) => {
    if (!AUTONOMOUS_ORIGINS.has(id.origin)) return null;
    if (usageRow(id, name).record?.locked === true) {
      return U.refusal(`Skill '${name}' is locked by the user; autonomous reviews and the curator must not change its content.`);
    }
    return null;
  };

  // --- managed write helpers ---------------------------------------------------
  function normalizeFilesMap(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw error('INVALID_ARGUMENT', 'files must be an object mapping relative paths to UTF-8 text');
    }
    const files = {};
    let total = 0;
    const entries = Object.entries(input);
    if (entries.length > U.MAX_SKILL_FILES) throw error('PAYLOAD_TOO_LARGE', `A skill holds at most ${U.MAX_SKILL_FILES} files`);
    for (const [rawPath, content] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
      const checked = U.checkStoragePath(rawPath);
      if (checked.error) throw error('INVALID_ARGUMENT', checked.error);
      if (content === null || content === undefined) { files[checked.path] = null; continue; }
      if (typeof content !== 'string') throw error('INVALID_ARGUMENT', `File '${rawPath}' must be UTF-8 text`);
      const size = Buffer.byteLength(content, 'utf8');
      if (size > U.MAX_SKILL_FILE_BYTES) throw error('PAYLOAD_TOO_LARGE', `File '${rawPath}' exceeds ${U.MAX_SKILL_FILE_BYTES} bytes`);
      total += size;
      if (total > U.MAX_SKILL_TOTAL_BYTES) throw error('PAYLOAD_TOO_LARGE', 'Skill files exceed the total size limit');
      files[checked.path] = content;
    }
    return files;
  }

  /** Files map -> skill row update inside a tx. Returns updated summary fields. */
  function commitSkillFiles(skill, files, { learningSource } = {}) {
    const description = U.descriptionOf(files['SKILL.md']);
    const fmName = fmNameOf(files['SKILL.md']);
    const revision = (skill.revision ?? 0) + 1;
    const meta = JSON.parse(skill.json || '{}');
    const nextLearningSource = learningSource ? json(learningSource) : (skill.learning_source ?? null);
    stmts.updateSkill.run(fmName, revision, skill.installation_id, skill.package_id, json(files), nextLearningSource, json(meta), now(), skill.id);
    return { revision, description, fmName };
  }

  function validateSkillMd(content, { requireDescriptionBudget = false, before } = {}) {
    return U.validateFrontmatter(content) || U.validateContentSize(content)
      || (requireDescriptionBudget ? U.descriptionBudgetError(content, before) : null);
  }

  function revalidateWhole(files) {
    // Every write path validates the resulting SKILL.md so a publish can never ship a broken draft.
    if (files['SKILL.md'] !== undefined && files['SKILL.md'] !== null) {
      const err = validateSkillMd(files['SKILL.md']);
      if (err) return err;
    }
    return null;
  }

  const notFound = (name) => U.refusal(`Skill '${name}' not found. Use skills_list() to see available skills.`);

  // --- upstream skill_manage op handlers ----------------------------------------
  // Each returns a result dict; the caller serializes. Mutations run inside one tx.

  function opCreate(id, a, installedList = []) {
    const name = a.name, content = a.content, category = a.category ?? null;
    const nameErr = U.validateName(name);
    if (nameErr) return U.refusal(nameErr);
    const catErr = U.validateCategory(category);
    if (catErr) return U.refusal(catErr);
    const fmErr = validateSkillMd(content, { requireDescriptionBudget: true });
    if (fmErr) return U.refusal(fmErr);
    if (managedRow(id, name)) return U.refusal(`A skill named '${name}' already exists at '${name}'.`);
    try { if (installedClaims(installedList, name)) return U.refusal(`A skill named '${name}' already exists in an installed package.`); }
    catch { /* ambiguous installed names still refuse below via managed write */ }
    const files = { 'SKILL.md': content };
    const fmName = fmNameOf(content);
    const skillId = randomUUID();
    const skillCategory = category ? category.trim() : null;
    const createdAt = now();
    const learningSource = id.learningSource ? json(id.learningSource) : null;
    stmts.insertSkill.run(skillId, id.deviceId, id.botId, name, fmName, skillCategory, 1, 0, null, null, null, json(files), learningSource, 'managed', '{}', createdAt, createdAt);
    const result = U.successResult({
      message: `Skill '${name}' created.`, path: displayPath({ name, category: skillCategory }),
      skill_md: 'SKILL.md', _change: { description: U.descriptionPreview(content) },
      ...(skillCategory ? { category: skillCategory } : {}),
      hint: `To add reference files, templates, or scripts, use skill_manage(action='write_file', name='${name}', file_path='references/example.md', file_content='...')`,
    });
    U.addDescriptionPromptPreview(result, content);
    return { result, skillId, skillName: name, usage: () => usageMutate(id, name, (rec) => U.recordCreatedApply(rec, AUTONOMOUS_ORIGINS.has(id.origin))) };
  }

  function locateForWrite(id, name, installedList = []) {
    const row = resolveManagedLive(id, name);
    if (row) return { row };
    // A name only an installed package claims is the upstream "external" tier: read-only.
    try {
      if (installedClaims(installedList, name)) {
        return { error: U.refusal(`Skill '${name}' is installed from a package and read-only; adopt it into a managed skill first.`) };
      }
    } catch { /* ambiguous installed names fall through to not-found */ }
    return { error: notFound(name) };
  }

  function opPatch(id, a, files) {
    const row = a._row;
    const filePath = a.file_path ? checkPathOr(a.file_path) : { path: 'SKILL.md' };
    if (filePath.error) return U.refusal(filePath.error);
    const target = filePath.path;
    if (!(target in files)) return U.refusal(`File not found: ${target}`);
    if (a.content !== undefined && a.content !== null && (a.old_string !== undefined || a.new_string !== undefined)) {
      return U.refusal("Pass either content (full rewrite) or old_string/new_string (targeted patch), not both.");
    }
    if (a.content !== undefined && a.content !== null) {
      // full rewrite of SKILL.md (upstream 'edit')
      if (target !== 'SKILL.md') return U.refusal('content rewrites apply to SKILL.md; patch supporting files with old_string/new_string.');
      const fmErr = validateSkillMd(a.content, { requireDescriptionBudget: true, before: files['SKILL.md'] });
      if (fmErr) return U.refusal(`Patch would break SKILL.md structure: ${fmErr}`);
      const guard = readBeforeWriteGuard(id, row.name, true, 'SKILL.md', 'SKILL.md');
      if (guard) return guard;
      files['SKILL.md'] = a.content;
      const result = U.successResult({
        message: `Skill '${row.name}' updated (full rewrite).`, path: displayPath(row),
        _change: { description: U.descriptionPreview(a.content) },
      });
      U.addDescriptionPromptPreview(result, a.content);
      return { result, row, files, usage: () => bumpPatch(id, row.name) };
    }
    if (!a.old_string) return U.refusal('old_string is required for a targeted patch (or pass content for a full rewrite).');
    if (a.new_string === undefined || a.new_string === null) return U.refusal('new_string is required for a targeted patch.');
    const guard = readBeforeWriteGuard(id, row.name, true, target, target);
    if (guard) return guard;
    const content = files[target];
    const matched = U.findAndReplace(content, a.old_string, a.new_string, a.replace_all === true);
    if (matched.error) {
      return U.refusal(matched.error, { file_preview: U.clip(content, 500, '...') });
    }
    if (target === 'SKILL.md') {
      const fmErr = U.validateFrontmatter(matched.newContent) || U.validateContentSize(matched.newContent)
        || U.descriptionBudgetError(matched.newContent, content);
      if (fmErr) return U.refusal(`Patch would break SKILL.md structure: ${fmErr}`);
    } else {
      const sizeErr = U.validateContentSize(matched.newContent, target);
      if (sizeErr) return U.refusal(sizeErr);
    }
    files[target] = matched.newContent;
    const result = U.successResult({
      message: `Patched ${target} in skill '${row.name}' (${matched.count} replacement${matched.count > 1 ? 's' : ''}).`,
      _change: { old: U.clip(a.old_string, 200, '…'), new: U.clip(a.new_string, 200, '…') },
    });
    return { result, row, files, usage: () => bumpPatch(id, row.name) };
  }

  function opWriteFile(id, a, files) {
    const row = a._row;
    const checked = checkPathOr(a.file_path);
    if (checked.error) return U.refusal(checked.error);
    if (a.file_content === undefined || a.file_content === null) return U.refusal('file_content is required.');
    const content = String(a.file_content);
    if (Buffer.byteLength(content, 'utf8') > U.MAX_SKILL_FILE_BYTES) {
      return U.refusal(`File content is ${Buffer.byteLength(content, 'utf8').toLocaleString('en-US')} bytes (limit: ${U.MAX_SKILL_FILE_BYTES.toLocaleString('en-US')} bytes / 1 MiB). Consider splitting into smaller files.`);
    }
    const sizeErr = U.validateContentSize(content, checked.path);
    if (sizeErr) return U.refusal(sizeErr);
    const existed = checked.path in files;
    const guard = readBeforeWriteGuard(id, row.name, existed, checked.path, checked.path);
    if (guard) return guard;
    if (checked.path === 'SKILL.md') {
      const fmErr = U.validateFrontmatter(content) || U.descriptionBudgetError(content, existed ? files['SKILL.md'] : null);
      if (fmErr) return U.refusal(`Write would break SKILL.md structure: ${fmErr}`);
    }
    files[checked.path] = content;
    const result = U.successResult({ message: `File '${checked.path}' written to skill '${row.name}'.`, path: checked.path });
    return { result, row, files, usage: () => bumpPatch(id, row.name) };
  }

  function opRemoveFile(id, a, files) {
    const row = a._row;
    const checked = checkPathOr(a.file_path);
    if (checked.error) return U.refusal(checked.error);
    const target = checked.path;
    if (target === 'SKILL.md') return U.refusal('A managed skill must keep its SKILL.md.');
    if (!(target in files)) {
      const available = Object.keys(files).filter((f) => f !== 'SKILL.md');
      return U.refusal(`File '${target}' not found in skill '${row.name}'.`, { available_files: available.length ? available : null });
    }
    const guard = readBeforeWriteGuard(id, row.name, true, target, target);
    if (guard) return guard;
    delete files[target];
    const result = U.successResult({ message: `File '${target}' removed from skill '${row.name}'.` });
    return { result, row, files, usage: () => bumpPatch(id, row.name) };
  }

  function checkPathOr(filePath) {
    return U.checkFilePath(filePath);
  }

  /** Apply one skill_manage operation. Returns {result, row?, skillId?, archivedSkillName?, disabledInstallationId?, files?, usage?}. */
  function applyManageOp(id, a, installedList, options = {}) {
    const action = a.action;
    if (!action || typeof action !== 'string') return U.refusal("action is required. Use: create, patch, write_file, remove_file");
    if (action === 'create') return opCreate(id, a, installedList);
    if (action === 'delete') {
      if (id.origin !== 'curator') {
        return U.refusal('Deleting a skill requires a separate user decision in skill management.');
      }
      const delBase = path.posix.basename(String(a.name ?? '').replace(/\\/g, '/'));
      const delNameErr = U.validateName(delBase);
      if (delNameErr) return U.refusal(delNameErr);
      const locatedDel = locateForWrite(id, a.name, installedList);
      if (locatedDel.error) return locatedDel.error;
      const delRow = locatedDel.row;
      const lockErr = lockedGuard(id, delRow.name);
      if (lockErr) return lockErr;
      if (usageRow(id, delRow.name).record?.pinned) {
        return U.refusal(`Skill '${delRow.name}' is pinned and cannot be archived by the curator.`);
      }
      if (isSharedSkill(delRow)) {
        return U.refusal(`Skill '${delRow.name}' is shared across Bots and cannot be archived by a single Bot's curator.`);
      }
      const cronRefs = cronReferencedSkillsFor(id, a);
      if (isCronReferenced(delRow, a.name, cronRefs)) {
        return U.refusal(`Skill '${delRow.name}' is referenced by a scheduled task (cron) and cannot be archived.`);
      }
      const absorbedRef = typeof a.absorbed_into === 'string' ? a.absorbed_into.trim() : '';
      const target = absorbedRef ? resolveManagedLive(id, absorbedRef) : null;
      if (!target || target.id === delRow.id) {
        return U.refusal("Consolidation delete requires absorbed_into naming a surviving live skill.");
      }
      const [ok, msg, disabledInstallationId] = archiveSkillNow(id, delRow.name, installedList, {
        deferBindingDisable: options.deferBindingDisable === true,
      });
      if (!ok) return U.refusal(msg);
      return {
        result: U.successResult({
          message: `Skill '${delRow.name}' archived (absorbed into '${target.name}').`,
          archived: true,
          absorbed_into: target.name,
        }),
        archivedSkillName: delRow.name,
        disabledInstallationId: disabledInstallationId ?? null,
      };
    }
    if (!['patch', 'edit', 'write_file', 'remove_file'].includes(action)) {
      return U.refusal(`Unknown action '${action}'. Use: create, edit, patch, write_file, remove_file`);
    }
    const base = path.posix.basename(String(a.name ?? '').replace(/\\/g, '/'));
    const nameErr = U.validateName(base);
    if (nameErr) return U.refusal(nameErr);
    const located = locateForWrite(id, a.name, installedList);
    if (located.error) return located.error;
    const row = located.row;
    a._row = row;
    const lockErr = lockedGuard(id, row.name);
    if (lockErr) return lockErr;
    const files = skillFiles(row);
    if (action === 'edit') {
      // Legacy alias: full SKILL.md rewrite.
      return opPatch(id, { ...a, content: a.content, file_path: undefined, old_string: undefined, new_string: undefined }, files);
    }
    if (action === 'patch') return opPatch(id, a, files);
    if (action === 'write_file') return opWriteFile(id, a, files);
    return opRemoveFile(id, a, files);
  }

  /** Persist one applied op inside the caller's tx: update skill files, then usage side effects. */
  function persistManageResult(id, applied) {
    if (applied.files && applied.row) {
      const err = revalidateWhole(applied.files);
      if (err) return U.refusal(err);
      commitSkillFiles(applied.row, applied.files, { learningSource: id.learningSource });
    }
    applied.usage?.();
    return null;
  }

  /** Archive immediately for the management API (or defer center.sqlite binding disable until batch commit). */
  function archiveSkillNow(id, name, installedList, options = {}) {
    const { deferBindingDisable = false } = options;
    const row = managedRow(id, name);
    if (!row) {
      if (isHubInstalled(id, name, installedList)) return [false, `skill '${name}' is hub-installed; never archive`, null];
      return [false, `skill '${name}' not found`, null];
    }
    const { record } = usageRow(id, name);
    if (record?.state === U.STATE_ARCHIVED) return [false, `skill '${name}' not found`, null];
    const current = record ?? U.emptyRecord();
    const bindingWasEnabled = Boolean(row.installation_id && bindingEnabled(id, row.installation_id));
    const disabledInstallationId = bindingWasEnabled ? row.installation_id : null;
    U.setStateApply(current, U.STATE_ARCHIVED);
    current.archive_binding_was_enabled = bindingWasEnabled;
    usageWrite(id, name, usageRow(id, name).revision + 1, current);
    if (!deferBindingDisable && disabledInstallationId) setBindingEnabled(id, disabledInstallationId, false);
    return [true, `archived to .archive/${name}`, disabledInstallationId];
  }

  function restoreSkillNow(id, name, installedList) {
    const row = managedRow(id, name);
    if (!row) {
      if (isHubInstalled(id, name, installedList)) return [false, `skill '${name}' is now hub-installed; restore would shadow the upstream version`];
      return [false, `skill '${name}' not found in archive`];
    }
    const { record } = usageRow(id, name);
    if (!record || record.state !== U.STATE_ARCHIVED) return [false, `skill '${name}' not found in archive`];
    U.setStateApply(record, U.STATE_ACTIVE);
    const rebind = record.archive_binding_was_enabled === true;
    delete record.archive_binding_was_enabled;
    usageWrite(id, name, usageRow(id, name).revision + 1, record);
    if (rebind && row.installation_id) setBindingEnabled(id, row.installation_id, true);
    return [true, `restored to ${displayPath(row)}`];
  }

  function bindingEnabled(id, installationId) {
    try {
      const capability = store.getBotCapability(id.deviceId, id.botId, installationId);
      const installation = store.getInstallation(installationId);
      return Boolean(installation && store.isActive(installation) && capability.enabled);
    } catch { return false; }
  }

  function setBindingEnabled(id, installationId, enabled) {
    try {
      const capability = store.getBotCapability(id.deviceId, id.botId, installationId);
      if (capability.enabled === enabled) return;
      if (enabled) {
        const installation = store.getInstallation(installationId);
        if (!installation || !store.isActive(installation)) return; // cannot re-enable a dead installation
      }
      store.putBotCapability(id.deviceId, id.botId, installationId, { enabled, overrides: capability.overrides ?? {}, expectedRevision: capability.revision });
    } catch { /* binding side effects are best-effort; the state flag stays authoritative */ }
  }

  // --- skill_usage.* function surface -------------------------------------------
  const skillUsageCalls = {
    snapshot_skills: () => ({ id: 'noop' }),
    prune_old_snapshots: () => [],
    bump_view: (id, a) => { bumpView(id, a.skill_name ?? a.name); return null; },
    bump_use: (id, a) => { bumpUse(id, a.skill_name ?? a.name); return null; },
    bump_patch: (id, a) => { bumpPatch(id, a.skill_name ?? a.name); return null; },
    record_created: (id, a) => {
      const name = a.skill_name ?? a.name;
      const agentCreated = a.agent_created !== undefined ? Boolean(a.agent_created) : AUTONOMOUS_ORIGINS.has(id.origin);
      usageMutate(id, name, (rec) => U.recordCreatedApply(rec, agentCreated));
      return null;
    },
    record_installed: (id, a) => {
      const name = a.skill_name ?? a.name;
      if (usageRow(id, name).record?.state === U.STATE_ARCHIVED) return null;
      return usageMutate(id, name, (rec) => {
        rec.created_by = 'installed';
        rec.state = U.STATE_ACTIVE;
        rec.archived_at = null;
        return { created_by: 'installed' };
      });
    },
    mark_agent_created: (id, a, installedList) => usageMutate(id, a.skill_name ?? a.name, (rec) => {
      rec.created_by = 'agent';
      return true;
    }, { eligibleOnly: true, installedList }),
    forget: (id, a) => {
      const name = a.skill_name ?? a.name;
      if (usageRow(id, name).record?.state !== U.STATE_ARCHIVED) forget(id, name);
      return null;
    },
    get_record: (id, a) => U.backfilled(usageRow(id, a.skill_name ?? a.name).record),
    load_usage: (id) => Object.fromEntries(stmts.usageAll.all(id.deviceId, id.botId).map((row) => [row.name, JSON.parse(row.json)])),
    seed_record_if_missing: (id, a, installedList) => { seedRecord(id, a.skill_name ?? a.name, installedList); return null; },
    reanchor_clock: (id, a) => usageMutate(id, a.skill_name ?? a.name, (rec) => {
      rec.created_at = rec.first_seen_at = now();
      if (rec.state === U.STATE_STALE) rec.state = U.STATE_ACTIVE;
      return null;
    }),
    set_state: (id, a, installedList) => {
      const name = a.skill_name ?? a.name;
      const state = a.state;
      if (state !== U.STATE_ACTIVE && state !== U.STATE_STALE) return null;
      if (usageRow(id, name).record?.state === U.STATE_ARCHIVED || !isCurationEligible(id, name, installedList)) return null;
      usageMutate(id, name, (rec) => U.setStateApply(rec, state));
      return null;
    },
    set_pinned: (id, a, installedList) => Boolean(usageMutate(id, a.skill_name ?? a.name, (rec) => {
      rec.pinned = Boolean(a.pinned);
      return true;
    }, { eligibleOnly: true, installedList })),
    set_locked: (id, a) => Boolean(usageMutate(id, a.skill_name ?? a.name, (rec) => {
      rec.locked = Boolean(a.locked);
      return true;
    })),
    is_locked: (id, a) => usageRow(id, a.skill_name ?? a.name).record?.locked === true,
    locked_skill_names: (id) => stmts.usageAll.all(id.deviceId, id.botId)
      .map((row) => row.name).filter((name) => usageRow(id, name).record?.locked === true).sort(),
    // provenance
    is_agent_created: (id, a, installedList) => !isHubInstalled(id, a.skill_name ?? a.name, installedList),
    is_bundled: () => false,
    is_hub_installed: (id, a, installedList) => isHubInstalled(id, a.skill_name ?? a.name, installedList),
    is_external_only: () => false,
    is_protected_builtin: () => false,
    is_curation_eligible: (id, a, installedList) => isCurationEligible(id, a.skill_name ?? a.name, installedList),
    is_curator_managed: (id, a) => isCuratorManaged(id, a.skill_name ?? a.name),
    provenance: (id, a, installedList) => provenanceOf(id, a.skill_name ?? a.name, installedList),
    telemetry_provenance: (id, a, installedList) => telemetryProvenance(id, a.skill_name ?? a.name, installedList),
    // listings
    list_agent_created_skill_names: (id) => stmts.skillsFor.all(id.deviceId, id.botId)
      .filter((row) => usageRow(id, row.name).record?.state !== U.STATE_ARCHIVED)
      .filter((row) => U.isCuratorManagedRecord(usageRow(id, row.name).record))
      .map((row) => row.name).sort(),
    list_archived_skill_names: (id) => stmts.skillsFor.all(id.deviceId, id.botId)
      .filter((row) => usageRow(id, row.name).record?.state === U.STATE_ARCHIVED)
      .map((row) => row.name).sort(),
    list_unmanaged_skill_names: (id, _a, installedList) => stmts.skillsFor.all(id.deviceId, id.botId)
      .filter((row) => usageRow(id, row.name).record?.state !== U.STATE_ARCHIVED)
      .filter((row) => !U.isCuratorManagedRecord(usageRow(id, row.name).record))
      .filter((row) => isCurationEligible(id, row.name, installedList))
      .map((row) => row.name).sort(),
    unmanaged_report: (id, _a, installedList) => skillUsageCalls.list_unmanaged_skill_names(id, _a, installedList)
      .map((name) => {
        const { record } = usageRow(id, name);
        return U.reportRow(name, record, { has_provenance_key: Boolean(record && 'created_by' in record), has_record: Boolean(record) });
      }),
    curated_report: (id, _a, installedList) => {
      const names = new Set(skillUsageCalls.list_agent_created_skill_names(id));
      for (const row of stmts.skillsFor.all(id.deviceId, id.botId)) {
        const { record } = usageRow(id, row.name);
        if ((record?.pinned || isSharedSkill(row)) && record?.state !== U.STATE_ARCHIVED && isCurationEligible(id, row.name, installedList)) {
          names.add(row.name);
        }
      }
      return [...names].sort().map((name) => {
        const row = managedRow(id, name);
        const { record } = usageRow(id, name);
        const shared = isSharedSkill(row);
        const effectiveRecord = shared ? { ...(record ?? U.emptyRecord()), pinned: true } : record;
        return U.reportRow(name, effectiveRecord, {
          _persisted: Boolean(record),
          provenance: provenanceOf(id, name, installedList),
          ...(shared ? { shared: true } : {}),
        });
      });
    },
    usage_report: async (id, _a, installedList) => {
      const names = stmts.skillsFor.all(id.deviceId, id.botId)
        .filter((row) => usageRow(id, row.name).record?.state !== U.STATE_ARCHIVED)
        .map((row) => row.name);
      for (const entry of installedList) for (const skill of entry.skills) names.push(skill.name);
      return [...new Set(names)].sort().map((name) => {
        const { record } = usageRow(id, name);
        return U.reportRow(name, record, { provenance: provenanceOf(id, name, installedList), _persisted: Boolean(record) });
      });
    },
    read_suppressed_names: () => [],
    // lifecycle
    archive_skill: async (id, a, installedList) => {
      if (id.origin !== 'curator') {
        return [false, 'Archiving a skill requires a separate user decision in skill management.'];
      }
      const name = a.skill_name ?? a.name;
      if (!name) return [false, 'no skill name given'];
      const row = managedRow(id, name);
      if (!row) return [false, `skill '${name}' not found`];
      const lockErr = lockedGuard(id, row.name);
      if (lockErr) return [false, lockErr.error ?? `skill '${name}' is locked`];
      if (usageRow(id, row.name).record?.pinned) return [false, `skill '${name}' is pinned`];
      if (isSharedSkill(row)) return [false, `skill '${name}' is shared across Bots`];
      const cronRefs = cronReferencedSkillsFor(id, a);
      if (isCronReferenced(row, name, cronRefs)) return [false, `skill '${row.name}' is referenced by a scheduled task (cron)`];
      const [ok, msg, disabledInstallationId] = tx(() => archiveSkillNow(id, row.name, installedList, { deferBindingDisable: true }));
      if (ok) {
        if (disabledInstallationId) setBindingEnabled(id, disabledInstallationId, false);
        try { await packages.reconcileDevice(id.deviceId); } finally { notify(id.deviceId); }
      }
      return [ok, msg];
    },
    restore_skill: () => [false, 'Restoring a skill requires a separate user decision in skill management.'],
    adopt_skill: (id, a, installedList) => {
      const name = a.skill_name ?? a.name;
      if (!name) return [false, 'no skill name given'];
      if (isHubInstalled(id, name, installedList)) return [false, `'${name}' is hub-installed; its upstream owns it`];
      if (!managedRow(id, name)) return [false, `skill '${name}' not found`];
      if (isCuratorManaged(id, name)) return [true, `'${name}' is already curator-managed`];
      usageMutate(id, name, (rec) => { rec.created_by = 'agent'; return true; });
      return [true, `adopted '${name}' into curator management`];
    },
    // pure helpers
    latest_activity_at: (id, a) => U.latestActivityAt(a.record ?? a),
    activity_count: (id, a) => U.activityCount(a.record ?? a),
    read_skill_name: (id, a) => {
      const fallback = typeof a.fallback === 'string' ? a.fallback : '';
      if (typeof a.content !== 'string') return fallback;
      const name = fmNameOf(a.content);
      return name || fallback;
    },
    constants: () => ({ STATE_ACTIVE: U.STATE_ACTIVE, STATE_STALE: U.STATE_STALE, STATE_ARCHIVED: U.STATE_ARCHIVED }),
  };

  const provenanceCalls = {
    is_background_review: (id) => AUTONOMOUS_ORIGINS.has(id.origin),
    is_unattended_review: (id) => AUTONOMOUS_ORIGINS.has(id.origin),
    get_current_write_origin: (id) => id.origin,
    set_current_write_origin: () => null,
    reset_current_write_origin: () => null,
  };

  // --- upstream read tools -------------------------------------------------------
  function skillSummary(id, row, installedList) {
    const { record, revision } = usageRow(id, row.name);
    const files = skillFiles(row);
    return {
      skillId: row.id, name: row.name, path: displayPath(row),
      ...(row.category ? { category: row.category } : {}),
      description: U.descriptionOf(files['SKILL.md']) ?? null,
      source: 'managed', provenance: 'agent',
      state: record?.state ?? U.STATE_ACTIVE,
      pinned: record?.pinned === true, locked: record?.locked === true,
      created_by: record?.created_by ?? null,
      use_count: record?.use_count ?? 0, view_count: record?.view_count ?? 0,
      revision: row.revision, stateRevision: revision,
      installationId: row.installation_id ?? undefined,
      updatedAt: row.updated_at, createdAt: row.created_at,
    };
  }

  async function skillsList(id) {
    const installedList = await installedSkills(id);
    const skills = stmts.skillsFor.all(id.deviceId, id.botId)
      .map((row) => skillSummary(id, row, installedList));
    const live = skills.filter((skill) => skill.state !== U.STATE_ARCHIVED);
    const installed = [];
    for (const entry of installedList) {
      for (const skill of entry.skills) {
        const { record } = usageRow(id, skill.name);
        installed.push({
          name: skill.name, path: skill.dir, description: skill.description ?? null,
          source: 'installed', provenance: 'installed',
          state: record?.state ?? U.STATE_ACTIVE,
          pinned: record?.pinned === true, locked: record?.locked === true,
          use_count: record?.use_count ?? 0, view_count: record?.view_count ?? 0,
          installationId: entry.installation.installationId,
          packageId: entry.installation.packageId, version: entry.installation.targetVersion,
          enabled: entry.binding.enabled === true,
          activated: store.isActive(entry.installation),
        });
      }
    }
    const archived = skills.filter((skill) => skill.state === U.STATE_ARCHIVED).map((skill) => skill.name);
    return { success: true, skills: live, installed, archived, count: live.length + installed.length };
  }

  function viewManaged(id, row, filePath) {
    const files = skillFiles(row);
    const { record } = usageRow(id, row.name);
    if (filePath) {
      const checked = checkPathOr(filePath);
      if (checked.error) return U.refusal(checked.error);
      if (!(checked.path in files)) {
        return U.refusal(`File '${checked.path}' not found in skill '${row.name}'.`, { available_files: Object.keys(files) });
      }
      markRead(id, row.name, checked.path);
      return {
        success: true, name: row.name, path: displayPath(row), file_path: checked.path,
        content: files[checked.path], source: 'managed', revision: row.revision,
        description: U.descriptionOf(files['SKILL.md']) ?? null,
      };
    }
    if (!('SKILL.md' in files)) {
      return U.refusal(`Skill '${row.name}' has no SKILL.md.`, { available_files: Object.keys(files) });
    }
    markRead(id, row.name, 'SKILL.md');
    return {
      success: true, name: row.name, path: displayPath(row), content: files['SKILL.md'],
      files: Object.keys(files).sort(), source: 'managed', revision: row.revision,
      description: U.descriptionOf(files['SKILL.md']) ?? null,
      state: record?.state ?? U.STATE_ACTIVE, pinned: record?.pinned === true, locked: record?.locked === true,
    };
  }

  async function skillView(id, args) {
    const name = typeof args.name === 'string' ? args.name : '';
    if (!name) return U.refusal('name is required.');
    const managed = resolveManagedLive(id, name);
    if (managed) {
      const result = viewManaged(id, managed, args.file_path);
      if (result.success) {
        bumpView(id, managed.name);
        if (result.state === U.STATE_STALE) result.state = U.STATE_ACTIVE;
      }
      return result;
    }
    const installedList = await installedSkills(id);
    const installed = resolveInstalled(installedList, name);
    if (!installed) return notFound(name);
    let content;
    try {
      content = await installedPackageContent(installed.entry.artifactRef);
    } catch (err) {
      return U.refusal(`Installed skill package could not be read (${err.code ?? 'error'}).`);
    }
    const files = content.find((skill) => skill.dir === installed.skill.dir) ?? installed.skill;
    const fileMap = files.files instanceof Map ? files.files : new Map(Object.entries(files.files ?? {}));
    if (args.file_path) {
      const checked = checkPathOr(args.file_path);
      if (checked.error) return U.refusal(checked.error);
      if (!fileMap.has(checked.path)) {
        return U.refusal(`File '${checked.path}' not found in skill '${name}'.`, { available_files: [...fileMap.keys()] });
      }
      bumpView(id, installed.skill.name);
      return {
        success: true, name, path: installed.skill.dir, file_path: checked.path,
        content: fileMap.get(checked.path), source: 'installed',
        installationId: installed.entry.installation.installationId,
        description: installed.skill.description ?? null,
      };
    }
    if (!fileMap.has('SKILL.md')) return U.refusal(`Skill '${name}' has no SKILL.md.`, { available_files: [...fileMap.keys()] });
    bumpView(id, installed.skill.name);
    return {
      success: true, name, path: installed.skill.dir, content: fileMap.get('SKILL.md'),
      files: [...fileMap.keys()].sort(), source: 'installed',
      installationId: installed.entry.installation.installationId,
      description: installed.skill.description ?? null,
    };
  }

  /** read_file adapted to the Bot's skill library; registers the read like upstream file_tools. */
  async function readFileTool(id, args) {
    let input = typeof args.path === 'string' ? args.path.trim() : '';
    if (!input) return U.refusal('path is required.');
    if (input.startsWith('/')) return U.refusal('Absolute paths are outside the skill library. Use a skill-relative path.');
    input = input.replace(/\\/g, '/').replace(/^\.\//, '');
    if (input.startsWith('skills/')) input = input.slice('skills/'.length);
    const parts = input.split('/').filter(Boolean);
    const installedList = await installedSkills(id);
    // Longest resolving skill prefix wins; the remainder is the file path inside it.
    for (let i = parts.length; i >= 1; i--) {
      const skillRef = parts.slice(0, i).join('/');
      const filePath = parts.slice(i).join('/') || null;
      const managed = resolveManagedLive(id, skillRef);
      if (managed) {
        const view = viewManaged(id, managed, filePath ?? 'SKILL.md');
        if (!view.success) return view;
        bumpView(id, managed.name);
        return sliceLines(view, args);
      }
      const installed = resolveInstalled(installedList, skillRef);
      if (installed) {
        const view = await skillView(id, { name: skillRef, file_path: filePath ?? undefined });
        if (!view.success) return view;
        return sliceLines(view, args);
      }
    }
    return U.refusal(`No skill file matches '${args.path}'. Paths look like '<skill>/SKILL.md' or '<skill>/references/x.md'.`);
  }

  function sliceLines(view, args) {
    const offset = Number.isSafeInteger(args.offset) && args.offset > 0 ? args.offset : 0;
    const limit = Number.isSafeInteger(args.limit) && args.limit > 0 ? args.limit : null;
    const lines = String(view.content).split('\n');
    const sliced = limit === null ? lines.slice(offset) : lines.slice(offset, offset + limit);
    return { ...view, content: sliced.join('\n'), lines: { offset, returned: sliced.length, total: lines.length } };
  }

  async function searchFilesTool(id, args) {
    const query = typeof args.query === 'string' ? args.query : (typeof args.pattern === 'string' ? args.pattern : '');
    if (!query) return U.refusal('query is required.');
    const sensitive = args.case_sensitive === true;
    const needle = sensitive ? query : query.toLowerCase();
    const max = Math.min(Number.isSafeInteger(args.max_results) && args.max_results > 0 ? args.max_results : 50, 200);
    const scope = typeof args.path === 'string' && args.path.trim() ? args.path.trim().replace(/\\/g, '/').replace(/^skills\//, '') : null;
    const matches = [];
    const scan = (skillName, displayDir, fileMap) => {
      for (const [rel, content] of fileMap) {
        if (scope && !skillName.startsWith(scope) && !displayDir.startsWith(scope) && !rel.startsWith(scope) && !(displayDir + '/' + rel).startsWith(scope)) continue;
        const lines = String(content).split('\n');
        for (let i = 0; i < lines.length && matches.length < max; i++) {
          const hay = sensitive ? lines[i] : lines[i].toLowerCase();
          if (hay.includes(needle)) {
            matches.push({ skill: skillName, path: rel, line: i + 1, preview: U.clip(lines[i].trim(), 160, '…') });
          }
        }
        if (matches.length >= max) return;
      }
    };
    for (const row of stmts.skillsFor.all(id.deviceId, id.botId)) {
      if (usageRow(id, row.name).record?.state === U.STATE_ARCHIVED) continue;
      scan(row.name, displayPath(row), new Map(Object.entries(skillFiles(row))));
      if (matches.length >= max) break;
    }
    if (matches.length < max) {
      for (const entry of await installedSkills(id)) {
        const content = await installedPackageContent(entry.artifactRef).catch(() => null);
        if (!content) continue;
        for (const skill of content) {
          scan(skill.name, skill.dir, skill.files);
          if (matches.length >= max) break;
        }
        if (matches.length >= max) break;
      }
    }
    return { success: true, query, matches, count: matches.length, truncated: matches.length >= max };
  }

  // --- skill_manage (flat + atomic operations batch) -----------------------------
  async function skillManage(id, args) {
    const batch = args.operations !== undefined && args.operations !== null;
    if (batch && !Array.isArray(args.operations)) return json(U.refusal('operations must be an array of skill ops.'));
    return enqueue(id, async () => {
      // Job identity separates deterministic callback ids reused by later jobs.
      const requestId = id.requestId && 'learning:' + sha256(json([id.deviceId, id.botId, id.sessionId, id.requestId]));
      const request = { action: 'learning.skill_manage', requestId, args };
      const replayed = replay(id, request, request.action);
      if (replayed.hit) return json(replayed.hit);
      const ops = batch ? args.operations : [args];
      const installedList = await installedSkills(id);
      const topCronRefs = normalizeCronRefs(args.cron_referenced_skills ?? args.cronReferencedSkills);
      const mergedCronRefs = topCronRefs || id.cronReferencedSkills
        ? [...new Set([...(id.cronReferencedSkills ?? []), ...(topCronRefs ?? [])])]
        : undefined;
      // The batch owns the request id even when several edits target one Skill.
      const draftIdentity = {
        ...id,
        requestId: null,
        ...(mergedCronRefs ? { cronReferencedSkills: mergedCronRefs } : {}),
      };
      let committedBatch;
      try {
        committedBatch = tx(() => {
          const results = [];
          const touchedSkillIds = [];
          const archivedSkillNames = [];
          const disabledInstallationIds = [];
          let singleOutcome;
          for (const op of ops) {
            if (!op || typeof op !== 'object' || Array.isArray(op)) {
              throw { refusal: 'Each operation must be an object with name+action.', results };
            }
            const applied = applyManageOp(draftIdentity, { ...op }, installedList, { deferBindingDisable: true });
            const outcome = applied.result ?? applied;
            singleOutcome = outcome;
            results.push({ action: op.action, name: op.name, ...(op.file_path ? { file_path: op.file_path } : {}), ...pickResult(outcome) });
            if (!outcome.success) throw { refusal: outcome.error ?? 'operation failed', results, outcome };
            const refusal = persistManageResult(draftIdentity, applied);
            if (refusal) throw { refusal: refusal.error, results, outcome: refusal };
            const touchedId = applied.skillId ?? applied.row?.id ?? null;
            if (touchedId && !touchedSkillIds.includes(touchedId)) touchedSkillIds.push(touchedId);
            if (applied.archivedSkillName && !archivedSkillNames.includes(applied.archivedSkillName)) {
              archivedSkillNames.push(applied.archivedSkillName);
            }
            if (applied.disabledInstallationId && !disabledInstallationIds.includes(applied.disabledInstallationId)) {
              disabledInstallationIds.push(applied.disabledInstallationId);
            }
          }
          const response = batch
            ? { success: true, results, operations_applied: ops.length }
            : singleOutcome;
          return { response, touchedSkillIds, archivedSkillNames, disabledInstallationIds };
        });
      } catch (err) {
        if (!err?.refusal) throw err;
        return json(batch
          ? { success: false, error: err.refusal, results: err.results, operations_applied: 0, rolled_back: true }
          : (err.outcome ?? U.refusal(err.refusal)));
      }
      const { response, touchedSkillIds, archivedSkillNames, disabledInstallationIds } = committedBatch;
      for (const installationId of disabledInstallationIds) {
        setBindingEnabled(id, installationId, false);
      }
      if (archivedSkillNames.length > 0) {
        try { await packages.reconcileDevice(id.deviceId); } catch { /* best-effort reconcile */ } finally { notify(id.deviceId); }
      }
      const updatedSkills = [];
      let allPublished = true;
      for (const skillId of touchedSkillIds) {
        const currentRow = stmts.skillById.get(skillId);
        if (!currentRow || usageRow(id, currentRow.name).record?.state === U.STATE_ARCHIVED) continue;
        updatedSkills.push(currentRow.name);
        try {
          const pubResult = await syncSkillPackage(id, currentRow);
          const enrichedPub = pubResult?.publication ? withDeployment(id, pubResult) : pubResult;
          const pubStatus = enrichedPub?.publication?.status;
          const depStatus = enrichedPub?.deployment?.status;
          if (!['enabled', 'applied'].includes(pubStatus) || depStatus === 'failed') {
            allPublished = false;
          }
        } catch {
          // Skill files are already durably committed; transient package state reconciles on next write/startup.
          allPublished = false;
        }
      }
      if (ops.length) {
        Object.assign(response, {
          published: allPublished,
          ...(updatedSkills.length ? { updatedSkills } : {}),
          ...(archivedSkillNames.length ? { archivedSkills: archivedSkillNames } : {}),
        });
      }
      tx(() => recordRequest(id, replayed, response));
      return json(response);
    });
  }

  const pickResult = (outcome) => ({ success: outcome.success === true, ...(outcome.success ? {} : { error: outcome.error }), ...(outcome.message ? { message: outcome.message } : {}) });

  function deleteManagedNow(id, row) {
    stmts.deleteSkill.run(row.id);
    forget(id, row.name);
    clearMarks(id, row.name);
  }

  // --- execute(): management API --------------------------------------------------
  function requireSkill(id, input) {
    const ref = input.skillId ?? input.name;
    const row = ref ? getManaged(id, ref) ?? resolveManaged(id, ref) : null;
    if (!row) throw error('NOT_FOUND', `Skill '${ref ?? ''}' not found`);
    return row;
  }

  function summarizeSkill(id, row) {
    const { record, revision } = usageRow(id, row.name);
    const files = skillFiles(row);
    return {
      skillId: row.id, name: row.name, path: displayPath(row),
      ...(row.category ? { category: row.category } : {}),
      description: U.descriptionOf(files['SKILL.md']) ?? null,
      revision: row.revision, stateRevision: revision,
      state: record?.state ?? U.STATE_ACTIVE, pinned: record?.pinned === true, locked: record?.locked === true,
      createdBy: record?.created_by ?? null, source: row.source,
      installationId: row.installation_id ?? undefined,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  /** Request-id replay for mutating execute() calls; stored result wins, fingerprint mismatch conflicts. */
  function replay(id, input, action) {
    const requestId = input.requestId;
    if (!requestId || typeof requestId !== 'string') return { miss: true };
    const { requestId: _rid, ...meaning } = input;
    const fingerprint = sha256(json({ deviceId: id.deviceId, botId: id.botId, action, ...meaning }));
    const row = stmts.reqGet.get(requestId);
    if (!row) return { miss: true, fingerprint, requestId };
    if (row.fingerprint !== fingerprint || row.device_id !== id.deviceId || row.bot_id !== id.botId) {
      throw error('REQUEST_CONFLICT', 'Request id was already used for a different operation');
    }
    return { hit: JSON.parse(row.json) };
  }

  function recordRequest(id, replay_, result) {
    if (!replay_?.fingerprint) return;
    try {
      stmts.reqPut.run(replay_.requestId, id.deviceId, id.botId, replay_.fingerprint, json(result), now());
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err;
    }
  }

  function filesOf(row) { return skillFiles(row); }

  async function syncSkillPackage(id, row) {
    const latest = stmts.skillById.get(row.id) ?? row;
    if (usageRow(id, latest.name).record?.state === U.STATE_ARCHIVED) {
      return { ...summarizeSkill(id, latest), publication: { status: 'archived' } };
    }
    const files = skillFiles(latest);
    if (typeof files['SKILL.md'] !== 'string') {
      throw error('VALIDATION_FAILED', 'A managed skill must keep a SKILL.md');
    }
    const packageId = latest.package_id || `bot-skill-${latest.id}`;
    const version = '0.0.0-h' + sha256(json(files)).slice(0, 12);
    const description = U.descriptionOf(files['SKILL.md']) ?? latest.name;
    const ownerBot = { deviceId: id.deviceId, botId: id.botId, skillId: latest.id, skillName: latest.name };
    const bytes = await buildArtifact(packageId, version, files, description);
    const { artifactRef } = await packages.uploadArtifact([bytes]);

    let installationId = latest.installation_id && store.getInstallation(latest.installation_id) ? latest.installation_id : null;
    let operationId = null;

    if (!installationId) {
      const receipt = await packages.install({
        kind: 'skill',
        source: { type: 'artifact', artifactRef },
        target: 'host',
        displayName: 'Skill: ' + latest.name,
        requestId: randomUUID(),
        ownerBot,
        visibilityScope: 'private',
        autoEnable: true,
      });
      operationId = receipt.operationId;
      const installResult = await waitFor(() => {
        const op = store.getOperation(receipt.operationId);
        if (!op) return null;
        if (op.phase === 'failed') return { failed: true, op };
        const inst = op.installationId ? store.getInstallation(op.installationId) : null;
        if (!inst) return null;
        if (inst.enabled && inst.activation?.status === 'enabling') return null;
        return { failed: false, op, inst };
      }, PUBLISH_WAIT_MS);
      if (!installResult) {
        const op = store.getOperation(receipt.operationId);
        const status = op?.phase === 'failed' ? 'failed' : 'queued';
        return { ...summarizeSkill(id, latest), publication: { status, operationId, artifactRef, error: op?.error ?? undefined } };
      }
      if (installResult.failed) {
        return { ...summarizeSkill(id, latest), publication: { status: 'failed', operationId, artifactRef, error: installResult.op?.error ?? undefined } };
      }
      installationId = installResult.inst.installationId;
      tx(() => {
        stmts.updateSkillDeployment.run(installationId, installResult.inst.packageId || packageId, now(), latest.id);
      });
      if (!installResult.inst.enabled || installResult.inst.activation?.status !== 'enabled') {
        const enableReceipt = await packages.enable(installationId, { requestId: randomUUID() });
        operationId = enableReceipt.operationId;
      }
    } else {
      const installation = store.getInstallation(installationId);
      if (installation && !installation.ownerBot) {
        store.setInstallationOwnership?.(installationId, ownerBot, installation.visibilityScope ?? 'private');
      }
      if (installation.source?.artifactRef !== artifactRef) {
        const updateReceipt = await packages.update(installationId, {
          requestId: randomUUID(),
          source: { type: 'artifact', artifactRef },
          allowSourceSwitch: true,
        });
        operationId = updateReceipt.operationId;
        const updateResult = await waitFor(() => {
          const op = store.getOperation(operationId);
          if (op?.phase === 'failed') return { failed: true, op };
          const current = store.getInstallation(installationId);
          if (!current || current.source?.artifactRef !== artifactRef) return null;
          if (current.enabled && current.activation?.status === 'enabling') return null;
          return { failed: false, op, inst: current };
        }, PUBLISH_WAIT_MS);
        if (!updateResult) {
          const op = store.getOperation(operationId);
          return {
            ...summarizeSkill(id, stmts.skillById.get(latest.id)),
            publication: { status: op?.phase === 'failed' ? 'failed' : 'activating', operationId, installationId, packageId: installation.packageId, artifactRef, error: op?.error ?? undefined },
          };
        }
        if (updateResult.failed) {
          return {
            ...summarizeSkill(id, stmts.skillById.get(latest.id)),
            publication: { status: 'failed', operationId, installationId, packageId: installation.packageId, artifactRef, error: updateResult.op?.error ?? undefined },
          };
        }
      }
      const currentInst = store.getInstallation(installationId);
      if (!currentInst.enabled || currentInst.activation?.status !== 'enabled') {
        const enableReceipt = await packages.enable(installationId, { requestId: randomUUID() });
        operationId = enableReceipt.operationId;
      }
    }

    const ready = await waitFor(() => {
      const op = operationId ? store.getOperation(operationId) : null;
      if (op?.phase === 'failed') return { failed: true, op };
      const current = store.getInstallation(installationId);
      if (!current) return null;
      if (current.activation?.status === 'failed') return { failed: true, op, inst: current };
      return current.source?.artifactRef === artifactRef && current.activation?.status === 'enabled'
        ? { failed: false, inst: current }
        : null;
    }, PUBLISH_WAIT_MS);
    if (!ready || ready.failed) {
      const op = operationId && store.getOperation(operationId);
      const status = ready?.failed || op?.phase === 'failed' ? 'failed' : 'activating';
      return {
        ...summarizeSkill(id, stmts.skillById.get(latest.id)),
        publication: { status, operationId, installationId, packageId, artifactRef, error: op?.error ?? ready?.inst?.activation?.error ?? undefined },
      };
    }

    const readyInst = ready.inst;
    if (!readyInst.ownerBot) {
      store.setInstallationOwnership?.(installationId, ownerBot, readyInst.visibilityScope ?? 'private');
    }
    tx(() => {
      const current = stmts.skillById.get(latest.id);
      if (current && (current.installation_id !== installationId || current.package_id !== (readyInst.packageId || packageId))) {
        stmts.updateSkillDeployment.run(installationId, readyInst.packageId || packageId, now(), latest.id);
      }
    });

    const capability = store.getBotCapability(id.deviceId, id.botId, installationId);
    if (!capability.enabled) {
      store.putBotCapability(id.deviceId, id.botId, installationId, {
        enabled: true,
        overrides: capability.overrides ?? {},
        expectedRevision: capability.revision,
      });
    }

    const affectedDevices = new Set([
      id.deviceId,
      ...store.listBotBindings({ installationId }).map((binding) => binding.deviceId),
    ]);
    for (const deviceId of affectedDevices) {
      try { await packages.reconcileDevice(deviceId); } finally { notify(deviceId); }
    }

    const finalRow = stmts.skillById.get(latest.id);
    return {
      ...summarizeSkill(id, finalRow),
      publication: {
        status: 'enabled',
        operationId,
        installationId,
        packageId: readyInst.packageId,
        version: readyInst.targetVersion,
        artifactRef,
      },
    };
  }

  const actions = {
    async list(id) {
      const installedList = await installedSkills(id);
      return {
        skills: stmts.skillsFor.all(id.deviceId, id.botId).map((row) => summarizeSkill(id, row)),
        installed: installedList.flatMap((entry) => entry.skills.map((skill) => ({
          name: skill.name, path: skill.dir, description: skill.description ?? null,
          source: 'installed', installationId: entry.installation.installationId,
          packageId: entry.installation.packageId, version: entry.installation.targetVersion,
          enabled: entry.binding.enabled === true, activated: store.isActive(entry.installation),
          files: skill.files,
        }))),
      };
    },

    async read(id, input) {
      const filePath = input.path !== undefined ? input.path : null;
      const installedList = await installedSkills(id);
      if (input.installationId && !input.skillId && !input.name) {
        const entry = installedList.find((item) => item.installation.installationId === input.installationId);
        if (!entry) throw error('NOT_FOUND', 'Installed skill not found for this Bot');
        if (!entry.artifactRef) throw error('NOT_FOUND', 'Installed skill package is not available');
        const content = await installedPackageContent(entry.artifactRef);
        const skill = content.length === 1 ? content[0] : content.find((item) => item.name === input.skillName || item.dir === input.skillName);
        if (!skill) throw error('NOT_FOUND', 'Installed package contains no matching skill');
        return installedRead(entry, skill, filePath);
      }
      const managed = resolveManaged(id, input.name ?? input.skillId);
      if (managed) {
        const summary = summarizeSkill(id, managed);
        const files = filesOf(managed);
        if (filePath !== null) {
          const checked = U.checkFilePath(filePath);
          if (checked.error) throw error('INVALID_ARGUMENT', checked.error);
          if (!(checked.path in files)) throw error('NOT_FOUND', `File '${checked.path}' not found`);
          return { ...summary, path: checked.path, content: files[checked.path] };
        }
        return { ...summary, files };
      }
      const installed = resolveInstalled(installedList, input.name ?? input.skillId);
      if (!installed) throw error('NOT_FOUND', `Skill '${input.name ?? input.skillId}' not found`);
      if (!installed.entry.artifactRef) throw error('NOT_FOUND', 'Installed skill package is not available');
      const content = await installedPackageContent(installed.entry.artifactRef);
      const skill = content.find((item) => item.dir === installed.skill.dir) ?? installed.skill;
      return installedRead(installed.entry, skill, filePath);
    },

    async create(id, input) {
      const name = input.name;
      const nameErr = U.validateName(name);
      if (nameErr) throw error('INVALID_ARGUMENT', nameErr);
      const catErr = U.validateCategory(input.category ?? null);
      if (catErr) throw error('INVALID_ARGUMENT', catErr);
      if (managedRow(id, name)) throw error('REVISION_CONFLICT', `Skill '${name}' already exists`);
      let files;
      if (input.files !== undefined) {
        files = normalizeFilesMap(input.files);
        for (const [key, value] of Object.entries(files)) if (value === null) delete files[key];
      } else {
        files = normalizeFilesMap({ 'SKILL.md': String(input.content ?? '') });
      }
      if (typeof files['SKILL.md'] !== 'string') throw error('VALIDATION_FAILED', 'files must include SKILL.md');
      const fmErr = validateSkillMd(files['SKILL.md']);
      if (fmErr) throw error('VALIDATION_FAILED', fmErr);
      if (input.description !== undefined) files['SKILL.md'] = rewriteDescription(files['SKILL.md'], input.description);
      const rowId = randomUUID();
      const fmName = fmNameOf(files['SKILL.md']);
      const createdAt = now();
      tx(() => {
        stmts.insertSkill.run(rowId, id.deviceId, id.botId, name, fmName, input.category?.trim() || null,
          1, 0, null, null, null, json(files), null, 'managed', '{}', createdAt, createdAt);
        usageMutate(id, name, (rec) => U.recordCreatedApply(rec, AUTONOMOUS_ORIGINS.has(id.origin)));
      });
      const synced = await syncSkillPackage(id, stmts.skillById.get(rowId));
      return { ...synced, files };
    },

    async update(id, input) {
      const row = requireSkill(id, input);
      const hasFiles = input.files !== undefined;
      const hasPath = input.path !== undefined;
      const hasDesc = input.description !== undefined;
      if (!hasFiles && !hasPath && !hasDesc) throw error('INVALID_ARGUMENT', 'update requires files, path+content, or description');
      const files = filesOf(row);
      if (hasFiles) {
        const next = normalizeFilesMap(input.files);
        for (const [key, value] of Object.entries(next)) {
          if (value === null) delete files[key]; else files[key] = value;
        }
      }
      if (hasPath) {
        const checked = U.checkStoragePath(input.path);
        if (checked.error) throw error('INVALID_ARGUMENT', checked.error);
        if (input.content === undefined) {
          throw error('INVALID_ARGUMENT', "update with path requires content (string to write, null to remove)");
        }
        if (input.content === null) {
          if (checked.path === 'SKILL.md') throw error('INVALID_ARGUMENT', 'SKILL.md cannot be removed from a managed skill');
          if (!(checked.path in files)) throw error('NOT_FOUND', `File '${checked.path}' not found`);
          delete files[checked.path];
        } else {
          if (typeof input.content !== 'string') throw error('INVALID_ARGUMENT', 'content must be UTF-8 text');
          if (Buffer.byteLength(input.content, 'utf8') > U.MAX_SKILL_FILE_BYTES) throw error('PAYLOAD_TOO_LARGE', 'File exceeds the size limit');
          files[checked.path] = input.content;
        }
      }
      if (hasDesc) files['SKILL.md'] = rewriteDescription(files['SKILL.md'], input.description);
      const validatedFiles = normalizeFilesMap(files);
      if (typeof validatedFiles['SKILL.md'] !== 'string') throw error('VALIDATION_FAILED', 'A managed skill must keep a SKILL.md');
      const fmErr = validateSkillMd(validatedFiles['SKILL.md']);
      if (fmErr) throw error('VALIDATION_FAILED', fmErr);
      tx(() => {
        commitSkillFiles(row, validatedFiles);
        usageMutate(id, row.name, (rec) => U.bumpPatchApply(rec));
      });
      const updated = stmts.skillById.get(row.id);
      if (usageRow(id, updated.name).record?.state !== U.STATE_ARCHIVED) {
        const synced = await syncSkillPackage(id, updated);
        return { ...synced, files: validatedFiles };
      }
      return { ...summarizeSkill(id, updated), files: validatedFiles };
    },

    async patch(id, input) {
      const row = requireSkill(id, input);
      const rawPath = input.path ?? input.file_path ?? 'SKILL.md';
      const checked = U.checkStoragePath(rawPath);
      if (checked.error) throw error('INVALID_ARGUMENT', checked.error);
      const target = checked.path;
      const files = filesOf(row);
      if (!(target in files)) throw error('NOT_FOUND', `File '${target}' not found`);
      const oldText = input.oldText ?? input.old_string;
      const newText = input.newText ?? input.new_string;
      if (typeof oldText !== 'string' || !oldText) throw error('INVALID_ARGUMENT', 'oldText is required');
      if (typeof newText !== 'string') throw error('INVALID_ARGUMENT', 'newText must be a string');
      const replaceAll = Boolean(input.replaceAll ?? input.replace_all);
      const matched = U.findAndReplace(files[target], oldText, newText, replaceAll);
      if (matched.error) throw error('INVALID_ARGUMENT', matched.error);
      const nextFiles = normalizeFilesMap({ ...files, [target]: matched.newContent });
      if (typeof nextFiles['SKILL.md'] !== 'string') throw error('VALIDATION_FAILED', 'A managed skill must keep a SKILL.md');
      const fmErr = validateSkillMd(nextFiles['SKILL.md']);
      if (fmErr) throw error('VALIDATION_FAILED', fmErr);
      tx(() => {
        commitSkillFiles(row, nextFiles);
        usageMutate(id, row.name, (rec) => U.bumpPatchApply(rec));
      });
      const updated = stmts.skillById.get(row.id);
      if (usageRow(id, updated.name).record?.state !== U.STATE_ARCHIVED) {
        const synced = await syncSkillPackage(id, updated);
        return { ...synced, files: nextFiles, replaced: matched.count };
      }
      return { ...summarizeSkill(id, updated), files: nextFiles, replaced: matched.count };
    },

    async delete(id, input) {
      const row = requireSkill(id, input);
      let operationId;
      if (row.installation_id && store.getInstallation(row.installation_id)) {
        const receipt = await packages.uninstall(row.installation_id, { requestId: (input.requestId ?? randomUUID()) + ':uninstall' });
        operationId = receipt.operationId;
      }
      tx(() => deleteManagedNow(id, row));
      try { await packages.reconcileDevice(id.deviceId); } finally { notify(id.deviceId); }
      return { deleted: true, skillId: row.id, name: row.name, ...(row.installation_id ? { installationId: row.installation_id, operationId, phase: 'queued' } : {}) };
    },

    async archive(id, input, installedList) {
      const row = requireSkill(id, input);
      const usage = usageRow(id, row.name);
      if (usage.record?.state === U.STATE_ARCHIVED) return { ...summarizeSkill(id, row), state: U.STATE_ARCHIVED };
      if (isSharedSkill(row)) {
        throw error('INVALID_STATE', 'shared or global skill cannot be archived; switch visibility back to private first');
      }
      const [ok, msg] = archiveSkillNow(id, row.name, installedList);
      if (!ok) throw error('INVALID_STATE', msg);
      try { await packages.reconcileDevice(id.deviceId); } finally { notify(id.deviceId); }
      return { ...summarizeSkill(id, stmts.skillById.get(row.id)), state: U.STATE_ARCHIVED, archived: msg };
    },

    async restore(id, input, installedList) {
      const row = requireSkill(id, input);
      const [ok, msg] = restoreSkillNow(id, row.name, installedList);
      if (!ok) throw error('INVALID_STATE', msg);
      const synced = await syncSkillPackage(id, stmts.skillById.get(row.id));
      return { ...synced, restored: msg };
    },

    pin(id, input, installedList) {
      const row = requireSkill(id, input);
      if (typeof input.pinned !== 'boolean') throw error('INVALID_ARGUMENT', 'pinned must be boolean');
      usageMutate(id, row.name, (rec) => { rec.pinned = input.pinned; return true; }, { eligibleOnly: true, installedList });
      return { ...summarizeSkill(id, row), pinned: input.pinned };
    },

    lock(id, input, installedList) {
      if (typeof input.locked !== 'boolean') throw error('INVALID_ARGUMENT', 'locked must be boolean');
      const name = input.name ?? input.skillId;
      const managed = name ? resolveManaged(id, name) : null;
      const target = managed ? managed.name : name;
      if (!target) throw error('INVALID_ARGUMENT', 'name or skillId is required');
      if (!managed) {
        const installed = name ? resolveInstalled(installedList, name) : null;
        if (!installed) throw error('NOT_FOUND', `Skill '${name}' not found`);
      }
      usageMutate(id, target, (rec) => { rec.locked = input.locked; return true; });
      const base = managed ? summarizeSkill(id, managed) : { name: target };
      return { ...base, locked: input.locked, stateRevision: usageRow(id, target).revision };
    },

    async adopt(id, input, installedList) {
      let installed = null;
      if (input.installationId) {
        const entry = installedList.find((item) => item.installation.installationId === input.installationId);
        if (!entry) throw error('NOT_FOUND', 'Installed skill not found for this Bot');
        if (!entry.artifactRef) throw error('NOT_FOUND', 'Installed skill package is not available');
        const skills = entry.skills;
        const picked = input.name ? skills.find((skill) => skill.name === input.name || skill.dir === input.name) : skills[0];
        if (!picked) throw error('NOT_FOUND', 'Skill not found in that package');
        installed = { entry, skill: picked };
      } else if (input.name) {
        installed = resolveInstalled(installedList, input.name);
        if (!installed) throw error('NOT_FOUND', `Installed skill '${input.name}' not found`);
      } else {
        throw error('INVALID_ARGUMENT', 'adopt requires name or installationId');
      }
      const newName = input.newName ?? input.skillName ?? installed.skill.name;
      const nameErr = U.validateName(newName);
      if (nameErr) throw error('INVALID_ARGUMENT', nameErr);
      if (managedRow(id, newName)) throw error('REVISION_CONFLICT', `Skill '${newName}' already exists`);
      if (!installed.entry.artifactRef) throw error('NOT_FOUND', 'Installed skill package is not available');
      const content = await installedPackageContent(installed.entry.artifactRef);
      const full = content.find((item) => item.dir === installed.skill.dir) ?? installed.skill;
      const files = Object.fromEntries(full.files instanceof Map ? full.files : Object.entries(full.files ?? {}));
      for (const file of Object.keys(files)) if (file.toLowerCase() === 'package.json') delete files[file];
      if (typeof files['SKILL.md'] !== 'string') throw error('VALIDATION_FAILED', 'Installed skill has no SKILL.md to adopt');
      const adoptedErr = U.validateFrontmatter(files['SKILL.md']);
      if (adoptedErr) throw error('VALIDATION_FAILED', `Installed skill cannot be adopted: ${adoptedErr}`);
      if (fmNameOf(files['SKILL.md']) !== newName) {
        const parts = U.splitFrontmatter(files['SKILL.md']);
        const document = U.yaml().parseDocument(parts.yamlText);
        document.set('name', newName);
        files['SKILL.md'] = '---\n' + document.toString().replace(/\n*$/, '\n') + '---\n' + parts.body;
        const rewrittenErr = U.validateFrontmatter(files['SKILL.md']);
        if (rewrittenErr) throw error('VALIDATION_FAILED', `Adopted skill name is invalid: ${rewrittenErr}`);
      }
      const rowId = randomUUID();
      const fmName = fmNameOf(files['SKILL.md']);
      const createdAt = now();
      const metaJson = json({ from: { installationId: installed.entry.installation.installationId, packageId: installed.entry.installation.packageId, version: installed.entry.installation.targetVersion, dir: installed.skill.dir } });
      tx(() => {
        stmts.insertSkill.run(rowId, id.deviceId, id.botId, newName, fmName, null,
          1, 0, null, null, null, json(files), null, 'adopted', metaJson, createdAt, createdAt);
        usageMutate(id, newName, (rec) => { rec.created_by = 'agent'; return true; });
      });
      const createdRow = stmts.skillById.get(rowId);
      const synced = usageRow(id, newName).record?.state !== U.STATE_ARCHIVED
        ? await syncSkillPackage(id, createdRow)
        : summarizeSkill(id, createdRow);
      return {
        ...synced, files,
        from: { installationId: installed.entry.installation.installationId, packageId: installed.entry.installation.packageId, version: installed.entry.installation.targetVersion, name: installed.skill.name },
      };
    },
  };

  function installedRead(entry, skill, filePath) {
    const fileMap = skill.files instanceof Map ? skill.files : new Map(Object.entries(skill.files ?? {}));
    const base = {
      name: skill.name, source: 'installed', path: skill.dir,
      description: skill.description ?? null,
      installationId: entry.installation.installationId,
      packageId: entry.installation.packageId, version: entry.installation.targetVersion,
      enabled: entry.binding.enabled === true, activated: store.isActive(entry.installation),
    };
    if (filePath !== null && filePath !== undefined) {
      const checked = U.checkFilePath(filePath);
      if (checked.error) throw error('INVALID_ARGUMENT', checked.error);
      if (!fileMap.has(checked.path)) throw error('NOT_FOUND', `File '${checked.path}' not found`);
      return { ...base, path: checked.path, content: fileMap.get(checked.path) };
    }
    return { ...base, files: Object.fromEntries(fileMap) };
  }

  /** Rewrite the frontmatter description scalar; block/complex values are refused (edit content instead). */
  function rewriteDescription(content, description) {
    if (typeof description !== 'string' || !description.trim()) throw error('INVALID_ARGUMENT', 'description must be a non-empty string');
    if (description.length > U.MAX_DESCRIPTION_LENGTH) throw error('INVALID_ARGUMENT', `Description exceeds ${U.MAX_DESCRIPTION_LENGTH} characters`);
    const parts = U.splitFrontmatter(content);
    if (!parts) throw error('VALIDATION_FAILED', 'SKILL.md has no frontmatter to update');
    const lines = parts.yamlText.split('\n');
    const index = lines.findIndex((line) => /^description\s*:/.test(line));
    const rendered = 'description: ' + renderScalar(description);
    let yamlText;
    if (index === -1) {
      yamlText = lines.concat([rendered]).join('\n');
    } else {
      const value = lines[index].replace(/^description\s*:\s*/, '');
      if (value === '' || /^[>|]/.test(value)) {
        throw error('INVALID_ARGUMENT', 'frontmatter description is a block value; update it via files or content instead');
      }
      lines[index] = rendered;
      yamlText = lines.join('\n');
    }
    const next = '---' + yamlText + '\n---\n' + parts.body;
    const fmErr = U.validateFrontmatter(next);
    if (fmErr) throw error('VALIDATION_FAILED', fmErr);
    return next;
  }

  function renderScalar(value) {
    if (/^[A-Za-z0-9][^#\n{}\[\],&*?!|>'\"%@`]*$/.test(value) && !value.endsWith(' ') && !/:\s/.test(value)) {
      return value;
    }
    return JSON.stringify(value);
  }

  function clearMarks(id, name) {
    for (const marks of readMarks.values()) marks.delete(name);
  }

  /** Build the publishable tar artifact: npm-shaped package/ root with package.json + skill files. */
  async function buildArtifact(packageName, version, files, description) {
    const stage = path.join(root, 'stage-' + randomUUID());
    try {
      await mkdir(stage, { recursive: true });
      const names = [];
      const manifest = { name: packageName, version, private: true, description, pi: { skills: ['.'] } };
      await writeFile(path.join(stage, 'package.json'), json(manifest));
      names.push('package.json');
      for (const [rel, content] of Object.entries(files)) {
        if (rel.toLowerCase() === 'package.json' || content === null || content === undefined) continue;
        const target = path.join(stage, ...rel.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
        names.push(rel);
      }
      const stream = tar.create({ gzip: true, cwd: stage, prefix: 'package', portable: true }, names);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (bytes.length > 100 * 1024 * 1024) throw error('PAYLOAD_TOO_LARGE', 'Artifact exceeds size limit');
      return bytes;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  // --- public execute() -----------------------------------------------------------
  async function execute(identity, input) {
    const id = normalizeIdentity(identity);
    assertBot(id);
    const action = input?.action;
    if (typeof action !== 'string' || typeof actions[action] !== 'function') {
      throw error('INVALID_ARGUMENT', `Unknown action '${action}'. Use: ${Object.keys(actions).join(', ')}`);
    }
    const readOnly = ['list', 'read'].includes(action);
    if (readOnly) return actions[action](id, input ?? {});
    return enqueue(id, async () => {
      const replayed = replay(id, input, action);
      if (replayed.hit) return replayed.hit;
      const installedList = await installedSkills(id);
      const result = await actions[action](id, input, installedList);
      // A sync that is still queued/activating/failed must NOT pin the request id:
      // an explicit retry resumes instead of replaying a stale receipt.
      const pending = result?.publication && !['enabled', 'applied'].includes(result.publication.status);
      if (!pending) recordRequest(id, replayed, result);
      return result;
    });
  }

  function reviewSkill(id, skillId) {
    const row = stmts.skillById.get(skillId);
    if (!row || row.device_id !== id.deviceId || row.bot_id !== id.botId) {
      throw error('NOT_FOUND', 'Skill not found for this Bot');
    }
    return row;
  }

  function withDeployment(id, result) {
    const { publication } = result;
    if (publication.status !== 'enabled') return result;
    const plan = store.listDeploymentPlans(id.deviceId).find(item => item.installationId === publication.installationId);
    if (!plan) return { ...result, deployment: { status: 'pending' } };
    if (plan.targetVersion !== publication.version || ['disable', 'uninstall'].includes(plan.action)) {
      return { ...result, deployment: { status: 'superseded' } };
    }
    const receipt = store.listDeploymentReceipts(publication.installationId).find(item => item.deviceId === id.deviceId);
    return { ...result, deployment: receipt ? { status: receipt.phase, error: receipt.error } : { status: 'queued' } };
  }

  function deploymentSummaryForRow(id, row) {
    if (!row.installation_id) return { status: 'not-published' };
    const installation = store.getInstallation(row.installation_id);
    if (!installation) return { status: 'not-published' };
    const binding = store.getBotCapability(id.deviceId, id.botId, row.installation_id);
    if (!store.isActive(installation) || !binding.enabled) return { status: 'disabled' };
    const plan = store.listDeploymentPlans(id.deviceId).find((item) => item.installationId === row.installation_id);
    if (!plan) return { status: 'pending' };
    if (plan.targetVersion !== installation.targetVersion || ['disable', 'uninstall'].includes(plan.action)) {
      return { status: 'superseded' };
    }
    const receipt = store.listDeploymentReceipts(row.installation_id).find((item) => item.deviceId === id.deviceId);
    return receipt ? { status: receipt.phase, error: receipt.error } : { status: 'queued' };
  }

  function learnedSkillSummary(id, row) {
    const base = summarizeSkill(id, row);
    const { record } = usageRow(id, row.name);
    const installation = row.installation_id ? store.getInstallation(row.installation_id) : null;
    const source = row.learning_source ? JSON.parse(row.learning_source) : null;
    return {
      ...base,
      visibilityScope: installation?.visibilityScope ?? 'private',
      useCount: record?.use_count ?? 0,
      viewCount: record?.view_count ?? 0,
      patchCount: record?.patch_count ?? 0,
      lastActivityAt: U.latestActivityAt(record) ?? row.updated_at,
      source,
      deployment: deploymentSummaryForRow(id, row),
    };
  }

  /** Dedicated client-facing skill management & learned-skills routes dispatch here. Model tools use execute(). */
  async function review(identity, rawInput) {
    const id = normalizeIdentity(identity);
    assertBot(id);
    const normalizedRaw = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      && ['pin', 'lock', 'archive', 'restore'].includes(rawInput.action)
      && rawInput.expectedRevision === undefined
      ? { ...rawInput, expectedRevision: 0 }
      : rawInput;
    const input = normalizeSkillReviewInput(normalizedRaw);
    if (!['list', 'read', 'pin', 'lock', 'archive', 'restore'].includes(input.action)) {
      throw error('INVALID_ARGUMENT', 'Unsupported skill review action');
    }
    if (input.action === 'list') {
      const items = stmts.skillsFor.all(id.deviceId, id.botId)
        .map((row) => learnedSkillSummary(id, row))
        .filter((item) => input.includeArchived === false ? item.state !== U.STATE_ARCHIVED : true);
      return { items };
    }
    if (input.action === 'read') {
      const row = reviewSkill(id, input.skillId);
      const files = filesOf(row);
      let filePayload;
      if (input.path !== undefined) {
        if (!Object.hasOwn(files, input.path)) throw error('NOT_FOUND', 'File not found');
        filePayload = { path: input.path, content: files[input.path] };
        if (Buffer.byteLength(json(filePayload), 'utf8') > REVIEW_FILE_JSON_MAX_BYTES) {
          throw error('PAYLOAD_TOO_LARGE', 'File exceeds the preview limit');
        }
      }
      return {
        ...learnedSkillSummary(id, row),
        files,
        ...(filePayload === undefined ? {} : { file: filePayload }),
      };
    }
    return enqueue(id, async () => {
      const replayed = replay(id, input, 'skill_review:' + input.action);
      if (replayed.hit) return replayed.hit.publication ? withDeployment(id, replayed.hit) : replayed.hit;
      const installedList = await installedSkills(id);
      if (input.action === 'pin') {
        reviewSkill(id, input.skillId);
        actions.pin(id, input, installedList);
        const out = learnedSkillSummary(id, stmts.skillById.get(input.skillId));
        recordRequest(id, replayed, out);
        return out;
      }
      if (input.action === 'lock') {
        reviewSkill(id, input.skillId);
        actions.lock(id, input, installedList);
        const out = learnedSkillSummary(id, stmts.skillById.get(input.skillId));
        recordRequest(id, replayed, out);
        return out;
      }
      if (input.action === 'archive') {
        reviewSkill(id, input.skillId);
        await actions.archive(id, input, installedList);
        const out = learnedSkillSummary(id, stmts.skillById.get(input.skillId));
        recordRequest(id, replayed, out);
        return out;
      }
      if (input.action === 'restore') {
        reviewSkill(id, input.skillId);
        await actions.restore(id, input, installedList);
        const out = learnedSkillSummary(id, stmts.skillById.get(input.skillId));
        recordRequest(id, replayed, out);
        return out;
      }
      throw error('INVALID_ARGUMENT', 'Unsupported skill review action');
    });
  }

  async function readInstallationFiles(installationId) {
    const installation = store.getInstallation(installationId);
    if (!installation) throw error('NOT_FOUND', 'Installation not found');
    if (installation.kind !== 'skill') throw error('INVALID_ARGUMENT', 'Installation is not a skill');
    const row = stmts.skillByInstallationId.get(installationId);
    if (row) {
      const files = JSON.parse(row.files || '{}');
      return {
        installationId,
        editable: true,
        files,
        skills: [{
          dir: '.',
          name: row.fm_name || row.name,
          description: U.descriptionOf(files['SKILL.md']) ?? null,
          files: Object.keys(files).sort(),
        }],
      };
    }
    const version = store.getPackageVersion(installation.packageId, installation.targetVersion);
    if (!version?.artifactRef) throw error('NOT_FOUND', 'Skill package artifact is not available');
    const entries = await installedPackageContent(version.artifactRef);
    const editable = entries.length === 1 && entries[0].dir === '.';
    const files = {};
    if (editable) {
      for (const [rel, content] of entries[0].files) {
        if (rel.toLowerCase() === 'package.json') continue;
        files[rel] = content;
      }
    } else {
      for (const entry of entries) {
        for (const [rel, content] of entry.files) {
          if (rel.toLowerCase() === 'package.json') continue;
          const key = entry.dir === '.' ? rel : `${entry.dir}/${rel}`;
          files[key] = content;
        }
      }
    }
    return {
      installationId,
      editable,
      files,
      skills: entries.map((e) => ({
        dir: e.dir,
        name: e.name,
        description: e.description ?? null,
        files: [...e.files.keys()].filter((k) => k.toLowerCase() !== 'package.json').sort(),
      })),
    };
  }

  async function writeInstallationFiles(installationId, rawFiles, { requestId } = {}) {
    const installation = store.getInstallation(installationId);
    if (!installation) throw error('NOT_FOUND', 'Installation not found');
    if (installation.kind !== 'skill') throw error('INVALID_ARGUMENT', 'Installation is not a skill');
    const normalized = normalizeFilesMap(rawFiles);
    const files = {};
    for (const [key, value] of Object.entries(normalized)) {
      if (value !== null) files[key] = value;
    }
    if (typeof files['SKILL.md'] !== 'string') throw error('VALIDATION_FAILED', 'files must include SKILL.md');
    const fmErr = validateSkillMd(files['SKILL.md']);
    if (fmErr) throw error('VALIDATION_FAILED', fmErr);

    const row = stmts.skillByInstallationId.get(installationId);
    if (row) {
      const ownerId = { deviceId: row.device_id, botId: row.bot_id, origin: 'foreground', sessionId: null, requestId: null };
      await enqueue(ownerId, async () => {
        const current = stmts.skillById.get(row.id);
        if (!current) throw error('NOT_FOUND', 'Managed skill not found');
        tx(() => {
          commitSkillFiles(current, files);
          usageMutate(ownerId, current.name, (rec) => U.bumpPatchApply(rec));
        });
        const updated = stmts.skillById.get(current.id);
        if (usageRow(ownerId, updated.name).record?.state !== U.STATE_ARCHIVED) {
          await syncSkillPackage(ownerId, updated);
        }
      });
      return await readInstallationFiles(installationId);
    }

    const existing = await readInstallationFiles(installationId);
    if (!existing.editable) {
      throw error('INVALID_STATE', 'Multi-skill or subdirectory skill packages are read-only');
    }
    const version = '0.0.0-h' + sha256(json(files)).slice(0, 12);
    const description = U.descriptionOf(files['SKILL.md']) ?? installation.displayName;
    const bytes = await buildArtifact(installation.packageId, version, files, description);
    const { artifactRef } = await packages.uploadArtifact([bytes]);
    const receipt = await packages.update(installationId, {
      requestId: requestId || randomUUID(),
      source: { type: 'artifact', artifactRef },
      allowSourceSwitch: true,
    });
    const ready = await waitFor(() => {
      const op = store.getOperation(receipt.operationId);
      if (op?.phase === 'failed') return { failed: true, op };
      const current = store.getInstallation(installationId);
      if (current?.source?.artifactRef !== artifactRef) return null;
      if (current.enabled && current.activation?.status === 'enabling') return null;
      return { failed: false, op, inst: current };
    }, PUBLISH_WAIT_MS);
    if (!ready || ready.failed) {
      const op = store.getOperation(receipt.operationId);
      throw error(op?.error?.code ?? 'INTERNAL_ERROR', op?.error?.message ?? 'Skill update failed');
    }
    const devices = new Set(store.listBotBindings({ installationId }).map((binding) => binding.deviceId));
    for (const deviceId of devices) {
      try { await packages.reconcileDevice(deviceId); } finally { notify(deviceId); }
    }
    return await readInstallationFiles(installationId);
  }

  async function prepareInlineSkill({ displayName, files: rawFiles } = {}) {
    const normalized = normalizeFilesMap(rawFiles);
    const files = {};
    for (const [key, value] of Object.entries(normalized)) {
      if (value !== null) files[key] = value;
    }
    if (typeof files['SKILL.md'] !== 'string') throw error('VALIDATION_FAILED', 'files must include SKILL.md');
    const fmErr = validateSkillMd(files['SKILL.md']);
    if (fmErr) throw error('VALIDATION_FAILED', fmErr);
    const packageId = 'center-skill-' + randomUUID();
    const version = '0.0.0-h' + sha256(json(files)).slice(0, 12);
    const description = U.descriptionOf(files['SKILL.md']) ?? (typeof displayName === 'string' && displayName.trim() ? displayName.trim() : packageId);
    const bytes = await buildArtifact(packageId, version, files, description);
    const { artifactRef } = await packages.uploadArtifact([bytes]);
    return { artifactRef, packageId };
  }

  // Authenticated Host-only observations, separate from model-facing management actions.
  async function reportUse(identity, input) {
    const id = normalizeIdentity(identity);
    assertBot(id);
    const fields = ['requestId', 'installationId', 'version', 'skillName', 'skillPath', 'path'];
    if (!input || fields.some(key => typeof input[key] !== 'string' || !input[key] || input[key].length > 1024)
      || Object.keys(input).some(key => !fields.includes(key)) || !/^[a-f0-9]{64}$/.test(input.requestId)) {
      throw error('INVALID_ARGUMENT', 'Invalid skill use observation');
    }
    return enqueue(id, async () => {
      const replayed = replay(id, input, 'host_skill_use');
      if (replayed.hit) return replayed.hit;
      const binding = store.listBotBindings({ deviceId: id.deviceId }).find(binding =>
        binding.botId === id.botId && binding.installationId === input.installationId && binding.enabled);
      const installation = store.getInstallation(input.installationId);
      if (!binding || installation?.kind !== 'skill' || installation.target !== 'host'
        || !store.isActive(installation) || installation.targetVersion !== input.version) {
        throw error('FORBIDDEN', 'Skill installation is not active for this Bot/version');
      }
      const version = store.getPackageVersion(installation.packageId, input.version);
      if (!version?.artifactRef) throw error('NOT_FOUND', 'Skill artifact is unavailable');
      const skill = (await installedPackage(version.artifactRef)).find(skill =>
        skill.name === input.skillName && skill.dir === input.skillPath && skill.files.includes(input.path));
      if (!skill) throw error('INVALID_ARGUMENT', 'Read file does not belong to this skill');
      const managed = stmts.skillsFor.all(id.deviceId, id.botId).find(row => row.installation_id === input.installationId);
      const ownerRow = stmts.skillByInstallationId.get(input.installationId);
      const name = managed?.name ?? skill.name;
      return tx(() => {
        bumpUse(id, name);
        if (ownerRow && (ownerRow.device_id !== id.deviceId || ownerRow.bot_id !== id.botId)) {
          bumpUse({ deviceId: ownerRow.device_id, botId: ownerRow.bot_id }, ownerRow.name);
        }
        const result = { recorded: true, name };
        recordRequest(id, replayed, result);
        return result;
      });
    });
  }

  function learningSourceOf(identity, id) {
    const source = identity.learningSource;
    const modes = { foreground: 'learn', background_review: 'review', curator: 'curate' };
    const mode = ['learn', 'review', 'curate'].includes(source?.mode) ? source.mode : modes[id.origin];
    const fields = { mode };
    for (const key of ['jobId', 'conversationId']) {
      if (typeof source?.[key] === 'string' && source[key].length > 0 && source[key].length <= 256) {
        fields[key] = source[key];
      }
    }
    if (!fields.jobId && id.sessionId && id.sessionId.length <= 256) fields.jobId = id.sessionId;
    for (const key of ['afterEntryId', 'throughEntryId']) {
      if (Number.isSafeInteger(source?.[key]) && source[key] >= 0) fields[key] = source[key];
    }
    return fields;
  }

  // --- public learningTool() adapter -----------------------------------------------
  async function learningTool(identity, name, args = {}) {
    const id = normalizeIdentity(identity);
    assertBot(id);
    const a = args && typeof args === 'object' ? args : {};
    switch (name) {
      case 'skills_list': return json(await skillsList(id));
      case 'skill_view': return json(await skillView(id, a));
      case 'skill_manage': return skillManage({ ...id, learningSource: learningSourceOf(identity, id) }, a);
      case 'read_file': return json(await readFileTool(id, a));
      case 'search_files': return json(await searchFilesTool(id, a));
      default: break;
    }
    if (name.startsWith('skill_usage.')) {
      const fn = skillUsageCalls[name.slice('skill_usage.'.length)];
      if (!fn) throw error('INVALID_ARGUMENT', `Unsupported skill_usage call '${name}'`);
      const installedList = await installedSkills(id);
      const callId = { ...id, learningSource: learningSourceOf(identity, id) };
      return enqueue(id, () => fn(callId, a, installedList));
    }
    if (name.startsWith('skill_provenance.')) {
      const fn = provenanceCalls[name.slice('skill_provenance.'.length)];
      if (!fn) throw error('INVALID_ARGUMENT', `Unsupported skill_provenance call '${name}'`);
      return fn(id, a);
    }
    throw error('INVALID_ARGUMENT', `Unsupported tool '${name}'. Allowed: ${[...LEARNING_SKILL_TOOLS.map((t) => t.function.name), 'skill_usage.*', 'skill_provenance.*'].join(', ')}`);
  }

  function sameFileMap(a, b) {
    const keysA = Object.keys(a).filter((k) => k.toLowerCase() !== 'package.json').sort();
    const keysB = Object.keys(b).filter((k) => k.toLowerCase() !== 'package.json').sort();
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key, idx) => key === keysB[idx] && a[key] === b[key]);
  }

  async function migrateExistingSkills() {
    for (const row of stmts.allSkills.all()) {
      const inst = row.installation_id ? store.getInstallation(row.installation_id) : null;
      if (inst && (!inst.ownerBot || !inst.visibilityScope)) {
        const hasExternalBinding = store.listBotBindings({ installationId: row.installation_id })
          .some((b) => b.enabled && (b.deviceId !== row.device_id || b.botId !== row.bot_id));
        const scope = inst.visibilityScope ?? (hasExternalBinding ? 'assigned' : 'private');
        const ownerBot = inst.ownerBot ?? {
          deviceId: row.device_id,
          botId: row.bot_id,
          skillId: row.id,
          skillName: row.name,
        };
        store.setInstallationOwnership?.(row.installation_id, ownerBot, scope);
      }
      const id = { deviceId: row.device_id, botId: row.bot_id, origin: 'foreground', sessionId: null, requestId: null };
      if (!store.listDeviceBots(id.deviceId).some((bot) => bot.botId === id.botId)) continue;
      if (usageRow(id, row.name).record?.state === U.STATE_ARCHIVED) continue;

      let needsSync = !row.installation_id || !inst || !inst.enabled || inst.activation?.status !== 'enabled'
        || !inst.source?.artifactRef || !bindingEnabled(id, row.installation_id);
      if (!needsSync) {
        try {
          const content = await installedPackageContent(inst.source.artifactRef);
          const entry = content.length === 1 && content[0].dir === '.' ? content[0] : null;
          if (!entry || !sameFileMap(Object.fromEntries(entry.files), skillFiles(row))) {
            needsSync = true;
          }
        } catch {
          needsSync = true;
        }
      }
      if (needsSync) {
        await enqueue(id, async () => {
          const current = stmts.skillById.get(row.id);
          if (!current) return;
          await syncSkillPackage(id, current);
        }).catch(() => {});
      }
    }
  }
  await migrateExistingSkills();

  return {
    execute,
    reportUse,
    learningTool,
    review,
    readInstallationFiles,
    writeInstallationFiles,
    prepareInlineSkill,
    LEARNING_SKILL_TOOLS,
    async close() {
      try { await Promise.allSettled([...queues.values()]); } finally { db.close(); }
    },
  };
}
