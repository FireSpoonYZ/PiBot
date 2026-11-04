// 模块 8：relay.sqlite 注册表 CLI。init/list/get/register/rotate/revoke 均为本地
// 所有者命令；token 只从环境变量读取（--token-env NAME），绝不走参数、stdout、
// 错误或哈希。输出/错误均为单行 JSON，错误退出码 1。
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { openRelayRegistry } from './relay-registry.js';
import { assertId } from './message-protocol.js';
import { assertDeviceToken } from './relay-protocol.js';
import { normalizeDeviceName } from './device-metadata.js';

const USAGE = `usage: node host-core/relay-registry-cli.js <init|list|get|register|rotate|revoke> [options]

commands:
  init       initialize the relay registry database; requires --data-root
  list       list registered devices; requires --data-root
  get        show one device; requires --data-root --device-id
  register   register a device credential; requires --data-root --device-id --token-env
  rotate     rotate a device credential; requires --data-root --device-id --token-env
  revoke     revoke a device credential; requires --data-root --device-id

options:
  --data-root <dir>   verified absolute data directory (required, except help)
  --device-id <id>     device identifier
  --display-name <name>  initial display name for register (optional)
  --token-env <name>   environment variable holding the device token (never a flag value)
  -h, --help           show this help
`;

const OPTIONS = {
  'data-root': { type: 'string' },
  'device-id': { type: 'string' },
  'token-env': { type: 'string' },
  'display-name': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const REQUIRED = {
  init: ['data-root'],
  list: ['data-root'],
  get: ['data-root', 'device-id'],
  register: ['data-root', 'device-id', 'token-env'],
  rotate: ['data-root', 'device-id', 'token-env'],
  revoke: ['data-root', 'device-id'],
};

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
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
  const allowed = new Set(REQUIRED[command]);
  if (command === 'register') allowed.add('display-name');
  for (const key of Object.keys(values)) {
    if (key !== 'help' && values[key] !== undefined && !allowed.has(key)) {
      throw invalid(`${command} does not take --${key}`);
    }
  }

  // 纯参数/env 校验全部发生在打开数据目录之前：坏 ID/token 不会创建数据库。
  const deviceId = values['device-id'];
  if (deviceId !== undefined) {
    assertId(deviceId, 'deviceId');
  }
  if (values['display-name'] !== undefined) normalizeDeviceName(values['display-name']);
  let token = null;
  if (values['token-env'] !== undefined) {
    const name = values['token-env'];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw invalid('--token-env must be a valid environment variable name');
    }
    token = process.env[name];
    if (token === undefined) {
      throw invalid(`environment variable ${name} is not set`);
    }
    assertDeviceToken(token);
  }

  let registry = null;
  let workError = null;
  try {
    registry = openRelayRegistry({ dataRoot: values['data-root'] });
    let result;
    switch (command) {
      case 'init':
        result = { dataRoot: registry.dataRoot, protocolVersion: 1 };
        break;
      case 'list':
        result = registry.list();
        break;
      case 'get':
        result = registry.get(deviceId);
        break;
      case 'register':
        result = registry.register({ deviceId, token, ...(values['display-name'] !== undefined ? { displayName: values['display-name'] } : {}) });
        break;
      case 'rotate':
        result = registry.rotate({ deviceId, token });
        break;
      case 'revoke':
        result = registry.revoke(deviceId);
        break;
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (err) {
    workError = err;
    throw err;
  } finally {
    if (registry !== null) {
      try {
        registry.close();
      } catch (cleanupErr) {
        if (workError === null) throw cleanupErr;
      }
    }
  }
}

// 仅被直接运行（node host-core/relay-registry-cli.js）时解析 CLI；被 import 时不解析、不开数据、不改 exitCode。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    const code = typeof err?.code === 'string' ? err.code : err instanceof TypeError ? 'INVALID_ARGUMENT' : 'INTERNAL';
    process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  }
}
