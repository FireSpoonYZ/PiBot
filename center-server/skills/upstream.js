// Upstream-faithful helpers for the Hermes skill adapter (tools/skill_manager_tool.py
// and tools/skill_usage.py, pinned at 71736c9f32597bbca9d89cede5aa136e55946b2f).
// Adapted parts are marked ADAPTED: upstream runs on a Hermes filesystem; this module
// works on the center-managed per-Bot skill store.
//
// yaml is resolved through host-core's installed copy (host-core/third-party/pi-skills.js
// already depends on yaml 2.9.0); center-server/package.json is unchanged.

import { createRequire } from 'node:module';

const hostRequire = createRequire(new URL('../../host-core/package.json', import.meta.url));
let yamlModule;
export function yaml() {
  if (!yamlModule) {
    try { yamlModule = hostRequire('yaml'); }
    catch (err) {
      throw Object.assign(new Error("The 'yaml' dependency is required for SKILL.md frontmatter parsing (resolved via host-core)"), { code: 'INTERNAL_ERROR', cause: err });
    }
  }
  return yamlModule;
}

// --- Limits (tools/skill_manager_tool.py) ---
export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_CONTENT_CHARS = 100_000;
export const MAX_SKILL_FILE_BYTES = 1_048_576;
export const SKILL_PROMPT_DESC_LIMIT = 60;          // agent/curator.py + learn_prompt.py: index shows 60 chars
export const ALLOWED_SUBDIRS = new Set(['references', 'templates', 'scripts', 'assets']);
export const MAX_SKILL_FILES = 128;
export const MAX_SKILL_TOTAL_BYTES = 4 * 1_048_576;
export const MAX_PATH_CHARS = 240;

export const STATE_ACTIVE = 'active';
export const STATE_STALE = 'stale';
export const STATE_ARCHIVED = 'archived';
export const VALID_STATES = new Set([STATE_ACTIVE, STATE_STALE, STATE_ARCHIVED]);

const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const NAME_RULE = 'Use lowercase letters, numbers, hyphens, dots, and underscores.';
const FRONTMATTER_END_RE = /\n---\s*\n/;

// Error dict (tools.skill_manager_guards._refusal): tool failures are DATA, not throws.
export function refusal(message, extra) {
  return { success: false, error: message, ...(extra || {}) };
}

// --- Validation ---
export function validateName(name) {
  if (!name) return 'Skill name is required.';
  if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
    return `Skill name exceeds ${MAX_NAME_LENGTH} characters.`;
  }
  return VALID_NAME_RE.test(name) ? null : `Invalid skill name '${name}'. ${NAME_RULE} Must start with a letter or digit.`;
}

export function validateCategory(category) {
  if (category === null || category === undefined || (typeof category === 'string' && !category.trim())) return null;
  if (typeof category !== 'string') return 'Category must be a string.';
  const value = category.trim();
  const invalid = `Invalid category '${value}'. ${NAME_RULE} Categories must be a single directory name.`;
  if (value.includes('/') || value.includes('\\')) return invalid;
  if (value.length > MAX_NAME_LENGTH) return `Category exceeds ${MAX_NAME_LENGTH} characters.`;
  return VALID_NAME_RE.test(value) ? null : invalid;
}

/** Extract the YAML frontmatter block + body of a SKILL.md text (BOM tolerant). */
export function splitFrontmatter(content) {
  const text = String(content ?? '').replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return null;
  const end = FRONTMATTER_END_RE.exec(text.slice(3));
  if (!end) return null;
  const yamlText = text.slice(3, 3 + end.index);
  const body = text.slice(3 + end.index + end[0].length);
  return { yamlText, body };
}

export function parseFrontmatter(content) {
  const parts = splitFrontmatter(content);
  if (!parts) return null;
  try {
    const parsed = yaml().parse(parts.yamlText);
    return { frontmatter: parsed, body: parts.body };
  } catch {
    return { frontmatter: undefined, body: parts.body, parseError: true };
  }
}

export function validateFrontmatter(content) {
  if (!String(content ?? '').trim()) return 'Content cannot be empty.';
  if (!String(content).replace(/^\uFEFF/, '').startsWith('---')) {
    return 'SKILL.md must start with YAML frontmatter (---). See existing skills for format.';
  }
  const parts = splitFrontmatter(content);
  if (!parts) return "SKILL.md frontmatter is not closed. Ensure you have a closing '---' line.";
  let parsed;
  try { parsed = yaml().parse(parts.yamlText); }
  catch (err) { return `YAML frontmatter parse error: ${err.message}`; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'Frontmatter must be a YAML mapping (key: value pairs).';
  }
  for (const field of ['name', 'description']) {
    if (!(field in parsed)) return `Frontmatter must include '${field}' field.`;
  }
  const desc = String(parsed.description);
  if (desc.length > MAX_DESCRIPTION_LENGTH) {
    return `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`;
  }
  if (!parts.body.trim()) {
    return 'SKILL.md must have content after the frontmatter (instructions, procedures, etc.).';
  }
  return null;
}

export function descriptionOf(content) {
  try {
    const parsed = parseFrontmatter(content);
    const desc = parsed?.frontmatter?.description;
    return desc === undefined || desc === null ? null : String(desc).trim().replace(/^['\"]|['\"]$/g, '');
  } catch { return null; }
}

export function descriptionPreview(content) {
  try {
    const parts = splitFrontmatter(content);
    if (!parts) return '';
    return String(yaml().parse(parts.yamlText)?.description ?? '').slice(0, 120);
  } catch { return ''; }
}

export function validateContentSize(content, label = 'SKILL.md') {
  if (String(content ?? '').length > MAX_SKILL_CONTENT_CHARS) {
    return `${label} content is ${String(content).length.toLocaleString('en-US')} characters (limit: ${MAX_SKILL_CONTENT_CHARS.toLocaleString('en-US')}). ` +
      'Consider splitting into a smaller SKILL.md with supporting files in references/ or templates/.';
  }
  return null;
}

export function descriptionBudgetError(content, before) {
  const desc = descriptionOf(content) || '';
  if (desc.length <= SKILL_PROMPT_DESC_LIMIT || (before !== null && before !== undefined && desc === descriptionOf(before))) return null;
  return `Description is ${desc.length} chars; a skill description must fit the ${SKILL_PROMPT_DESC_LIMIT}-char skill index (one sentence, trigger first, ends with a period, without repeating the category name). The index clips anything longer. Move detail into the skill body.`;
}

/**
 * Supporting-file path validation (upstream _validate_file_path): relative, no traversal,
 * 'SKILL.md' at the root, or under references/ templates/ scripts/ assets/.
 * Returns {path} normalized or {error}.
 */
export function checkFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return { error: 'file_path is required.' };
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.some((part) => part === '..')) return { error: "Path traversal ('..') is not allowed." };
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return { error: 'Absolute paths are not allowed.' };
  if (parts.length && parts[parts.length - 1] === 'SKILL.md' && parts.length <= 2) {
    return { path: parts.join('/') };
  }
  if (!parts.length || !ALLOWED_SUBDIRS.has(parts[0])) {
    return { error: `File must be under one of: ${[...ALLOWED_SUBDIRS].sort().join(', ')}. Got: '${filePath}'` };
  }
  if (parts.length < 2) {
    return { error: `Provide a file path, not just a directory. Example: '${parts[0]}/myfile.md'` };
  }
  const joined = parts.join('/');
  if (joined.length > MAX_PATH_CHARS) return { error: 'Path is too long.' };
  if (parts.some((part) => /^[.]+$/.test(part)) || /[\u0000-\u001f]/.test(joined)) {
    return { error: `Invalid file path '${filePath}'.` };
  }
  return { path: joined };
}

/** Storage-side path check for whole-file maps (execute files): same confinement rules. */
export function checkStoragePath(path) {
  if (typeof path !== 'string' || !path) return { error: 'Invalid file path' };
  if (path === 'SKILL.md') return { path };
  return checkFilePath(path);
}

export function clip(text, n, ellipsis) {
  const value = String(text ?? '');
  return value.slice(0, n) + (value.length > n ? ellipsis : '');
}

/**
 * ADAPTED patch matching: upstream uses tools.fuzzy_match.fuzzy_find_and_replace (not
 * vendored); here an EXACT substring match. A failed match returns a shaped error the
 * caller augments with file_preview — upstream fuzzy hints are not reproduced.
 * Returns {newContent, count} or {error}.
 */
export function findAndReplace(content, oldString, newString, replaceAll) {
  // An empty needle would match at index 0 forever (index+0 never advances) — refuse it outright.
  if (typeof oldString !== 'string' || oldString.length === 0) {
    return { error: 'old_string is required for a targeted patch (or pass content for a full rewrite).' };
  }
  if (oldString === newString) {
    return { error: 'old_string and new_string are identical; nothing to change.' };
  }
  const haystack = String(content);
  const needle = oldString;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) { count += 1; index = haystack.indexOf(needle, index + needle.length); }
  if (!count) {
    return { error: `old_string not found in the file (exact match required). Read the current content with skill_view() and retry.`, count: 0 };
  }
  if (count > 1 && !replaceAll) {
    return { error: `old_string appears ${count} times; provide more context for a unique match, or set replace_all=true.`, count };
  }
  const replaced = replaceAll ? haystack.split(needle).join(String(newString)) : haystack.replace(needle, String(newString));
  return { newContent: replaced, count: replaceAll ? count : 1 };
}

// --- Usage records (tools/skill_usage.py) ---
const nowIso = () => new Date().toISOString();
export { nowIso };

export function emptyRecord() {
  return {
    created_by: null, use_count: 0, view_count: 0, last_used_at: null, last_viewed_at: null,
    patch_count: 0, patch_generation: 0, last_reused_patch_generation: 0, last_patched_at: null,
    created_at: nowIso(), state: STATE_ACTIVE, pinned: false, archived_at: null,
    first_seen_at: null, locked: false,
  };
}

export function backfilled(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return emptyRecord();
  const result = { ...record };
  for (const [key, value] of Object.entries(emptyRecord())) {
    if (!(key in result)) result[key] = value;
  }
  return result;
}

const intOrZero = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const nonNegativeInt = (value) => Math.max(0, intOrZero(value));

export function latestActivityAt(record) {
  const stamps = [record?.last_used_at, record?.last_viewed_at, record?.last_patched_at]
    .filter(Boolean).map((value) => Date.parse(value)).filter((v) => Number.isFinite(v));
  if (!stamps.length) return null;
  return new Date(Math.max(...stamps)).toISOString();
}

export function activityCount(record) {
  return intOrZero(record?.use_count) + intOrZero(record?.view_count) + intOrZero(record?.patch_count);
}

export function reportRow(name, raw, extra) {
  const row = { name, ...backfilled(raw), ...(extra || {}) };
  row.last_activity_at = latestActivityAt(row);
  row.activity_count = activityCount(row);
  return row;
}

export function isCuratorManagedRecord(record) {
  return Boolean(record && typeof record === 'object' && (record.created_by === 'agent' || record.agent_created === true));
}

/** bump_use (record + lifecycle facts shape of upstream _mutate_and_emit). */
export function bumpUseApply(record) {
  const uses = nonNegativeInt(record.use_count);
  const gen = nonNegativeInt(record.patch_generation);
  const lastReused = Math.min(nonNegativeInt(record.last_reused_patch_generation), gen);
  const reuseAfterPatch = uses > 0 && gen > lastReused;
  Object.assign(record, {
    use_count: uses + 1, last_used_at: nowIso(), patch_generation: gen,
    last_reused_patch_generation: reuseAfterPatch ? gen : lastReused,
  });
  return { created_by: record.created_by, use_count: uses + 1, reused: uses > 0, reuse_after_patch: reuseAfterPatch };
}

export function bumpPatchApply(record) {
  record.patch_count = nonNegativeInt(record.patch_count) + 1;
  record.last_patched_at = nowIso();
  record.patch_generation = nonNegativeInt(record.patch_generation) + 1;
  return { created_by: record.created_by };
}

/** record_created: resets the record (a create is a new logical skill). */
export function recordCreatedApply(record, agentCreated) {
  for (const key of Object.keys(record)) delete record[key];
  Object.assign(record, emptyRecord(), { created_by: agentCreated ? 'agent' : 'learn' });
  return { created_by: record.created_by };
}

/** set_state transition incl. archived_at bookkeeping. */
export function setStateApply(record, state) {
  const previous = record.state;
  if (previous !== state) {
    record.state = state;
    if (state !== STATE_STALE) record.archived_at = state === STATE_ARCHIVED ? nowIso() : null;
  }
  return { changed: previous !== state, created_by: record.created_by, previous_state: previous };
}

/** The result dict every successful skill_manage write returns (upstream tool JSON). */
export function successResult(fields) {
  return { success: true, ...fields };
}

export function addDescriptionPromptPreview(result, content) {
  const desc = descriptionOf(content);
  if (desc !== null && desc.length > SKILL_PROMPT_DESC_LIMIT) {
    result.system_prompt_preview = 'System prompt will show: "' + clip(desc, SKILL_PROMPT_DESC_LIMIT, '…') + '" — shorten the ' +
      'description to ' + SKILL_PROMPT_DESC_LIMIT + ' chars so the index shows all of it.';
  }
  return result;
}
