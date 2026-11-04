// host-core/pending-cli.js
//
// Module 14 客户端待发送 CLI：作用于客户端自己的绝对状态目录（非 Host 数据）。
// enqueue/get/list 完全离线（不读凭证 env、不连接、不要求 transport flags）；
// send/reconcile 必须显式指定一种传输：本机 loopback 控制服务（--local-url）
// 或已认证 relay（--url）。传输连接懒到首次实际送达才打开，accepted 重复
// send 不会连接；取消只中止当前传输/观察，绝不发送 abort 控制方法。
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { openPendingClient } from './pending-client.js';
import { createLocalControlAdapter } from './local-control-adapter.js';
import { openRemoteControl } from './remote-control-client.js';
import { invalid, readTextFile, readInputObject } from './cli-input.js';
import { assertId } from './message-protocol.js';

const USAGE = `usage: node host-core/pending-cli.js <enqueue|get|list|send|reconcile|cancel> --data-root <dir> --device-id <id> [options]

commands:
  enqueue        queue a client message/request; requires --input
  get            print one pending record by id; requires --id (prints null when absent)
  list           list pending records; [--state] [--limit] [--cursor]
  send           explicitly send one pending record; requires --id and exactly one transport
  reconcile      read-only reconcile one pending record; requires --id and exactly one transport
  cancel         locally cancel one queued pending record; requires --id

options:
  --data-root <dir>       absolute client-state directory (required)
  --device-id <id>        explicit local device id (required)
  --input <file>          enqueue input JSON file: max 1MiB, UTF-8, a single plain object
  --id <uuid>             pending record id
  --state <state>         list filter: pending|sending|unconfirmed|accepted|rejected
  --limit <int>           list limit, strict decimal 1..200 (default 20)
  --cursor <json>         list keyset cursor {deviceId,state,afterId}
  --local-url <url>       local transport: http://127.0.0.1 or http://[::1] (with --token-env)
  --url <url>             relay transport: ws(s)://.../v1/link (with --token-env [--ca])
  --token-env <name>      environment variable holding the transport token (required for send/reconcile)
  --ca <file>             custom CA bundle PEM file for relay (optional)
  -h, --help              show this help
`;

const OPTIONS = {
  'data-root': { type: 'string' },
  'device-id': { type: 'string' },
  input: { type: 'string' },
  id: { type: 'string' },
  state: { type: 'string' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  'local-url': { type: 'string' },
  url: { type: 'string' },
  'token-env': { type: 'string' },
  ca: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const REQUIRED = {
  enqueue: ['data-root', 'device-id', 'input'],
  get: ['data-root', 'device-id', 'id'],
  list: ['data-root', 'device-id'],
  send: ['data-root', 'device-id', 'id'],
  reconcile: ['data-root', 'device-id', 'id'],
  cancel: ['data-root', 'device-id', 'id'],
};

const ALLOWED_EXTRA = {
  enqueue: [],
  get: [],
  list: ['state', 'limit', 'cursor'],
  send: ['local-url', 'url', 'token-env', 'ca'],
  reconcile: ['local-url', 'url', 'token-env', 'ca'],
  cancel: [],
};

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function tokenFromEnv(name) {
  if (!ENV_NAME_RE.test(name)) {
    throw invalid('--token-env must be a valid environment variable name');
  }
  const token = process.env[name];
  if (token === undefined || token === '') {
    throw invalid(`environment variable ${name} is not set`);
  }
  return token;
}

function readCaFile(file) {
  const text = readTextFile(file, '--ca');
  if (text.trim() === '') {
    throw invalid('--ca file is empty');
  }
  return text;
}

function parseLimit(value) {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 200) {
    throw invalid('--limit must be a strict decimal positive integer between 1 and 200');
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

function listOptions(values) {
  const options = {};
  if (values.state !== undefined) options.state = values.state;
  if (values.limit !== undefined) options.limit = parseLimit(values.limit);
  if (values.cursor !== undefined) options.cursor = parseCursor(values.cursor);
  return options;
}

function parseArgv() {
  const argv = process.argv.slice(2);
  const hasCommand = argv.length > 0 && !argv[0].startsWith('-');
  const command = hasCommand ? argv[0] : undefined;
  let values;
  let tokens;
  try {
    ({ values, tokens } = parseArgs({
      args: hasCommand ? argv.slice(1) : argv,
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
      tokens: true,
    }));
  } catch (err) {
    throw invalid(err.message);
  }
  // 同一选项只允许出现一次，杜绝静默 last-wins。
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind === 'option') {
      if (seen.has(token.name)) throw invalid(`duplicate option --${token.name}`);
      seen.add(token.name);
    }
  }
  return { command, values };
}

// 传输错误统一为 {code,outcome} 固定形状（pending client 白名单过滤）；
// 不 dump secret/原始网络 stack。
function transportShape(err) {
  if (err && typeof err === 'object' && typeof err.code === 'string' && typeof err.outcome === 'string') {
    return { code: err.code, outcome: err.outcome };
  }
  return { code: 'INTERNAL', outcome: 'unconfirmed' };
}

// 注入给 pending client 的固定传输调用。enqueue/get/list 离线，该 call 永远不被调用。
// send/reconcile 仅允许一种传输；relay 连接懒到首次实际执行才打开，accepted 重发不连接。
function buildTransport(command, values, ac) {
  if (command !== 'send' && command !== 'reconcile') {
    return {
      call: async () => {
        throw { code: 'INTERNAL', outcome: 'unconfirmed' };
      },
      close: async () => {},
    };
  }
  const hasLocal = values['local-url'] !== undefined;
  const hasRemote = values.url !== undefined;
  if (hasLocal === hasRemote) {
    throw invalid('exactly one transport is required: --local-url or --url');
  }
  if (values['token-env'] === undefined) throw invalid('missing required option --token-env');
  const token = tokenFromEnv(values['token-env']);
  if (hasLocal) {
    if (values.ca !== undefined) throw invalid('--ca is only valid with the --url relay transport');
    const execute = createLocalControlAdapter({ url: values['local-url'], token });
    return {
      call: (targetDeviceId, method, params, options) =>
        execute(targetDeviceId, method, params, { signal: options?.signal }),
      close: async () => {},
    };
  }
  const ca = values.ca === undefined ? undefined : readCaFile(values.ca);
  let clientPromise = null;
  const call = (targetDeviceId, method, params, options) => {
    // 用本次 pending 操作的控制器覆盖握手与当前 call：pending.close 也能打断握手。
    const opSignal = options?.signal ?? ac.signal;
    if (!clientPromise) {
      clientPromise = openRemoteControl({
        deviceId: values['device-id'],
        url: values.url,
        token,
        ...(ca !== undefined ? { ca } : {}),
        signal: opSignal,
      }).then((client) => ({ client }));
    }
    return clientPromise.then(async ({ client }) => {
      try {
        return await client.call(targetDeviceId, method, params, { signal: opSignal });
      } catch (err) {
        // 保留 code/outcome（含 not-sent）；未知形状降级 INTERNAL/unconfirmed。
        throw transportShape(err);
      }
    });
  };
  return {
    call,
    close: async () => {
      if (!clientPromise) return;
      try {
        const { client } = await clientPromise;
        client.close();
      } catch {
        // 启动失败已在 call 路径转为固定传输错误，这里仅清理。
      }
    },
  };
}

async function main() {
  const { command, values } = parseArgv();
  const knownCommand = Object.hasOwn(REQUIRED, command);
  if (values.help) {
    if (command !== undefined && !knownCommand) {
      throw invalid(`unknown command: ${command}`);
    }
    process.stdout.write(USAGE);
    return 0;
  }
  if (!knownCommand) {
    throw invalid(`unknown command: ${command ?? '(none)'}`);
  }
  for (const key of REQUIRED[command]) {
    if (values[key] === undefined) {
      throw invalid(`missing required option --${key}`);
    }
  }
  const allowed = new Set([...REQUIRED[command], ...ALLOWED_EXTRA[command]]);
  for (const key of Object.keys(values)) {
    if (key !== 'help' && values[key] !== undefined && !allowed.has(key)) {
      throw invalid(`${command} does not take --${key}`);
    }
  }
  assertId(values['device-id'], 'deviceId');

  // SIGINT/SIGTERM 覆盖 openRemoteControl/当前 call；退出码 130/143，先落库再关传输。
  const ac = new AbortController();
  let signalCode = null;
  const onSignal = (sig) => {
    signalCode = sig === 'SIGINT' ? 130 : 143;
    ac.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let transport = null;
  let pending = null;
  let workError = null;
  try {
    transport = buildTransport(command, values, ac);
    pending = openPendingClient({
      dataRoot: values['data-root'],
      deviceId: values['device-id'],
      call: transport.call,
    });
    let result;
    switch (command) {
      case 'enqueue':
        result = await pending.enqueue(readInputObject(values.input));
        break;
      case 'get':
        result = await pending.get(values.id);
        break;
      case 'list':
        result = await pending.list(listOptions(values));
        break;
      case 'send':
        result = await pending.send(values.id, { signal: ac.signal });
        break;
      case 'reconcile':
        result = await pending.reconcile(values.id, { signal: ac.signal });
        break;
      case 'cancel':
        result = await pending.cancel(values.id);
        break;
    }
    if (signalCode !== null) return signalCode;
    process.stdout.write(JSON.stringify(result) + '\n');
    if (command === 'send' || command === 'reconcile') {
      return result?.state === 'accepted' ? 0 : 2;
    }
    return 0;
  } catch (err) {
    if (signalCode !== null) return signalCode;
    workError = err;
    throw err;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    // 先关 pending（落库/join inflight），再关传输；任一清理失败都继续关闭其余资源，
    // 最后才按 workError/signalCode 规则抛原或清理错误，不能中途提前 throw。
    let cleanupError = null;
    if (pending !== null) {
      try {
        await pending.close();
      } catch (closeErr) {
        cleanupError = closeErr;
      }
    }
    if (transport !== null) {
      try {
        await transport.close();
      } catch {
        // 传输关闭失败不掩盖主结果。
      }
    }
    if (cleanupError !== null && workError === null && signalCode === null) throw cleanupError;
  }
}

// 仅被直接运行（node host-core/pending-cli.js）时解析 CLI；被 import 时不解析、
// 不读 env/文件、不连接、不改 exitCode。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      const code = typeof err?.code === 'string' ? err.code : err instanceof TypeError ? 'INVALID_ARGUMENT' : 'INTERNAL';
      process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
      process.exitCode = 1;
    }
  );
}
