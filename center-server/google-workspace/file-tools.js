// Center-side Google Drive, Docs, and Sheets MCP tool definitions.
// Delegates all Google API business logic to upstream Orca domain functions loaded via loadOrca()
// (stablyai/orca MIT), preserving upstream ref parsing, output limits, and attribution semantics.
// Center never reads or writes user filesystem paths; binary files for drive_upload / drive_download
// are staged and written exclusively on the trusted Host via host-core/google-file-transfer.js.

import { loadOrca } from './orca-domain.js';

// Upstream paired-request and output-limit constants (stablyai/orca MIT):
// REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES = 1 MiB, sealing overhead = 128 B,
// request envelope reserve = 4 KiB => PAIRED_REQUEST_PARAMS_MAX_BYTES = 782,208 B.
// DRIVE_UPLOAD_MAX_BYTES = floor((782,208 - 4,096) / 4) * 3 = 583,584 B (~570 KB).
export const PAIRED_REQUEST_PARAMS_MAX_BYTES = 782_208;
export const DRIVE_UPLOAD_MAX_BYTES = 583_584;
export const TOOL_DOWNLOAD_MAX_BYTES = 2_900_000;
export const ASKED_BY_MAX_CHARS = 140;

const REF_MAX_CHARS = 2_048;
const PAGE_TOKEN_MAX_CHARS = 2_048;
const NAME_MAX_CHARS = 1_024;
const QUERY_MAX_CHARS = 500;
const TAB_MAX_CHARS = 200;
const KEY_MAX_CHARS = 200;
const EMAIL_MAX_CHARS = 320;
const COMMENT_MAX_CHARS = 1_900;
const REPLACE_TEXT_MAX_CHARS = 10_000;
const REPLACE_MAX_PAIRS = 500;
const SHARE_MAX_RECIPIENTS = 50;
const SHEET_MAX_ROWS = 20_000;
const SHEET_MAX_COLS = 1_000;
const SHEET_CELL_MAX_CHARS = 50_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const A1_RANGE_RE = /^[A-Za-z]{0,3}\d*(:[A-Za-z]{0,3}\d*)?$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const SHARE_ROLES = new Set(['reader', 'commenter', 'writer']);

const ACCOUNT_SCHEMA = {
  type: 'string',
  maxLength: EMAIL_MAX_CHARS,
  description: 'Optional Google account email when multiple accounts are connected.',
};

const REF_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: REF_MAX_CHARS,
};

const PAGE_TOKEN_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: PAGE_TOKEN_MAX_CHARS,
  description: 'Pagination token from a previous response.',
};

const OFFSET_SCHEMA = {
  type: 'integer',
  minimum: 0,
  description: 'Character offset for reading the next page of a long file or document.',
};

const TAB_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: TAB_MAX_CHARS,
  description: 'Worksheet tab name (defaults to the first tab).',
};

const A1_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  description: 'Cell range in A1 notation without tab prefix (for example A1:F50).',
};

const CELL_SCHEMA = {
  anyOf: [
    { type: 'string', maxLength: SHEET_CELL_MAX_CHARS },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
  ],
};

const ROWS_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: SHEET_MAX_ROWS,
  items: {
    type: 'array',
    maxItems: SHEET_MAX_COLS,
    items: CELL_SCHEMA,
  },
  description: 'Array of rows, for example [["Name","Total"],["Ada",42]].',
};

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function invalid(message) {
  return fail('INVALID_ARGUMENT', message);
}

function assertPlainObject(value, label = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be a JSON object.`);
  }
  return value;
}

function assertAllowedKeys(obj, allowed, label = 'arguments') {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw invalid(`Unexpected parameter "${key}" in ${label}.`);
    }
  }
}

function checkContext(context) {
  const signal = context?.signal;
  signal?.throwIfAborted?.();
  const api = context?.api;
  if (!api || typeof api.get !== 'function' || typeof api.send !== 'function') {
    throw fail('INVALID_STATE', 'Google Workspace API client is unavailable.');
  }
  return { api, signal, askedBy: normalizeAskedBy(context?.askedBy) };
}

function normalizeAskedBy(askedBy) {
  if (typeof askedBy !== 'string') return null;
  const trimmed = askedBy.trim();
  if (!trimmed) return null;
  return trimmed.length <= ASKED_BY_MAX_CHARS
    ? trimmed
    : `${trimmed.slice(0, ASKED_BY_MAX_CHARS - 1)}…`;
}

function withAskedByText(body, askedBy) {
  const line = normalizeAskedBy(askedBy);
  if (!line) return body;
  return body.toLowerCase().includes(line.toLowerCase())
    ? body
    : `${body.trimEnd()}\n\n${line}`;
}

function optionalAccount(args) {
  if (args.account === undefined) return undefined;
  if (typeof args.account !== 'string') throw invalid('account must be a string.');
  const trimmed = args.account.trim();
  if (!trimmed || trimmed.length > EMAIL_MAX_CHARS) {
    throw invalid('account must be a non-empty string up to 320 characters.');
  }
  return trimmed;
}

function requiredTrimmedString(value, field, maxLen, emptyMessage) {
  if (typeof value !== 'string') throw invalid(`${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) throw invalid(emptyMessage ?? `${field} is required.`);
  if (trimmed.length > maxLen) throw invalid(`${field} exceeds ${maxLen} characters.`);
  return trimmed;
}

function optionalTrimmedString(value, field, maxLen, { allowEmpty = false } = {}) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(`${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (allowEmpty) return undefined;
    throw invalid(`${field} must not be empty.`);
  }
  if (trimmed.length > maxLen) throw invalid(`${field} exceeds ${maxLen} characters.`);
  return trimmed;
}

function optionalString(value, field, minLen, maxLen) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(`${field} must be a string.`);
  if (value.length < minLen || value.length > maxLen) {
    throw invalid(`${field} length must be between ${minLen} and ${maxLen} characters.`);
  }
  return value;
}

function optionalBoolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalid(`${field} must be a boolean.`);
  return value;
}

function optionalOffset(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid('offset must be a non-negative integer.');
  }
  return value;
}

function optionalLimit(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw invalid('limit must be an integer between 1 and 50.');
  }
  return value;
}

function requiredRef(value, field = 'ref') {
  return requiredTrimmedString(value, field, REF_MAX_CHARS);
}

function optionalRef(value, field) {
  return optionalTrimmedString(value, field, REF_MAX_CHARS);
}

function validateA1Range(value, required = false) {
  if (value === undefined) {
    if (required) throw invalid('range is required (for example A1:F50).');
    return undefined;
  }
  if (typeof value !== 'string') throw invalid('range must be a string.');
  const trimmed = value.trim();
  if (!A1_RANGE_RE.test(trimmed) || !/[A-Za-z\d]/.test(trimmed)) {
    throw invalid('Give the range as A1:F50, and the tab with tab.');
  }
  return trimmed;
}

function validateMarkdown(value, { requiredNonEmpty = false } = {}) {
  if (typeof value !== 'string') throw invalid('markdown must be a string.');
  if (requiredNonEmpty && value.length === 0) {
    throw invalid('Give the text to add in markdown.');
  }
  if (Buffer.byteLength(value, 'utf8') > PAIRED_REQUEST_PARAMS_MAX_BYTES) {
    throw invalid(`markdown exceeds the ${Math.floor(PAIRED_REQUEST_PARAMS_MAX_BYTES / 1024)} KB limit.`);
  }
  return value;
}

function validateUploadName(value) {
  const name = requiredTrimmedString(value, 'name', NAME_MAX_CHARS);
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.' || name === '..') {
    throw invalid('Upload name must be a plain filename without path separators.');
  }
  return name;
}

function validateUploadBase64(value) {
  if (typeof value !== 'string') throw invalid('Upload data must be a base64 string.');
  const maxEncoded = 4 * Math.ceil(DRIVE_UPLOAD_MAX_BYTES / 3);
  if (value.length > maxEncoded || value.length > PAIRED_REQUEST_PARAMS_MAX_BYTES) {
    throw invalid(`Upload data exceeds the ${Math.floor(DRIVE_UPLOAD_MAX_BYTES / 1024)} KB limit.`);
  }
  if (value.length > 0 && (value.length % 4 !== 0 || !BASE64_RE.test(value))) {
    throw invalid('Upload data must be valid canonical base64.');
  }
  const bytes = value.length === 0 ? Buffer.alloc(0) : Buffer.from(value, 'base64');
  if (bytes.length > DRIVE_UPLOAD_MAX_BYTES) {
    throw invalid(`Upload takes files up to ${Math.floor(DRIVE_UPLOAD_MAX_BYTES / 1024)} KB.`);
  }
  if (bytes.toString('base64') !== value) {
    throw invalid('Upload data must be canonical base64.');
  }
  return value;
}

function validateEmails(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > SHARE_MAX_RECIPIENTS) {
    throw invalid(`with must be a list of 1 to ${SHARE_MAX_RECIPIENTS} email addresses.`);
  }
  const emails = [];
  for (const item of value) {
    if (typeof item !== 'string') throw invalid('Each recipient in with must be an email string.');
    const normalized = item.trim().toLowerCase();
    if (!normalized || normalized.length > EMAIL_MAX_CHARS || !EMAIL_RE.test(normalized)) {
      throw invalid(`Invalid email address in with: ${item}`);
    }
    emails.push(normalized);
  }
  return emails;
}

function validateReplacePairs(args) {
  const hasPairs = args.pairs !== undefined;
  const hasSingle = args.old !== undefined || args.new !== undefined;
  if (hasPairs && hasSingle) {
    throw invalid('Give either pairs or old/new, not both.');
  }
  let rawPairs;
  if (hasPairs) {
    if (!Array.isArray(args.pairs) || args.pairs.length === 0 || args.pairs.length > REPLACE_MAX_PAIRS) {
      throw invalid(`pairs must contain between 1 and ${REPLACE_MAX_PAIRS} replacement entries.`);
    }
    rawPairs = args.pairs;
  } else {
    if (typeof args.old !== 'string' || typeof args.new !== 'string') {
      throw invalid('Give pairs or both old and new strings.');
    }
    rawPairs = [{ old: args.old, new: args.new }];
  }
  const pairs = [];
  for (const entry of rawPairs) {
    assertPlainObject(entry, 'replacement pair');
    assertAllowedKeys(entry, new Set(['old', 'new']), 'replacement pair');
    if (typeof entry.old !== 'string' || entry.old.length === 0 || entry.old.length > REPLACE_TEXT_MAX_CHARS) {
      throw invalid(`Each replacement pair.old must be a non-empty string up to ${REPLACE_TEXT_MAX_CHARS} characters.`);
    }
    if (typeof entry.new !== 'string' || entry.new.length > REPLACE_TEXT_MAX_CHARS) {
      throw invalid(`Each replacement pair.new must be a string up to ${REPLACE_TEXT_MAX_CHARS} characters.`);
    }
    pairs.push({ old: entry.old, new: entry.new });
  }
  return pairs;
}

function validateRows(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > SHEET_MAX_ROWS) {
    throw invalid(
      'values must be a non-empty array of rows (e.g. [["Ada",42]]); one row is [["Ada",42]], not ["Ada",42].'
    );
  }
  for (const row of value) {
    if (!Array.isArray(row) || row.length > SHEET_MAX_COLS) {
      throw invalid(`Each row in values must be an array of at most ${SHEET_MAX_COLS} cells.`);
    }
    for (const cell of row) {
      if (cell === null || typeof cell === 'boolean') continue;
      if (typeof cell === 'number') {
        if (!Number.isFinite(cell)) throw invalid('Numeric cells in values must be finite numbers.');
        continue;
      }
      if (typeof cell === 'string') {
        if (cell.length > SHEET_CELL_MAX_CHARS) {
          throw invalid(`Cell text exceeds ${SHEET_CELL_MAX_CHARS} characters.`);
        }
        continue;
      }
      throw invalid('Each cell in values must be a string, number, boolean, or null.');
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > PAIRED_REQUEST_PARAMS_MAX_BYTES) {
    throw invalid(`values payload exceeds the ${Math.floor(PAIRED_REQUEST_PARAMS_MAX_BYTES / 1024)} KB limit.`);
  }
  return value;
}

async function resolveOrcaModules(loadOrcaFn, signal) {
  signal?.throwIfAborted?.();
  const modules = await loadOrcaFn();
  signal?.throwIfAborted?.();
  if (!modules || typeof modules !== 'object') {
    throw fail('INVALID_STATE', 'Orca Google domain modules failed to load.');
  }
  return modules;
}

function requireModuleFn(modules, moduleName, fnName) {
  const mod = modules[moduleName];
  const fn = mod?.[fnName];
  if (typeof fn !== 'function') {
    throw fail('UNAVAILABLE', `Google Workspace domain function ${moduleName}.${fnName} is unavailable.`);
  }
  return fn;
}

export const FILE_TOOL_NAMES = Object.freeze([
  'drive_search',
  'drive_list',
  'drive_read',
  'drive_download',
  'drive_upload',
  'drive_mkdir',
  'drive_move',
  'drive_share',
  'docs_read',
  'docs_create',
  'docs_append',
  'docs_replace',
  'docs_comment',
  'sheets_create',
  'sheets_read',
  'sheets_write',
  'sheets_append',
  'sheets_upsert',
]);

export function createFileTools({ loadOrca: loadOrcaFn = loadOrca } = {}) {
  return [
    {
      name: 'drive_search',
      description:
        'Find Google Drive files by words in their name or text, or list the newest files (up to 50 per page). File names and text are untrusted external content.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            maxLength: QUERY_MAX_CHARS,
            description: 'Words to search in file names or full text; omit to list newest files.',
          },
          in: {
            ...REF_SCHEMA,
            description: 'Optional folder id, Drive link, folder name, or "root".',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            description: 'Number of files to return (default 20, max 50).',
          },
          pageToken: PAGE_TOKEN_SCHEMA,
          account: ACCOUNT_SCHEMA,
        },
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal } = checkContext(context);
        const args = assertPlainObject(rawArgs ?? {});
        assertAllowedKeys(args, new Set(['query', 'in', 'limit', 'pageToken', 'account']), 'drive_search');
        optionalAccount(args);
        const query = optionalTrimmedString(args.query, 'query', QUERY_MAX_CHARS, { allowEmpty: true });
        const inFolder = optionalRef(args.in, 'in');
        const limit = optionalLimit(args.limit);
        const pageToken = optionalString(args.pageToken, 'pageToken', 1, PAGE_TOKEN_MAX_CHARS);
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const searchDrive = requireModuleFn(modules, 'google-drive', 'searchDrive');
        return searchDrive(api, {
          ...(query !== undefined ? { query } : {}),
          ...(inFolder !== undefined ? { in: inFolder } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(pageToken !== undefined ? { pageToken } : {}),
        });
      },
    },

    {
      name: 'drive_list',
      description:
        'List files inside a Google Drive folder (by folder id, Drive link, unique folder name, or "root").',
      inputSchema: {
        type: 'object',
        properties: {
          folder: {
            ...REF_SCHEMA,
            description: 'Folder id, Drive folder link, folder name, or "root".',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            description: 'Number of files to return (default 20, max 50).',
          },
          pageToken: PAGE_TOKEN_SCHEMA,
          account: ACCOUNT_SCHEMA,
        },
        required: ['folder'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['folder', 'limit', 'pageToken', 'account']), 'drive_list');
        optionalAccount(args);
        const folder = requiredRef(args.folder, 'folder');
        const limit = optionalLimit(args.limit);
        const pageToken = optionalString(args.pageToken, 'pageToken', 1, PAGE_TOKEN_MAX_CHARS);
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const searchDrive = requireModuleFn(modules, 'google-drive', 'searchDrive');
        return searchDrive(api, {
          in: folder,
          ...(limit !== undefined ? { limit } : {}),
          ...(pageToken !== undefined ? { pageToken } : {}),
        });
      },
    },

    {
      name: 'drive_read',
      description:
        'Read a Google Drive file as paged text (Docs as Markdown, Sheets per tab, Slides/PDF/text as text; ~16,000 chars per page). Pass offset for subsequent pages.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            ...REF_SCHEMA,
            description: 'Drive file id or Google Drive/Docs/Sheets link.',
          },
          offset: OFFSET_SCHEMA,
          account: ACCOUNT_SCHEMA,
        },
        required: ['ref'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['ref', 'offset', 'account']), 'drive_read');
        optionalAccount(args);
        const ref = requiredRef(args.ref, 'ref');
        const offset = optionalOffset(args.offset);
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const readDrive = requireModuleFn(modules, 'google-drive-read', 'readDrive');
        return readDrive(api, {
          ref,
          ...(offset !== undefined ? { offset } : {}),
        });
      },
    },

    {
      name: 'drive_download',
      description:
        'Download a Google Drive file (up to 2.9 MB; Google Docs/Sheets/Slides exported as .docx/.xlsx/.pptx) into the Bot workspace on the Host. Optional out specifies a non-existing relative destination path inside the Bot workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            ...REF_SCHEMA,
            description: 'Drive file id or Google Drive/Docs/Sheets link.',
          },
          out: {
            type: 'string',
            minLength: 1,
            maxLength: NAME_MAX_CHARS,
            description:
              'Optional non-existing destination path inside the Bot workspace (handled on Host; never overwrites existing files).',
          },
          account: ACCOUNT_SCHEMA,
        },
        required: ['ref'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        // Host strips `out` before calling Center; Center never writes to filesystem.
        assertAllowedKeys(args, new Set(['ref', 'out', 'account']), 'drive_download');
        optionalAccount(args);
        const ref = requiredRef(args.ref, 'ref');
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const downloadDrive = requireModuleFn(modules, 'google-drive-read', 'downloadDrive');
        return downloadDrive(api, ref);
      },
    },

    {
      name: 'drive_upload',
      description:
        'Upload a local file from the Bot workspace (or attachment://<sha256>) to Google Drive, up to ~570 KB. Pass path on the Host; optionally convert .docx/.txt/.md/.html/.csv/.xlsx/.pptx into Google Workspace formats.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            maxLength: NAME_MAX_CHARS,
            description:
              'Path inside the Bot workspace (or attachment://<sha256> ref) to upload. Staged on Host before sending to Center.',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: NAME_MAX_CHARS,
            description: 'Optional display filename in Drive (defaults to the staged file basename).',
          },
          data: {
            type: 'string',
            maxLength: PAIRED_REQUEST_PARAMS_MAX_BYTES,
            description:
              'Internal base64 file content populated by trusted Host file-transfer staging; models must pass path instead.',
          },
          folder: {
            ...REF_SCHEMA,
            description: 'Optional destination folder id, link, name, or "root".',
          },
          convert: {
            type: 'boolean',
            description: 'Convert supported office/text files into Google Docs, Sheets, or Slides.',
          },
          account: ACCOUNT_SCHEMA,
        },
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal, askedBy } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['path', 'name', 'data', 'folder', 'convert', 'account']), 'drive_upload');
        optionalAccount(args);
        if (args.path !== undefined) {
          throw invalid(
            'Local file paths must be staged on the Host before calling Center; Center never reads filesystem paths.'
          );
        }
        const name = validateUploadName(args.name);
        const data = validateUploadBase64(args.data);
        const folder = optionalRef(args.folder, 'folder');
        const convert = optionalBoolean(args.convert, 'convert');
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const uploadDrive = requireModuleFn(modules, 'google-drive', 'uploadDrive');
        return uploadDrive(api, {
          name,
          data,
          ...(folder !== undefined ? { folder } : {}),
          ...(convert !== undefined ? { convert } : {}),
          askedBy,
        });
      },
    },

    {
      name: 'drive_mkdir',
      description: 'Create a new folder in Google Drive, optionally inside an existing parent folder.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: NAME_MAX_CHARS,
            description: 'Name of the new folder.',
          },
          in: {
            ...REF_SCHEMA,
            description: 'Optional parent folder id, link, name, or "root".',
          },
          account: ACCOUNT_SCHEMA,
        },
        required: ['name'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal, askedBy } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['name', 'in', 'account']), 'drive_mkdir');
        optionalAccount(args);
        const name = requiredTrimmedString(args.name, 'name', NAME_MAX_CHARS);
        const inFolder = optionalRef(args.in, 'in');
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const makeFolder = requireModuleFn(modules, 'google-drive', 'makeFolder');
        return makeFolder(api, {
          name,
          ...(inFolder !== undefined ? { in: inFolder } : {}),
          askedBy,
        });
      },
    },

    {
      name: 'drive_move',
      description: 'Move a Google Drive file into another folder.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            ...REF_SCHEMA,
            description: 'Drive file id or Google Drive/Docs/Sheets link.',
          },
          folder: {
            ...REF_SCHEMA,
            description: 'Destination folder id, link, name, or "root".',
          },
          account: ACCOUNT_SCHEMA,
        },
        required: ['ref', 'folder'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['ref', 'folder', 'account']), 'drive_move');
        optionalAccount(args);
        const ref = requiredRef(args.ref, 'ref');
        const folder = requiredRef(args.folder, 'folder');
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const moveDrive = requireModuleFn(modules, 'google-drive', 'moveDrive');
        return moveDrive(api, { ref, folder });
      },
    },

    {
      name: 'drive_share',
      description:
        'Share a Google Drive file with people by email (role defaults to reader; Google emails recipients unless notify is false).',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            ...REF_SCHEMA,
            description: 'Drive file id or Google Drive/Docs/Sheets link.',
          },
          with: {
            type: 'array',
            minItems: 1,
            maxItems: SHARE_MAX_RECIPIENTS,
            items: { type: 'string', maxLength: EMAIL_MAX_CHARS },
            description: 'Recipient email addresses to share the file with.',
          },
          role: {
            type: 'string',
            enum: ['reader', 'commenter', 'writer'],
            description: 'Access role granted to recipients (defaults to reader).',
          },
          notify: {
            type: 'boolean',
            description: 'Whether Google sends notification emails (defaults to true).',
          },
          account: ACCOUNT_SCHEMA,
        },
        required: ['ref', 'with'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal, askedBy } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['ref', 'with', 'role', 'notify', 'account']), 'drive_share');
        optionalAccount(args);
        const ref = requiredRef(args.ref, 'ref');
        const recipients = validateEmails(args.with);
        const role = args.role === undefined ? 'reader' : args.role;
        if (typeof role !== 'string' || !SHARE_ROLES.has(role)) {
          throw invalid('role must be reader, commenter, or writer.');
        }
        const notify = optionalBoolean(args.notify, 'notify');
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const shareDrive = requireModuleFn(modules, 'google-drive', 'shareDrive');
        return shareDrive(api, {
          ref,
          with: recipients,
          role,
          ...(notify !== undefined ? { notify } : {}),
          askedBy,
        });
      },
    },

    {
      name: 'docs_read',
      description:
        'Read a Google Doc as paged Markdown including inline pending suggestions ([+added+] / [-removed-]) and open comments on the first page.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            ...REF_SCHEMA,
            description: 'Google Doc id or link.',
          },
          offset: OFFSET_SCHEMA,
          account: ACCOUNT_SCHEMA,
        },
        required: ['ref'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['ref', 'offset', 'account']), 'docs_read');
        optionalAccount(args);
        const ref = requiredRef(args.ref, 'ref');
        const offset = optionalOffset(args.offset);
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const readDoc = requireModuleFn(modules, 'google-docs', 'readDoc');
        return readDoc(api, {
          ref,
          ...(offset !== undefined ? { offset } : {}),
        });
      },
    },

    {
      name: 'docs_create',
      description: 'Create a new Google Doc from Markdown, optionally inside a Drive folder.',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            minLength: 1,
            maxLength: NAME_MAX_CHARS,
            description: 'Title of the new Google Doc.',
          },
          markdown: {
            type: 'string',
            maxLength: PAIRED_REQUEST_PARAMS_MAX_BYTES,
            description: 'Initial document body in Markdown (empty string creates an empty doc).',
          },
          folder: {
            ...REF_SCHEMA,
            description: 'Optional destination folder id, link, name, or "root".',
          },
          account: ACCOUNT_SCHEMA,
        },
        required: ['title'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal, askedBy } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['title', 'markdown', 'folder', 'account']), 'docs_create');
        optionalAccount(args);
        const title = requiredTrimmedString(args.title, 'title', NAME_MAX_CHARS);
        const markdown = validateMarkdown(args.markdown ?? '');
        const folder = optionalRef(args.folder, 'folder');
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const createDoc = requireModuleFn(modules, 'google-docs', 'createDoc');
        return createDoc(api, {
          title,
          markdown,
          ...(folder !== undefined ? { folder } : {}),
          askedBy,
        });
      },
    },

    {
      name: 'docs_append',
      description: 'Append formatted Markdown to the end of a Google Doc.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            ...REF_SCHEMA,
            description: 'Google Doc id or link.',
          },
          markdown: {
            type: 'string',
            minLength: 1,
            maxLength: PAIRED_REQUEST_PARAMS_MAX_BYTES,
            description: 'Markdown text to append to the document.',
          },
          account: ACCOUNT_SCHEMA,
        },
        required: ['ref', 'markdown'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['ref', 'markdown', 'account']), 'docs_append');
        optionalAccount(args);
        const ref = requiredRef(args.ref, 'ref');
        const markdown = validateMarkdown(args.markdown, { requiredNonEmpty: true });
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const appendDoc = requireModuleFn(modules, 'google-docs', 'appendDoc');
        return appendDoc(api, { ref, markdown });
      },
    },

    {
      name: 'docs_replace',
      description:
        'Atomically replace exact text in a Google Doc directly or as Docs suggestions (suggest: true). Each old string must appear once unless all: true.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            ...REF_SCHEMA,
            description: 'Google Doc id or link.',
          },
          pairs: {
            type: 'array',
            minItems: 1,
            maxItems: REPLACE_MAX_PAIRS,
            items: {
              type: 'object',
              properties: {
                old: { type: 'string', minLength: 1, maxLength: REPLACE_TEXT_MAX_CHARS },
                new: { type: 'string', maxLength: REPLACE_TEXT_MAX_CHARS },
              },
              required: ['old', 'new'],
              additionalProperties: false,
            },
            description: 'List of exact { old, new } replacements applied atomically.',
          },
          old: {
            type: 'string',
            minLength: 1,
            maxLength: REPLACE_TEXT_MAX_CHARS,
            description: 'Shorthand single exact text to replace when pairs is omitted.',
          },
          new: {
            type: 'string',
            maxLength: REPLACE_TEXT_MAX_CHARS,
            description: 'Replacement text for shorthand old when pairs is omitted.',
          },
          suggest: {
            type: 'boolean',
            description: 'When true, record replacements as Google Docs suggestions.',
          },
          all: {
            type: 'boolean',
            description: 'Allow replacing multiple occurrences of each old string.',
          },
          matchCase: {
            type: 'boolean',
            description: 'Match case strictly when searching for old text.',
          },
          account: ACCOUNT_SCHEMA,
        },
        required: ['ref'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(
          args,
          new Set(['ref', 'pairs', 'old', 'new', 'suggest', 'all', 'matchCase', 'account']),
          'docs_replace'
        );
        optionalAccount(args);
        const ref = requiredRef(args.ref, 'ref');
        const pairs = validateReplacePairs(args);
        const suggest = optionalBoolean(args.suggest, 'suggest');
        const all = optionalBoolean(args.all, 'all');
        const matchCase = optionalBoolean(args.matchCase, 'matchCase');
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const replaceInDoc = requireModuleFn(modules, 'google-docs', 'replaceInDoc');
        return replaceInDoc(api, {
          ref,
          pairs,
          ...(suggest !== undefined ? { suggest } : {}),
          ...(all !== undefined ? { all } : {}),
          ...(matchCase !== undefined ? { matchCase } : {}),
        });
      },
    },

    {
      name: 'docs_comment',
      description:
        'Add a comment to a Google Doc, either anchored to an exact quoted substring (on) or on the whole doc.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            ...REF_SCHEMA,
            description: 'Google Doc id or link.',
          },
          text: {
            type: 'string',
            minLength: 1,
            maxLength: COMMENT_MAX_CHARS,
            description: 'Comment text (max 1,900 characters).',
          },
          on: {
            type: 'string',
            minLength: 1,
            maxLength: REPLACE_TEXT_MAX_CHARS,
            description: 'Optional exact quote in the doc to anchor the comment (must appear once).',
          },
          account: ACCOUNT_SCHEMA,
        },
        required: ['ref', 'text'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal, askedBy } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['ref', 'text', 'on', 'account']), 'docs_comment');
        optionalAccount(args);
        const ref = requiredRef(args.ref, 'ref');
        const text = requiredTrimmedString(args.text, 'text', COMMENT_MAX_CHARS, 'Give the comment in text.');
        const on = optionalString(args.on, 'on', 1, REPLACE_TEXT_MAX_CHARS);
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const commentOnDoc = requireModuleFn(modules, 'google-docs', 'commentOnDoc');
        return commentOnDoc(api, {
          ref,
          text: withAskedByText(text, askedBy),
          ...(on !== undefined ? { on } : {}),
        });
      },
    },

    {
      name: 'sheets_create',
      description: 'Create a new Google Sheet.',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            minLength: 1,
            maxLength: NAME_MAX_CHARS,
            description: 'Title of the new Google Sheet.',
          },
          account: ACCOUNT_SCHEMA,
        },
        required: ['title'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['title', 'account']), 'sheets_create');
        optionalAccount(args);
        const title = requiredTrimmedString(args.title, 'title', NAME_MAX_CHARS);
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const createSheet = requireModuleFn(modules, 'google-sheets', 'createSheet');
        return createSheet(api, title);
      },
    },

    {
      name: 'sheets_read',
      description:
        'Read cells from a Google Sheet tab as a bounded table. Lists tabs and reads the first tab when tab/range are omitted; returns nextRange when rows are held back.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            ...REF_SCHEMA,
            description: 'Google Sheet id or link.',
          },
          tab: TAB_SCHEMA,
          range: A1_SCHEMA,
          account: ACCOUNT_SCHEMA,
        },
        required: ['ref'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['ref', 'tab', 'range', 'account']), 'sheets_read');
        optionalAccount(args);
        const ref = requiredRef(args.ref, 'ref');
        const tab = optionalTrimmedString(args.tab, 'tab', TAB_MAX_CHARS);
        const range = validateA1Range(args.range, false);
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const readSheet = requireModuleFn(modules, 'google-sheets', 'readSheet');
        return readSheet(api, {
          ref,
          ...(tab !== undefined ? { tab } : {}),
          ...(range !== undefined ? { range } : {}),
        });
      },
    },

    {
      name: 'sheets_write',
      description:
        'Overwrite a cell range in a Google Sheet. Strings starting with = + - @ stay literal text unless formulas is true.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            ...REF_SCHEMA,
            description: 'Google Sheet id or link.',
          },
          tab: TAB_SCHEMA,
          range: A1_SCHEMA,
          values: ROWS_SCHEMA,
          formulas: {
            type: 'boolean',
            description: 'Allow strings starting with = + - @ to be interpreted as formulas.',
          },
          account: ACCOUNT_SCHEMA,
        },
        required: ['ref', 'range', 'values'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['ref', 'tab', 'range', 'values', 'formulas', 'account']), 'sheets_write');
        optionalAccount(args);
        const ref = requiredRef(args.ref, 'ref');
        const tab = optionalTrimmedString(args.tab, 'tab', TAB_MAX_CHARS);
        const range = validateA1Range(args.range, true);
        const values = validateRows(args.values);
        const formulas = optionalBoolean(args.formulas, 'formulas');
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const writeSheet = requireModuleFn(modules, 'google-sheets', 'writeSheet');
        return writeSheet(api, {
          ref,
          range,
          values,
          ...(tab !== undefined ? { tab } : {}),
          ...(formulas !== undefined ? { formulas } : {}),
        });
      },
    },

    {
      name: 'sheets_append',
      description:
        'Append rows after the last row of a Google Sheet tab. Strings starting with = + - @ stay literal text unless formulas is true.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            ...REF_SCHEMA,
            description: 'Google Sheet id or link.',
          },
          tab: TAB_SCHEMA,
          values: ROWS_SCHEMA,
          formulas: {
            type: 'boolean',
            description: 'Allow strings starting with = + - @ to be interpreted as formulas.',
          },
          account: ACCOUNT_SCHEMA,
        },
        required: ['ref', 'values'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['ref', 'tab', 'values', 'formulas', 'account']), 'sheets_append');
        optionalAccount(args);
        const ref = requiredRef(args.ref, 'ref');
        const tab = optionalTrimmedString(args.tab, 'tab', TAB_MAX_CHARS);
        const values = validateRows(args.values);
        const formulas = optionalBoolean(args.formulas, 'formulas');
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const appendSheet = requireModuleFn(modules, 'google-sheets', 'appendSheet');
        return appendSheet(api, {
          ref,
          values,
          ...(tab !== undefined ? { tab } : {}),
          ...(formulas !== undefined ? { formulas } : {}),
        });
      },
    },

    {
      name: 'sheets_upsert',
      description:
        'Update rows in a Google Sheet whose key column (header from row 1 or column letter) matches, or append new rows. Rows are full rows starting at column A.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            ...REF_SCHEMA,
            description: 'Google Sheet id or link.',
          },
          key: {
            type: 'string',
            minLength: 1,
            maxLength: KEY_MAX_CHARS,
            description: 'Header name from row 1 or column letter (for example Email or B).',
          },
          tab: TAB_SCHEMA,
          values: ROWS_SCHEMA,
          formulas: {
            type: 'boolean',
            description: 'Allow strings starting with = + - @ to be interpreted as formulas.',
          },
          account: ACCOUNT_SCHEMA,
        },
        required: ['ref', 'key', 'values'],
        additionalProperties: false,
      },
      async run(rawArgs, context) {
        const { api, signal } = checkContext(context);
        const args = assertPlainObject(rawArgs);
        assertAllowedKeys(args, new Set(['ref', 'key', 'tab', 'values', 'formulas', 'account']), 'sheets_upsert');
        optionalAccount(args);
        const ref = requiredRef(args.ref, 'ref');
        const key = requiredTrimmedString(args.key, 'key', KEY_MAX_CHARS);
        const tab = optionalTrimmedString(args.tab, 'tab', TAB_MAX_CHARS);
        const values = validateRows(args.values);
        const formulas = optionalBoolean(args.formulas, 'formulas');
        const modules = await resolveOrcaModules(loadOrcaFn, signal);
        const upsertSheet = requireModuleFn(modules, 'google-sheets', 'upsertSheet');
        return upsertSheet(api, {
          ref,
          key,
          values,
          ...(tab !== undefined ? { tab } : {}),
          ...(formulas !== undefined ? { formulas } : {}),
        });
      },
    },
  ];
}

export const fileTools = createFileTools();
