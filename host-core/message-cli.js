import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { openMessageLog } from './messages.js';
import { invalid, readInputObject } from './cli-input.js';

const USAGE = `usage: node host-core/message-cli.js <scope|get-scope|scopes|publish|get|receive|ack|history|inbox|outbox|delivery|stream> [options]

commands:
  scope             install a scope definition; requires --input
  get-scope         print a scope; requires --scope-id [--revision]
  scopes            print all installed scopes
  publish           publish a message; requires --input
  get               print one stored message; requires --message-id
  receive           receive an envelope; requires --peer-device-id --input
  ack              acknowledge delivery; requires --peer-device-id --input
  history           list history of a scope; requires --scope-id [--limit] [--cursor]
  inbox             list a bot's inbox; requires --bot-id [--scope-id] [--limit] [--cursor]
  outbox            list pending outbox; [--scope-id] [--target-device-id] [--limit] [--cursor]
  delivery          print delivery status; requires --message-id
  stream            print stream status; requires --scope-id --revision --source-device-id

options:
  --data-root <dir>       verified absolute data directory (required, except help)
  --input <file>          input JSON file: max 1MiB, UTF-8, a single plain object (never stdin)
  --scope-id <id>
  --revision <int>        positive safe integer
  --message-id <id>
  --peer-device-id <id>   peer device id asserted by the trusted calling adapter
  --bot-id <id>
  --target-device-id <id>
  --source-device-id <id> source device id for stream status
  --limit <int>           strict decimal integer between 1 and 200
  --cursor <json>         JSON object cursor
  -h, --help              show this help

receive/ack are privileged OFFLINE adapter interfaces for this Host's trusted local adapters
only. --peer-device-id is a caller-asserted peer identity, not cryptographic network
authentication; it does not by itself verify the remote peer. No automatic delivery, retry,
polling, or model wake-up is performed.
`;

const OPTIONS = {
  'data-root': { type: 'string' },
  input: { type: 'string' },
  'scope-id': { type: 'string' },
  revision: { type: 'string' },
  'message-id': { type: 'string' },
  'peer-device-id': { type: 'string' },
  'bot-id': { type: 'string' },
  'target-device-id': { type: 'string' },
  'source-device-id': { type: 'string' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const REQUIRED = {
  scope: ['data-root', 'input'],
  'get-scope': ['data-root', 'scope-id'],
  scopes: ['data-root'],
  publish: ['data-root', 'input'],
  get: ['data-root', 'message-id'],
  receive: ['data-root', 'peer-device-id', 'input'],
  ack: ['data-root', 'peer-device-id', 'input'],
  history: ['data-root', 'scope-id'],
  inbox: ['data-root', 'bot-id'],
  outbox: ['data-root'],
  delivery: ['data-root', 'message-id'],
  stream: ['data-root', 'scope-id', 'revision', 'source-device-id'],
};

// 仅这些可选选项对该命令合法；其余已声明选项若出现即为无关选项。
const ALLOWED_EXTRA = {
  'get-scope': ['revision'],
  history: ['limit', 'cursor'],
  inbox: ['scope-id', 'limit', 'cursor'],
  outbox: ['scope-id', 'target-device-id', 'limit', 'cursor'],
};

function parseLimit(value) {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 200) {
    throw invalid('--limit must be a strict decimal positive integer between 1 and 200');
  }
  return Number(value);
}

function parseRevision(value) {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw invalid('--revision must be a positive safe integer');
  }
  return Number(value);
}

function parseCursor(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalid('--cursor must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('--cursor must be a JSON object');
  }
  return parsed;
}

function pageOptions(values) {
  const options = {};
  if (values.limit !== undefined) options.limit = parseLimit(values.limit);
  if (values.cursor !== undefined) options.cursor = parseCursor(values.cursor);
  return options;
}

function parseArgv() {
  const argv = process.argv.slice(2);
  const hasCommand = argv.length > 0 && !argv[0].startsWith('-');
  const command = hasCommand ? argv[0] : undefined;
  let values;
  try {
    ({ values } = parseArgs({
      args: hasCommand ? argv.slice(1) : argv,
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw invalid(err.message);
  }
  return { command, values };
}

function main() {
  const { command, values } = parseArgv();
  const knownCommand = Object.hasOwn(REQUIRED, command);
  if (values.help) {
    if (command !== undefined && !knownCommand) {
      throw invalid(`unknown command: ${command}`);
    }
    process.stdout.write(USAGE);
    return;
  }
  if (!knownCommand) {
    throw invalid(`unknown command: ${command ?? '(none)'}`);
  }
  for (const key of REQUIRED[command]) {
    if (values[key] === undefined) {
      throw invalid(`missing required option --${key}`);
    }
  }
  const allowed = new Set([...REQUIRED[command], ...(ALLOWED_EXTRA[command] ?? [])]);
  for (const key of Object.keys(values)) {
    if (key !== 'help' && values[key] !== undefined && !allowed.has(key)) {
      throw invalid(`${command} does not take --${key}`);
    }
  }

  // 纯参数解析全部发生在 openMessageLog 之前；坏输入文件/数字不会先创建数据目录。
  const input =
    command === 'scope' || command === 'publish' || command === 'receive' || command === 'ack'
      ? readInputObject(values.input)
      : null;
  const revision = values.revision !== undefined ? parseRevision(values.revision) : undefined;
  const page = command === 'history' || command === 'inbox' || command === 'outbox' ? pageOptions(values) : undefined;
  const outboxOptions =
    command === 'outbox'
      ? {
          ...page,
          ...(values['scope-id'] !== undefined ? { scopeId: values['scope-id'] } : {}),
          ...(values['target-device-id'] !== undefined ? { targetDeviceId: values['target-device-id'] } : {}),
        }
      : undefined;

  let log = null;
  let workError = null;
  try {
    log = openMessageLog({ dataRoot: values['data-root'] });
    let result;
    switch (command) {
      case 'scope':
        result = log.installScope(input);
        break;
      case 'get-scope':
        result = log.getScope(values['scope-id'], revision);
        break;
      case 'scopes':
        result = log.listScopes();
        break;
      case 'publish':
        result = log.publish(input);
        break;
      case 'get':
        result = log.getMessage(values['message-id']);
        break;
      case 'receive':
        result = log.receive({ deviceId: values['peer-device-id'] }, input);
        break;
      case 'ack':
        result = log.acknowledge({ deviceId: values['peer-device-id'] }, input);
        break;
      case 'history':
        result = log.history(values['scope-id'], page);
        break;
      case 'inbox':
        result = log.inbox(values['bot-id'], { ...page, scopeId: values['scope-id'] });
        break;
      case 'outbox':
        result = log.outbox(outboxOptions);
        break;
      case 'delivery':
        result = log.deliveryStatus(values['message-id']);
        break;
      case 'stream':
        result = log.streamStatus(values['scope-id'], revision, values['source-device-id']);
        break;
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (err) {
    workError = err;
    throw err;
  } finally {
    if (log !== null) {
      try {
        log.close();
      } catch (cleanupErr) {
        if (workError === null) throw cleanupErr;
      }
    }
  }
}

// 仅被直接运行（node host-core/message-cli.js）时解析 CLI；被 import 时不解析、不开数据、不改 exitCode。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    const code = typeof err?.code === 'string' ? err.code : err instanceof TypeError ? 'INVALID_ARGUMENT' : 'INTERNAL';
    process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  }
}
