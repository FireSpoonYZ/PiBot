import { parseArgs } from 'node:util';
import { openHost } from './host.js';

const USAGE = `usage: node host-core/cli.js <init|create|list|get|find-request> [options]

commands:
  init             print {deviceId, dataRoot}
  create           register a bot; requires --request-id --role --cwd
  list             print all bot records
  get              print one bot; requires --bot-id
  find-request     print bot by request; requires --request-id

options:
  --data-root <dir>   verified absolute data directory (required, except --help)
  --request-id <id>
  --role <text>
  --cwd <dir>
  --bot-id <id>
  -h, --help          show this help
`;

const OPTIONS = {
  'data-root': { type: 'string' },
  'request-id': { type: 'string' },
  role: { type: 'string' },
  cwd: { type: 'string' },
  'bot-id': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const REQUIRED = {
  init: ['data-root'],
  create: ['data-root', 'request-id', 'role', 'cwd'],
  list: ['data-root'],
  get: ['data-root', 'bot-id'],
  'find-request': ['data-root', 'request-id'],
};

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

function main() {
  const argv = process.argv.slice(2);
  const hasCommand = argv.length > 0 && !argv[0].startsWith('-');
  const command = hasCommand ? argv[0] : undefined;
  let values;
  try {
    ({ values } = parseArgs({ args: hasCommand ? argv.slice(1) : argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (err) {
    throw invalid(err.message);
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!Object.hasOwn(REQUIRED, command)) {
    throw invalid(`unknown command: ${command ?? '(none)'}`);
  }
  for (const key of REQUIRED[command]) {
    if (values[key] === undefined) {
      throw invalid(`missing required option --${key}`);
    }
  }
  const host = openHost({ dataRoot: values['data-root'] });
  let result;
  try {
    switch (command) {
      case 'init':
        result = { deviceId: host.deviceId, dataRoot: host.dataRoot };
        break;
      case 'create':
        result = host.createBot({
          requestId: values['request-id'],
          role: values.role,
          cwd: values.cwd,
        });
        break;
      case 'list':
        result = host.listBots();
        break;
      case 'get':
        result = host.getBot(values['bot-id']);
        break;
      case 'find-request':
        result = host.findByRequest(values['request-id']);
        break;
    }
  } finally {
    host.close();
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

try {
  main();
} catch (err) {
  const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
  process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
  process.exitCode = 1;
}
