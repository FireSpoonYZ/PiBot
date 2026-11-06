// Center-managed per-Bot skill service.
//
// openSkillManager({dataRoot, store, packages, notify}) ->
//   { execute(identity, input), hermes(identity, name, args), close() }
//
// identity = {deviceId, botId, origin?: 'foreground'|'background_review'|'curator',
//             sessionId?, requestId?}. origin drives upstream provenance and guards:
//   - 'background_review'/'curator': agent-created provenance, read-before-write
//     enforcement, delete -> recoverable archive, locked/pinned protections.
//   - 'foreground' (default): owner-driven management; hard delete, no read guard.
//
// Storage: own SQLite at dataRoot/skills/skills.sqlite (skills, skill_revisions,
// skill_usage, skill_requests). Managed skill files live ONLY in revisions;
// publish builds a kind=skill artifact package through the existing packages
// pipeline (uploadArtifact -> install/update -> enable -> Bot binding ->
// reconcile + notify). Managed package dirs stay immutable deployment output.
//
// The hermes() adapter maps upstream tools (skills_list, skill_view,
// skill_manage, read_file, search_files) and skill_usage.*/skill_provenance.*
// function calls onto this service; upstream-shaped results (success/_change)
// keep agent/background_review.py and agent/curator.py summaries working.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as tar from 'tar';
import { extractArtifact } from '../../host-core/managed-install/archive.js';
import * as U from './upstream.js';
import { HERMES_SKILL_TOOLS } from './hermes-tools.js';

const error = (code, message, details) => Object.assign(new Error(message), { code, details });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value);
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const AUTONOMOUS_ORIGINS = new Set(['background_review', 'curator']);
const PUBLISH_WAIT_MS = 8000;
const CONTENT_CACHE_LIMIT = 6;
const CONTENT_CACHE_MAX_BYTES = 16 * 1024 * 1024;

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
      head_rev INTEGER NOT NULL,
      installation_id TEXT,
      package_id TEXT,
      published_rev INTEGER,
      source TEXT NOT NULL DEFAULT 'managed',
      json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(device_id, bot_id, name)
    );
    CREATE TABLE IF NOT EXISTS skill_revisions (
      skill_id TEXT NOT NULL,
      rev INTEGER NOT NULL,
      files TEXT NOT NULL,
      description TEXT,
      origin TEXT,
      request_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (skill_id, rev)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS skill_revisions_request
      ON skill_revisions(skill_id, request_id) WHERE request_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS skill_usage (
      device_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      json TEXT NOT NULL,
      PRIMARY KEY (device_id, bot_id, name)
    );
    CREATE TABLE IF NOT EXISTS skill_artifacts (
      skill_id TEXT NOT NULL,
      rev INTEGER NOT NULL,
      artifact_ref TEXT NOT NULL,
      PRIMARY KEY(skill_id, rev)
    );
    CREATE TABLE IF NOT EXISTS skill_snapshots (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL
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

  const stmts = {
    skillById: db.prepare('SELECT * FROM skills WHERE id = ?'),
    skillByName: db.prepare('SELECT * FROM skills WHERE device_id = ? AND bot_id = ? AND name = ?'),
    skillByScopedName: db.prepare('SELECT * FROM skills WHERE device_id = ? AND bot_id = ? AND category = ? AND name = ?'),
    skillsByFm: db.prepare('SELECT * FROM skills WHERE device_id = ? AND bot_id = ? AND fm_name = ?'),
    skillsFor: db.prepare('SELECT * FROM skills WHERE device_id = ? AND bot_id = ? ORDER BY name'),
    insertSkill: db.prepare('INSERT INTO skills (id, device_id, bot_id, name, fm_name, category, revision, head_rev, installation_id, package_id, published_rev, source, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    updateSkill: db.prepare('UPDATE skills SET fm_name = ?, revision = ?, head_rev = ?, installation_id = ?, package_id = ?, published_rev = ?, json = ?, updated_at = ? WHERE id = ?'),
    deleteSkill: db.prepare('DELETE FROM skills WHERE id = ?'),
    revGet: db.prepare('SELECT * FROM skill_revisions WHERE skill_id = ? AND rev = ?'),
    revList: db.prepare('SELECT rev, description, origin, request_id, created_at FROM skill_revisions WHERE skill_id = ? ORDER BY rev'),
    revInsert: db.prepare('INSERT INTO skill_revisions (skill_id, rev, files, description, origin, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    revDelete: db.prepare('DELETE FROM skill_revisions WHERE skill_id = ?'),
    usageGet: db.prepare('SELECT revision, json FROM skill_usage WHERE device_id = ? AND bot_id = ? AND name = ?'),
    usagePut: db.prepare('INSERT INTO skill_usage (device_id, bot_id, name, revision, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id, bot_id, name) DO UPDATE SET revision = excluded.revision, json = excluded.json'),
    usageDel: db.prepare('DELETE FROM skill_usage WHERE device_id = ? AND bot_id = ? AND name = ?'),
    usageAll: db.prepare('SELECT name, json FROM skill_usage WHERE device_id = ? AND bot_id = ?'),
    usageDelAll: db.prepare('DELETE FROM skill_usage WHERE device_id = ? AND bot_id = ?'),
    artifactGet: db.prepare('SELECT artifact_ref FROM skill_artifacts WHERE skill_id = ? AND rev = ?'),
    artifactPut: db.prepare('INSERT OR IGNORE INTO skill_artifacts (skill_id, rev, artifact_ref) VALUES (?, ?, ?)'),
    artifactDelete: db.prepare('DELETE FROM skill_artifacts WHERE skill_id = ?'),
    snapshotInsert: db.prepare('INSERT INTO skill_snapshots (id, device_id, bot_id, reason, json, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    snapshotsFor: db.prepare('SELECT id FROM skill_snapshots WHERE device_id = ? AND bot_id = ? ORDER BY rowid DESC'),
    snapshotGet: db.prepare('SELECT * FROM skill_snapshots WHERE id = ? AND device_id = ? AND bot_id = ?'),
    snapshotList: db.prepare('SELECT * FROM skill_snapshots WHERE device_id = ? AND bot_id = ? ORDER BY rowid DESC LIMIT 20'),
    snapshotDelete: db.prepare('DELETE FROM skill_snapshots WHERE id = ? AND device_id = ? AND bot_id = ?'),
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
    return {
      deviceId, botId, origin,
      sessionId: typeof identity.sessionId === 'string' ? identity.sessionId : null,
      requestId: typeof identity.requestId === 'string' ? identity.requestId : null,
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

  async function reconcileBindingChanges(id, work) {
    const bindings = () => json(store.listBotBindings({ deviceId: id.deviceId })
      .filter((binding) => binding.botId === id.botId));
    const before = bindings();
    const result = work();
    if (bindings() !== before) {
      try { await packages.reconcileDevice(id.deviceId); } finally { notify(id.deviceId); }
    }
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
  const skillFiles = (row) => JSON.parse(stmts.revGet.get(row.id, row.head_rev)?.files || '{}');
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

  const bumpView = (id, name) => usageMutate(id, name, (rec) => {
    rec.view_count = (Number(rec.view_count) || 0) + 1;
    rec.last_viewed_at = now();
    return null;
  });
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

  /** Files map -> new revision + skill row update inside a tx. Returns the stored rev row fields. */
  function commitRevision(skill, files, { origin, requestId }) {
    const description = U.descriptionOf(files['SKILL.md']);
    const fmName = fmNameOf(files['SKILL.md']);
    const rev = skill.head_rev + 1;
    stmts.revInsert.run(skill.id, rev, json(files), description, origin ?? null, requestId ?? null, now());
    const revision = skill.revision + 1;
    const meta = JSON.parse(skill.json || '{}');
    stmts.updateSkill.run(fmName, revision, rev, skill.installation_id, skill.package_id, skill.published_rev, json(meta), now(), skill.id);
    return { rev, revision, description, fmName };
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
    const skill = {
      id: randomUUID(), device_id: id.deviceId, bot_id: id.botId, name,
      category: category ? category.trim() : null, revision: 0, head_rev: 0,
      installation_id: null, package_id: null, published_rev: null,
      source: 'managed', json: '{}',
    };
    const { rev, revision, fmName } = commitRevision({ ...skill, head_rev: 0, revision: 0, json: '{}' }, files,
      { origin: id.origin, requestId: id.requestId });
    stmts.insertSkill.run(skill.id, id.deviceId, id.botId, name, fmName, skill.category, revision, rev, null, null, null, 'managed', '{}', now(), now());
    const result = U.successResult({
      message: `Skill '${name}' created.`, path: displayPath({ name, category: skill.category }),
      skill_md: 'SKILL.md', _change: { description: U.descriptionPreview(content) },
      ...(skill.category ? { category: skill.category } : {}),
      hint: `To add reference files, templates, or scripts, use skill_manage(action='write_file', name='${name}', file_path='references/example.md', file_content='...')`,
    });
    U.addDescriptionPromptPreview(result, content);
    return { result, usage: () => usageMutate(id, name, (rec) => U.recordCreatedApply(rec, AUTONOMOUS_ORIGINS.has(id.origin))) };
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

  function opDelete(id, a, installedList) {
    const row = a._row;
    const name = row.name;
    const pinned = usageRow(id, name).record?.pinned === true;
    if (pinned) return U.refusal(`Skill '${name}' is pinned; unpin it before deleting.`);
    const absorbed = a.absorbed_into;
    if (AUTONOMOUS_ORIGINS.has(id.origin) && typeof absorbed !== 'string') {
      return U.refusal("Curator/review deletes must pass absorbed_into ('' for an explicit prune, or the umbrella skill's name).");
    }
    const target = typeof absorbed === 'string' ? absorbed.trim() : '';
    if (target) {
      if (target === name) return U.refusal(`absorbed_into='${target}' cannot equal the skill being deleted.`);
      const targetRow = resolveManaged(id, target);
      if (!targetRow) {
        return U.refusal(`absorbed_into='${target}' does not exist. Create or patch the umbrella skill first, then retry the delete.`);
      }
      if (id.origin === 'curator' && (usageRow(id, targetRow.name).record?.state === U.STATE_ARCHIVED
        || !skillUsageCalls.curated_report(id, {}, installedList).some(row => row.name === target))) {
        return U.refusal(`Curator absorbed_into='${target}' must use the exact name of a non-archived skill in this Bot's curated_report. Pin an eligible manual target first, or choose an active curator-managed target; restore an archived target before retrying. The source skill has not been archived.`);
      }
    }
    if (AUTONOMOUS_ORIGINS.has(id.origin)) {
      const [ok, msg] = archiveSkillNow(id, name, installedList);
      if (!ok) return U.refusal(msg);
      const absorbedNote = target ? ` Content absorbed into '${target}'.` : '';
      return { result: U.successResult({ message: `Skill '${name}' archived (${msg}).${absorbedNote}`, _archived: true }), deleted: 'archived' };
    }
    const absorbedNote = target ? ` Content absorbed into '${target}'.` : '';
    return { result: U.successResult({ message: `Skill '${name}' deleted.${absorbedNote}` }), deleted: 'hard', row };
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

  /** Apply one skill_manage op (flat args). Returns {result, row?, files?, usage?, deleted?}. */
  function applyManageOp(id, a, installedList) {
    const action = a.action;
    if (!action || typeof action !== 'string') return U.refusal("action is required. Use: create, patch, delete, write_file, remove_file");
    if (action === 'create') return opCreate(id, a, installedList);
    if (!['patch', 'edit', 'delete', 'write_file', 'remove_file'].includes(action)) {
      return U.refusal(`Unknown action '${action}'. Use: create, edit, patch, delete, write_file, remove_file`);
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
    if (action === 'delete') return opDelete(id, a, installedList);
    const files = skillFiles(row);
    if (action === 'edit') {
      // Legacy alias: full SKILL.md rewrite.
      return opPatch(id, { ...a, content: a.content, file_path: undefined, old_string: undefined, new_string: undefined }, files);
    }
    if (action === 'patch') return opPatch(id, a, files);
    if (action === 'write_file') return opWriteFile(id, a, files);
    return opRemoveFile(id, a, files);
  }

  /** Persist one applied op inside the caller's tx: commit file revisions, then usage side effects. */
  function persistManageResult(id, applied) {
    if (applied.files && applied.row) {
      const err = revalidateWhole(applied.files);
      if (err) return U.refusal(err);
      commitRevision(applied.row, applied.files, { origin: id.origin, requestId: id.requestId });
    }
    applied.usage?.();
    return null;
  }

  /** Archive immediately (recoverable delete path / skill_usage.archive_skill / execute archive). */
  function archiveSkillNow(id, name, installedList) {
    const row = managedRow(id, name);
    if (!row) {
      if (isHubInstalled(id, name, installedList)) return [false, `skill '${name}' is hub-installed; never archive`];
      return [false, `skill '${name}' not found`];
    }
    const { record } = usageRow(id, name);
    if (record?.state === U.STATE_ARCHIVED) return [false, `skill '${name}' not found`];
    const current = record ?? U.emptyRecord();
    const bindingWasEnabled = Boolean(row.installation_id && bindingEnabled(id, row.installation_id));
    U.setStateApply(current, U.STATE_ARCHIVED);
    current.archive_binding_was_enabled = bindingWasEnabled;
    usageWrite(id, name, usageRow(id, name).revision + 1, current);
    if (bindingWasEnabled) setBindingEnabled(id, row.installation_id, false);
    return [true, `archived to .archive/${name}`];
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
    snapshot_skills: (id, a) => tx(() => {
      const snapshotId = randomUUID();
      const skills = stmts.skillsFor.all(id.deviceId, id.botId).map((row) => ({
        skill: row, files: skillFiles(row), usage: usageRow(id, row.name),
      }));
      stmts.snapshotInsert.run(snapshotId, id.deviceId, id.botId,
        typeof a.reason === 'string' ? a.reason.slice(0, 200) : 'manual', json(skills), now());
      return { id: snapshotId };
    }),
    prune_old_snapshots: (id) => tx(() => {
      const expired = stmts.snapshotsFor.all(id.deviceId, id.botId).slice(2);
      for (const row of expired) stmts.snapshotDelete.run(row.id, id.deviceId, id.botId);
      return expired.map((row) => row.id);
    }),
    bump_view: (id, a) => { bumpView(id, a.skill_name ?? a.name); return null; },
    bump_use: (id, a) => { bumpUse(id, a.skill_name ?? a.name); return null; },
    bump_patch: (id, a) => { bumpPatch(id, a.skill_name ?? a.name); return null; },
    record_created: (id, a) => {
      const name = a.skill_name ?? a.name;
      const agentCreated = a.agent_created !== undefined ? Boolean(a.agent_created) : AUTONOMOUS_ORIGINS.has(id.origin);
      usageMutate(id, name, (rec) => U.recordCreatedApply(rec, agentCreated));
      return null;
    },
    record_installed: (id, a) => usageMutate(id, a.skill_name ?? a.name, (rec) => {
      rec.created_by = 'installed';
      rec.state = U.STATE_ACTIVE;
      rec.archived_at = null;
      return { created_by: 'installed' };
    }),
    mark_agent_created: (id, a, installedList) => usageMutate(id, a.skill_name ?? a.name, (rec) => {
      rec.created_by = 'agent';
      return true;
    }, { eligibleOnly: true, installedList }),
    forget: (id, a) => { forget(id, a.skill_name ?? a.name); return null; },
    get_record: (id, a) => U.backfilled(usageRow(id, a.skill_name ?? a.name).record),
    load_usage: (id) => Object.fromEntries(stmts.usageAll.all(id.deviceId, id.botId).map((row) => [row.name, JSON.parse(row.json)])),
    save_usage: (id, a) => tx(() => {
      stmts.usageDelAll.run(id.deviceId, id.botId);
      const data = a.data ?? a;
      if (data && typeof data === 'object') {
        for (const [name, rec] of Object.entries(data)) {
          if (rec && typeof rec === 'object' && !Array.isArray(rec)) usageWrite(id, name, 1, U.backfilled(rec));
        }
      }
      return true;
    }),
    seed_record_if_missing: (id, a, installedList) => { seedRecord(id, a.skill_name ?? a.name, installedList); return null; },
    reanchor_clock: (id, a) => usageMutate(id, a.skill_name ?? a.name, (rec) => {
      rec.created_at = rec.first_seen_at = now();
      if (rec.state === U.STATE_STALE) rec.state = U.STATE_ACTIVE;
      return null;
    }),
    set_state: (id, a, installedList) => {
      const name = a.skill_name ?? a.name;
      const state = a.state;
      if (!U.VALID_STATES.has(state) || !isCurationEligible(id, name, installedList)) return null;
      const facts = usageMutate(id, name, (rec) => U.setStateApply(rec, state), { installedList });
      const row = managedRow(id, name);
      if (!facts?.changed || !row?.installation_id) return null;
      const { record } = usageRow(id, name);
      const current = record ?? {};
      if (state === U.STATE_ARCHIVED) {
        // An archived managed skill must not keep loading on the Host: disable its binding.
        current.archive_binding_was_enabled = bindingEnabled(id, row.installation_id);
        usageWrite(id, name, usageRow(id, name).revision + 1, current);
        if (current.archive_binding_was_enabled) setBindingEnabled(id, row.installation_id, false);
      } else if (facts.previous_state === U.STATE_ARCHIVED) {
        const wasEnabled = current.archive_binding_was_enabled === true;
        delete current.archive_binding_was_enabled;
        usageWrite(id, name, usageRow(id, name).revision + 1, current);
        if (wasEnabled) setBindingEnabled(id, row.installation_id, true);
      }
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
        if (record?.pinned && record.state !== U.STATE_ARCHIVED && isCurationEligible(id, row.name, installedList)) names.add(row.name);
      }
      return [...names].sort().map((name) => {
        const { record } = usageRow(id, name);
        return U.reportRow(name, record, { _persisted: Boolean(record), provenance: provenanceOf(id, name, installedList) });
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
    archive_skill: (id, a, installedList) => archiveSkillNow(id, a.skill_name ?? a.name, installedList),
    restore_skill: (id, a, installedList) => restoreSkillNow(id, a.skill_name ?? a.name, installedList),
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
      revision: row.revision, stateRevision: revision, headRevision: row.head_rev,
      installationId: row.installation_id ?? undefined, publishedRevision: row.published_rev ?? undefined,
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
      if (result.success) bumpView(id, managed.name);
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
      const requestId = id.requestId && 'hermes:' + sha256(json([id.deviceId, id.botId, id.requestId]));
      const request = { action: 'hermes.skill_manage', requestId, args };
      const replayed = replay(id, request, request.action);
      let saved = replayed.hit;
      if (!saved) {
        const ops = batch ? args.operations : [args];
        if (id.origin === 'curator' && ops.length !== 1 && ops.some(op => op?.action === 'delete')) {
          return json({ ...U.refusal('Curator delete must be the sole operation in its call. Create or patch the umbrella first, then delete in a separate call. No skills were changed.'),
            results: [], operations_applied: 0, rolled_back: true });
        }
        const installedList = await installedSkills(id);
        try {
          saved = await reconcileBindingChanges(id, () => tx(() => {
            const results = [], changed = new Set();
            let singleOutcome;
            for (const op of ops) {
              if (!op || typeof op !== 'object' || Array.isArray(op)) {
                throw { refusal: 'Each operation must be an object with name+action.', results };
              }
              // The request record deduplicates the whole batch; individual revisions
              // must not share its unique request id when a skill is edited twice.
              const applied = applyManageOp({ ...id, requestId: null }, { ...op }, installedList);
              const outcome = applied.result ?? applied;
              singleOutcome = outcome;
              results.push({ action: op.action, name: op.name, ...(op.file_path ? { file_path: op.file_path } : {}), ...pickResult(outcome) });
              if (!outcome.success) throw { refusal: outcome.error ?? 'operation failed', results, outcome };
              if (applied.deleted === 'hard') deleteManagedNow(id, applied.row);
              else if (applied.deleted !== 'archived') {
                const refusal = persistManageResult({ ...id, requestId: null }, applied);
                if (refusal) throw { refusal: refusal.error, results, outcome: refusal };
                const row = applied.row ?? resolveManaged(id, op.name);
                if (row) changed.add(row.id);
              }
            }
            const result = batch
              ? { success: true, results, operations_applied: ops.length }
              : (ops.length ? undefined : { success: true });
            const payload = { result: result ?? null, changed: [...changed] };
            if (!batch) {
              // Preserve the original single-op _change and messages.
              payload.result = singleOutcome;
            }
            recordRequest(id, replayed, payload);
            return payload;
          }));
        } catch (err) {
          if (!err?.refusal) throw err;
          return json(batch
            ? { success: false, error: err.refusal, results: err.results, operations_applied: 0, rolled_back: true }
            : (err.outcome ?? U.refusal(err.refusal)));
        }
      }
      const publications = [];
      for (const skillId of saved.changed) {
        const row = stmts.skillById.get(skillId);
        if (!row || usageRow(id, row.name).record?.state === U.STATE_ARCHIVED) continue;
        try {
          const published = await actions.publish(id, { skillId, expectedRevision: row.revision });
          publications.push({ skillId, ...published.publication });
        } catch (err) {
          publications.push({ skillId, status: 'failed', error: err.message });
        }
      }
      for (const receipt of publications) {
        if (['queued', 'activating'].includes(receipt.status)) schedulePublication(id, receipt.skillId);
      }
      const failed = publications.some((receipt) => receipt.status === 'failed');
      const response = {
        ...saved.result,
        ...(publications.length ? { publications } : {}),
        ...(failed ? { success: false, draftSaved: true, error: 'Draft saved; publication failed. Retry this request to resume publication.' } : {}),
      };
      if (failed) delete response._change;
      return json(response);
    });
  }

  const publicationTimers = new Map();
  let closing = false;
  function schedulePublication(id, skillId, attempts = 0) {
    if (closing || attempts >= 20) return;
    if (publicationTimers.has(skillId)) clearTimeout(publicationTimers.get(skillId));
    const expectedRevision = stmts.skillById.get(skillId)?.revision;
    const timer = setTimeout(() => {
      publicationTimers.delete(skillId);
      void enqueue(id, async () => {
        const row = stmts.skillById.get(skillId);
        if (!row || row.revision !== expectedRevision || usageRow(id, row.name).record?.state === U.STATE_ARCHIVED) return;
        const result = await actions.publish(id, { skillId, expectedRevision: row.revision });
        if (['queued', 'activating'].includes(result.publication.status)) schedulePublication(id, skillId, attempts + 1);
      }).catch(() => {});
    }, 5000);
    timer.unref?.();
    publicationTimers.set(skillId, timer);
  }

  const pickResult = (outcome) => ({ success: outcome.success === true, ...(outcome.success ? {} : { error: outcome.error }), ...(outcome.message ? { message: outcome.message } : {}) });

  function deleteManagedNow(id, row) {
    stmts.revDelete.run(row.id);
    stmts.artifactDelete.run(row.id);
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

  function assertRevision(expected, actual) {
    if (expected !== actual) throw error('REVISION_CONFLICT', 'Revision does not match');
  }

  function summarizeSkill(id, row) {
    const { record, revision } = usageRow(id, row.name);
    const files = skillFiles(row);
    return {
      skillId: row.id, name: row.name, path: displayPath(row),
      ...(row.category ? { category: row.category } : {}),
      description: U.descriptionOf(files['SKILL.md']) ?? null,
      revision: row.revision, stateRevision: revision, headRevision: row.head_rev,
      state: record?.state ?? U.STATE_ACTIVE, pinned: record?.pinned === true, locked: record?.locked === true,
      createdBy: record?.created_by ?? null, source: row.source,
      installationId: row.installation_id ?? undefined, publishedRevision: row.published_rev ?? undefined,
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

  function snapshotSkills(id, snapshot) {
    return JSON.parse(snapshot.json).map(entry => {
      const current = getManaged(id, entry.skill.name);
      return { ...entry, current };
    });
  }

  const actions = {
    snapshots(id, input) {
      const rows = input.snapshotId
        ? [stmts.snapshotGet.get(input.snapshotId, id.deviceId, id.botId)].filter(Boolean)
        : stmts.snapshotList.all(id.deviceId, id.botId);
      return { snapshots: rows.map(snapshot => ({
        snapshotId: snapshot.id, reason: snapshot.reason, createdAt: snapshot.created_at,
        skills: snapshotSkills(id, snapshot).map(({ skill, current }) => ({
          name: skill.name, skillId: skill.id, snapshotRevision: skill.head_rev,
          currentSkillId: current?.id ?? null,
        })),
        expectedRevisions: Object.fromEntries(snapshotSkills(id, snapshot).map(({ skill, current }) => [
          skill.name, current ? { skillId: current.id, revision: current.revision,
            stateRevision: usageRow(id, current.name).revision } : null,
        ])),
      })) };
    },

    async restore_snapshot(id, input) {
      if (typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 200) {
        throw error('INVALID_ARGUMENT', 'restore_snapshot requires requestId');
      }
      if (typeof input.snapshotId !== 'string' || !input.snapshotId || input.snapshotId.length > 200) {
        throw error('INVALID_ARGUMENT', 'restore_snapshot requires snapshotId');
      }
      const expected = input.expectedRevisions;
      if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
        throw error('INVALID_ARGUMENT', 'Use snapshots to obtain expectedRevisions');
      }
      const deploymentPlans = await packages.listDeploymentPlans(id.deviceId);
      const snapshot = stmts.snapshotGet.get(input.snapshotId, id.deviceId, id.botId);
      if (!snapshot) throw error('NOT_FOUND', 'Snapshot not found for this Bot');
      const entries = snapshotSkills(id, snapshot);
      if (Object.keys(expected).length !== entries.length) throw error('REVISION_CONFLICT', 'Snapshot skill set mismatch');
      return tx(() => {
        const replayed = replay(id, input, 'restore_snapshot');
        if (replayed.hit) return replayed.hit;
        for (const { skill, current } of entries) {
          if (!Object.hasOwn(expected, skill.name)) throw error('REVISION_CONFLICT', 'Missing snapshot skill revision');
          const token = expected[skill.name];
          if (current) {
            if (!token || token.skillId !== current.id) throw error('REVISION_CONFLICT', 'Skill identity changed');
            assertRevision(token.revision, current.revision);
            assertRevision(token.stateRevision, usageRow(id, current.name).revision);
          } else if (token !== null) throw error('REVISION_CONFLICT', 'Skill was deleted');
        }
        const restored = entries.map(({ skill, files, usage, current }) => {
          // A deleted skill starts a new identity; surviving skills retain every revision.
          const row = current ?? { id: randomUUID(), head_rev: 0, revision: 0,
            installation_id: null, package_id: null, published_rev: null, json: '{}' };
          const committed = commitRevision(row, files, { origin: 'snapshot_restore', requestId: input.requestId });
          if (!current) stmts.insertSkill.run(row.id, id.deviceId, id.botId, skill.name,
            committed.fmName, skill.category, committed.revision, committed.rev, null, null, null,
            skill.source, '{}', now(), now());
          // Preserve live telemetry; if it was deleted too, recover the snapshot's record.
          if (!current && !usageRow(id, skill.name).record && usage?.record) {
            usageWrite(id, skill.name, 1, usage.record);
          }
          const summary = summarizeSkill(id, stmts.skillById.get(row.id));
          const requiresRestore = summary.state === U.STATE_ARCHIVED;
          return { ...summary, publishedRevision: row.published_rev ?? null,
            restoredFromRevision: skill.head_rev, stage: 'draft', restoreMode: 'drafts',
            requiresRestore, nextActions: requiresRestore ? ['restore', 'publish'] : ['publish'],
            currentDeployment: {
              plans: deploymentPlans.filter(plan => plan.installationId === row.installation_id),
              receipts: row.installation_id ? store.listDeploymentReceipts(row.installation_id)
                .filter(receipt => receipt.deviceId === id.deviceId) : [],
            },
            publication: { status: 'not_requested' }, deployment: { status: 'not_requested' } };
        });
        const result = { snapshotId: snapshot.id, stage: 'draft', restoreMode: 'drafts', skills: restored,
          publication: { status: 'not_requested' }, deployment: { status: 'not_requested' } };
        recordRequest(id, replayed, result);
        return result;
      });
    },

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

    create(id, input) {
      const name = input.name;
      const nameErr = U.validateName(name);
      if (nameErr) throw error('INVALID_ARGUMENT', nameErr);
      if (input.expectedRevision !== null) throw error('INVALID_ARGUMENT', 'create requires expectedRevision null');
      const catErr = U.validateCategory(input.category ?? null);
      if (catErr) throw error('INVALID_ARGUMENT', catErr);
      if (managedRow(id, name)) throw error('REVISION_CONFLICT', `Skill '${name}' already exists`);
      let files;
      if (input.files !== undefined) {
        files = normalizeFilesMap(input.files);
        for (const [key, value] of Object.entries(files)) if (value === null) delete files[key];
      } else {
        files = { 'SKILL.md': String(input.content ?? '') };
      }
      if (typeof files['SKILL.md'] !== 'string') throw error('VALIDATION_FAILED', 'files must include SKILL.md');
      const fmErr = validateSkillMd(files['SKILL.md']);
      if (fmErr) throw error('VALIDATION_FAILED', fmErr);
      if (input.description !== undefined) files['SKILL.md'] = rewriteDescription(files['SKILL.md'], input.description);
      return tx(() => {
        const row = { id: randomUUID(), head_rev: 0, revision: 0, installation_id: null, package_id: null, published_rev: null, json: '{}' };
        const committed = commitRevision(row, files, { origin: id.origin, requestId: id.requestId });
        stmts.insertSkill.run(row.id, id.deviceId, id.botId, name, committed.fmName, input.category?.trim() || null,
          committed.revision, committed.rev, null, null, null, 'managed', '{}', now(), now());
        usageMutate(id, name, (rec) => U.recordCreatedApply(rec, AUTONOMOUS_ORIGINS.has(id.origin)));
        return { ...summarizeSkill(id, stmts.skillById.get(row.id)), files };
      });
    },

    update(id, input) {
      const row = requireSkill(id, input);
      assertRevision(input.expectedRevision, row.revision);
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
      if (typeof files['SKILL.md'] !== 'string') throw error('VALIDATION_FAILED', 'A managed skill must keep a SKILL.md');
      const fmErr = validateSkillMd(files['SKILL.md']);
      if (fmErr) throw error('VALIDATION_FAILED', fmErr);
      return tx(() => {
        const committed = commitRevision(row, files, { origin: id.origin, requestId: id.requestId });
        usageMutate(id, row.name, (rec) => U.bumpPatchApply(rec));
        const updated = stmts.skillById.get(row.id);
        return { ...summarizeSkill(id, updated), contentRevision: committed.rev, files };
      });
    },

    async delete(id, input) {
      const row = requireSkill(id, input);
      assertRevision(input.expectedRevision, row.revision);
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
      assertRevision(input.expectedRevision, usage.revision);
      if (usage.record?.state === U.STATE_ARCHIVED) return { ...summarizeSkill(id, row), state: U.STATE_ARCHIVED };
      const [ok, msg] = archiveSkillNow(id, row.name, installedList);
      if (!ok) throw error('INVALID_STATE', msg);
      try { await packages.reconcileDevice(id.deviceId); } finally { notify(id.deviceId); }
      return { ...summarizeSkill(id, stmts.skillById.get(row.id)), state: U.STATE_ARCHIVED, archived: msg };
    },

    async restore(id, input, installedList) {
      const row = requireSkill(id, input);
      const usage = usageRow(id, row.name);
      assertRevision(input.expectedRevision, usage.revision);
      const [ok, msg] = restoreSkillNow(id, row.name, installedList);
      if (!ok) throw error('INVALID_STATE', msg);
      try { await packages.reconcileDevice(id.deviceId); } finally { notify(id.deviceId); }
      return { ...summarizeSkill(id, stmts.skillById.get(row.id)), restored: msg };
    },

    pin(id, input, installedList) {
      const row = requireSkill(id, input);
      if (typeof input.pinned !== 'boolean') throw error('INVALID_ARGUMENT', 'pinned must be boolean');
      const usage = usageRow(id, row.name);
      assertRevision(input.expectedRevision, usage.revision);
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
      const usage = usageRow(id, target);
      assertRevision(input.expectedRevision, usage.revision);
      usageMutate(id, target, (rec) => { rec.locked = input.locked; return true; });
      const base = managed ? summarizeSkill(id, managed) : { name: target };
      return { ...base, locked: input.locked, stateRevision: usageRow(id, target).revision };
    },

    history(id, input) {
      const row = requireSkill(id, input);
      return {
        ...summarizeSkill(id, row),
        revisions: stmts.revList.all(row.id).map((rev) => ({
          rev: rev.rev, description: rev.description ?? null, origin: rev.origin ?? null,
          requestId: rev.request_id ?? null, createdAt: rev.created_at,
        })),
      };
    },

    rollback(id, input) {
      const row = requireSkill(id, input);
      assertRevision(input.expectedRevision, row.revision);
      const target = stmts.revGet.get(row.id, input.revision);
      if (!target) throw error('NOT_FOUND', `Revision ${input.revision} not found`);
      const files = JSON.parse(target.files);
      return tx(() => {
        const committed = commitRevision(row, files, { origin: 'rollback', requestId: id.requestId });
        const updated = stmts.skillById.get(row.id);
        return { ...summarizeSkill(id, updated), contentRevision: committed.rev, rolledBackTo: input.revision, files };
      });
    },

    async adopt(id, input, installedList) {
      if (input.expectedRevision !== null) throw error('INVALID_ARGUMENT', 'adopt requires expectedRevision null');
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
      return tx(() => {
        const row = { id: randomUUID(), head_rev: 0, revision: 0, installation_id: null, package_id: null, published_rev: null, json: '{}' };
        const committed = commitRevision(row, files, { origin: 'adopt', requestId: id.requestId });
        stmts.insertSkill.run(row.id, id.deviceId, id.botId, newName, committed.fmName, null,
          committed.revision, committed.rev, null, null, null, 'adopted', json({ from: { installationId: installed.entry.installation.installationId, packageId: installed.entry.installation.packageId, version: installed.entry.installation.targetVersion, dir: installed.skill.dir } }), now(), now());
        usageMutate(id, newName, (rec) => { rec.created_by = 'agent'; return true; });
        return {
          ...summarizeSkill(id, stmts.skillById.get(row.id)), files,
          from: { installationId: installed.entry.installation.installationId, packageId: installed.entry.installation.packageId, version: installed.entry.installation.targetVersion, name: installed.skill.name },
        };
      });
    },

    async publish(id, input) {
      const row = requireSkill(id, input);
      assertRevision(input.expectedRevision, row.revision);
      const usage = usageRow(id, row.name);
      if (usage.record?.state === U.STATE_ARCHIVED) throw error('INVALID_STATE', 'Skill is archived; restore it before publishing');
      const head = stmts.revGet.get(row.id, row.head_rev);
      if (!head) throw error('INVALID_STATE', 'Skill has no content revision');
      const files = JSON.parse(head.files);
      if (typeof files['SKILL.md'] !== 'string') throw error('VALIDATION_FAILED', 'A managed skill must keep a SKILL.md');
      const version = `1.0.${head.rev}`;
      const packageId = `bot-skill-${row.id}`;
      // Package ops dedupe by request_id: deterministic per (skill, rev) ids make a
      // retried publish resume the same queued operations instead of duplicating them.
      const opRequestId = (step) => `skill:${row.id}:${step}:${head.rev}`;

      if (row.published_rev === head.rev && row.installation_id && bindingEnabled(id, row.installation_id)) {
        const installation = store.getInstallation(row.installation_id);
        if (installation?.targetVersion === version) {
          return { ...summarizeSkill(id, row), publication: { installationId: row.installation_id, packageId: row.package_id, version, status: 'enabled', publishedRevision: head.rev } };
        }
      }

      let artifactRef = stmts.artifactGet.get(row.id, head.rev)?.artifact_ref;
      if (!artifactRef) {
        const bytes = await buildArtifact(packageId, version, files, U.descriptionOf(files['SKILL.md']) ?? row.name);
        artifactRef = (await packages.uploadArtifact([bytes])).artifactRef;
        stmts.artifactPut.run(row.id, head.rev, artifactRef);
      }

      let installationId = row.installation_id && store.getInstallation(row.installation_id) ? row.installation_id : null;
      let operationId = null;
      if (!installationId) {
        const receipt = await packages.install({
          kind: 'skill', source: { type: 'artifact', artifactRef }, target: 'host',
          displayName: `Skill: ${row.name}`, requestId: opRequestId('install'),
        });
        operationId = receipt.operationId;
        // Wait (bounded) for the queued install to write the installation row.
        const operation = await waitFor(() => {
          const op = store.getOperation(receipt.operationId);
          return op?.installationId && store.getInstallation(op.installationId) ? op : null;
        }, PUBLISH_WAIT_MS);
        if (!operation) {
          const op = store.getOperation(receipt.operationId);
          const status = op?.phase === 'failed' ? 'failed' : 'queued';
          return { ...summarizeSkill(id, row), publication: { status, operationId, artifactRef, version, error: op?.error ?? undefined } };
        }
        installationId = operation.installationId;
        tx(() => {
          const current = stmts.skillById.get(row.id);
          stmts.updateSkill.run(current.fm_name, current.revision, current.head_rev, installationId, packageId, current.published_rev, current.json, now(), row.id);
        });
      }

      const installation = store.getInstallation(installationId);
      if (installation.targetVersion !== version) {
        const receipt = await packages.update(installationId, {
          targetVersion: version, source: { type: 'artifact', artifactRef }, requestId: opRequestId('update'),
        });
        operationId = receipt.operationId;
      }
      const enabledInstallation = store.getInstallation(installationId);
      if (!enabledInstallation.enabled || enabledInstallation.activation?.status === 'failed') {
        const receipt = await packages.enable(installationId, { requestId: opRequestId('enable') });
        operationId = receipt.operationId;
      }
      // Await bounded METADATA readiness (global activation), never device deployment.
      const ready = await waitFor(() => {
        const current = store.getInstallation(installationId);
        return current && current.targetVersion === version && current.activation?.status === 'enabled' ? current : null;
      }, PUBLISH_WAIT_MS);
      if (!ready) {
        const operation = operationId && store.getOperation(operationId);
        return { ...summarizeSkill(id, stmts.skillById.get(row.id)), publication: { status: operation?.phase === 'failed' ? 'failed' : 'activating', operationId, installationId, packageId, version, artifactRef, error: operation?.error ?? undefined } };
      }
      const capability = store.getBotCapability(id.deviceId, id.botId, installationId);
      if (!capability.enabled) {
        store.putBotCapability(id.deviceId, id.botId, installationId, { enabled: true, overrides: {}, expectedRevision: capability.revision });
      }
      try { await packages.reconcileDevice(id.deviceId); } finally { notify(id.deviceId); }
      tx(() => {
        const current = stmts.skillById.get(row.id);
        stmts.updateSkill.run(current.fm_name, current.revision, current.head_rev, installationId, packageId, head.rev, current.json, now(), row.id);
      });
      const final = stmts.skillById.get(row.id);
      return {
        ...summarizeSkill(id, final),
        publication: { status: 'enabled', operationId, installationId, packageId, version, artifactRef, publishedRevision: head.rev },
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
    const readOnly = ['list', 'read', 'history', 'snapshots'].includes(action);
    if (readOnly) return actions[action](id, input ?? {});
    return enqueue(id, async () => {
      const replayed = replay(id, input, action);
      if (replayed.hit) return replayed.hit;
      const installedList = await installedSkills(id);
      const result = await actions[action](id, input, installedList);
      // A publish that is still queued/activating/failed must NOT pin the request id:
      // an explicit retry resumes the same package operations instead of replaying a stale receipt.
      const pending = result?.publication && !['enabled', 'applied'].includes(result.publication.status);
      if (!pending && action !== 'restore_snapshot') recordRequest(id, replayed, result);
      return result;
    });
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
      const name = managed?.name ?? skill.name;
      return tx(() => {
        bumpUse(id, name);
        const result = { recorded: true, name };
        recordRequest(id, replayed, result);
        return result;
      });
    });
  }

  // --- public hermes() adapter ------------------------------------------------------
  async function hermes(identity, name, args = {}) {
    const id = normalizeIdentity(identity);
    assertBot(id);
    const a = args && typeof args === 'object' ? args : {};
    switch (name) {
      case 'skills_list': return json(await skillsList(id));
      case 'skill_view': return json(await skillView(id, a));
      case 'skill_manage': return skillManage(id, a);
      case 'read_file': return json(await readFileTool(id, a));
      case 'search_files': return json(await searchFilesTool(id, a));
      default: break;
    }
    if (name.startsWith('skill_usage.')) {
      const fn = skillUsageCalls[name.slice('skill_usage.'.length)];
      if (!fn) throw error('INVALID_ARGUMENT', `Unsupported skill_usage call '${name}'`);
      const installedList = await installedSkills(id);
      if (['skill_usage.archive_skill', 'skill_usage.restore_skill', 'skill_usage.set_state'].includes(name)) {
        return enqueue(id, () => reconcileBindingChanges(id, () => tx(() => fn(id, a, installedList))));
      }
      return enqueue(id, () => fn(id, a, installedList));
    }
    if (name.startsWith('skill_provenance.')) {
      const fn = provenanceCalls[name.slice('skill_provenance.'.length)];
      if (!fn) throw error('INVALID_ARGUMENT', `Unsupported skill_provenance call '${name}'`);
      return fn(id, a);
    }
    throw error('INVALID_ARGUMENT', `Unsupported tool '${name}'. Allowed: ${[...HERMES_SKILL_TOOLS.map((t) => t.function.name), 'skill_usage.*', 'skill_provenance.*'].join(', ')}`);
  }

  return {
    execute,
    reportUse,
    hermes,
    HERMES_SKILL_TOOLS,
    async close() {
      closing = true;
      for (const timer of publicationTimers.values()) clearTimeout(timer);
      publicationTimers.clear();
      try { await Promise.allSettled([...queues.values()]); } finally { db.close(); }
    },
  };
}
