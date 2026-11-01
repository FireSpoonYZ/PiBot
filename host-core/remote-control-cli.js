// host-core/remote-control-cli.js
//
// Module 9 一次性远程控制 CLI：通过已认证中继向目标设备 Host 发送固定 JSON 控制方法，
// 成功在 stdout 输出单个原始 JSON 结果。本 CLI 不持有 Host 锁、不创建任何本地数据
// 文件；同设备 Host/Agent 可并行运行。Module 14 新增保留命令 listDevices（设备目录）
// 与 live（实时预览流），二者都不是 Host JSON 方法。
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { normalizeDeviceName } from './device-metadata.js';
import { assertId } from './message-protocol.js';
import { CONTROL_METHODS, normalizeControlCall } from './remote-control-protocol.js';
import { normalizeLiveTarget } from './remote-live-protocol.js';
import { openRemoteControl, RemoteControlError } from './remote-control-client.js';
import { invalid, readTextFile, readInputObject, MAX_UPLOAD_INPUT_BYTES } from './cli-input.js';

const METHODS_LIST = CONTROL_METHODS.map((m) => `  ${m}`).join('\n');

const USAGE = `usage: node host-core/remote-control-cli.js <METHOD|listDevices|renameDevice|live> --device-id <id> [--target-device-id <id>] --url <ws(s)://.../v1/link> --token-env <name> [--input <file>] [--ca <file>]

methods (params come from --input):
${METHODS_LIST}

reserved commands:
  renameDevice      rename device; --input {deviceId,displayName}; no --target-device-id
  listDevices       list registered relay devices; --input {limit?,cursor?} optional; no --target-device-id
  live              stream live snapshot frames, one JSON line per frame (snapshot or unique end);
                    requires --target-device-id and --input {kind:'primary',botId}|{kind:'work',botId,scopeId}

options:
  --device-id <id>         local source device id (required)
  --target-device-id <id>  target device id hosting the control API (required for methods and live; forbidden for listDevices)
  --url <url>              relay WebSocket URL (required; path must be /v1/link)
  --token-env <name>       environment variable holding the device token (required, must be set)
  --input <file>           params JSON file: max 1MiB (32MiB for uploadAttachment), UTF-8, a single plain object (optional for methods/listDevices; required for live)
  --ca <file>              custom CA bundle PEM file, regular UTF-8, max 1MiB (optional)
  -h, --help               show this help
`;

const OPTIONS = {
  'device-id': { type: 'string' },
  'target-device-id': { type: 'string' },
  url: { type: 'string' },
  'token-env': { type: 'string' },
  input: { type: 'string' },
  ca: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`${label} has unknown field: ${key}`);
    }
  }
}

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

function parseArgv() {
  let values;
  let positionals;
  let tokens;
  try {
    ({ values, positionals, tokens } = parseArgs({
      options: OPTIONS,
      strict: true,
      allowPositionals: true,
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
  return { values, positionals };
}

// listDevices --input 严格校验：仅 {limit?,cursor?}，limit 1..200，keyset cursor {afterDeviceId}。
function normalizeDevicesOptions(input) {
  rejectUnknownFields(input, new Set(['limit', 'cursor']), '--input');
  const options = {};
  if (input.limit !== undefined) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw invalid('--input limit must be an integer between 1 and 200');
    }
    options.limit = input.limit;
  }
  if (input.cursor !== undefined && input.cursor !== null) {
    if (!isPlainObject(input.cursor) || Object.keys(input.cursor).length !== 1 || !('afterDeviceId' in input.cursor)) {
      throw invalid('--input cursor must be a keyset cursor {afterDeviceId} or null');
    }
    assertId(input.cursor.afterDeviceId, 'cursor.afterDeviceId');
    options.cursor = { afterDeviceId: input.cursor.afterDeviceId };
  }
  return options;
}

// live：逐帧一行 JSON（snapshot 或唯一 end）。stdout 背压等待 drain 且可被 abort
// 打断；EPIPE 由 main 的 stdout error 监听取消观察并正常退出 0。
async function streamLive(client, targetDeviceId, target, ac) {
  for await (const frame of client.live(targetDeviceId, target, { signal: ac.signal })) {
    if (!process.stdout.write(JSON.stringify(frame) + '\n')) {
      await once(process.stdout, 'drain', { signal: ac.signal });
    }
  }
}

async function main() {
  const { values, positionals } = parseArgv();
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    throw invalid('exactly one command is required');
  }
  const command = positionals[0];
  const reserved = command === 'listDevices' || command === 'renameDevice' || command === 'live';
  if (!reserved && !CONTROL_METHODS.includes(command)) {
    throw invalid(`unknown command: ${command}`);
  }
  if (values['device-id'] === undefined) throw invalid('missing required option --device-id');
  if (values.url === undefined) throw invalid('missing required option --url');
  if (values['token-env'] === undefined) throw invalid('missing required option --token-env');
  if (command === 'listDevices' || command === 'renameDevice') {
    if (values['target-device-id'] !== undefined) throw invalid(`${command} does not take --target-device-id`);
  } else if (values['target-device-id'] === undefined) {
    throw invalid('missing required option --target-device-id');
  }
  if ((command === 'live' || command === 'renameDevice') && values.input === undefined) throw invalid('missing required option --input');
  assertId(values['device-id'], 'deviceId');
  if (values['target-device-id'] !== undefined) assertId(values['target-device-id'], 'targetDeviceId');
  // token 仅来自环境变量，绝不作为 flag 值、绝不输出。
  const token = tokenFromEnv(values['token-env']);
  // 文件/参数校验全部发生在 openRemoteControl 之前：坏参数不会发起任何连接。
  const ca = values.ca === undefined ? undefined : readCaFile(values.ca);

  let call = { method: command, params: {} };
  if (reserved) {
    if (command === 'listDevices') {
      call = { method: null, query: normalizeDevicesOptions(values.input === undefined ? {} : readInputObject(values.input)) };
    } else if (command === 'renameDevice') {
      const input = readInputObject(values.input);
      rejectUnknownFields(input, new Set(['deviceId', 'displayName']), '--input');
      assertId(input.deviceId, 'deviceId');
      call = { input: { deviceId: input.deviceId, displayName: normalizeDeviceName(input.displayName) } };
    } else {
      call = { method: null, target: normalizeLiveTarget(readInputObject(values.input)) };
    }
  } else {
    // uploadAttachment 的 --input 可含单图 16MiB base64（约22.4MiB），使用更大读取预算；
    // 其他方法与配置读取保持默认 1MiB。
    const input = values.input === undefined ? {} : readInputObject(
      values.input,
      command === 'uploadAttachment' ? MAX_UPLOAD_INPUT_BYTES : undefined
    );
    call = normalizeControlCall(command, input);
  }

  // SIGINT/SIGTERM 只取消启动/等待/观察并关闭客户端，绝不发送 abort 控制方法；
  // 退出码遵循 shell 约定 130/143。
  const ac = new AbortController();
  let signalCode = null;
  const onSignal = (sig) => {
    signalCode = sig === 'SIGINT' ? 130 : 143;
    ac.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let stdoutError = null;
  const onStdoutError = (err) => {
    stdoutError = err;
    ac.abort();
  };
  process.stdout.on('error', onStdoutError);

  let client = null;
  let workError = null;
  try {
    client = await openRemoteControl({
      deviceId: values['device-id'],
      url: values.url,
      token,
      ...(ca !== undefined ? { ca } : {}),
      signal: ac.signal,
    });
    if (signalCode !== null) return signalCode;
    if (stdoutError?.code === 'EPIPE') return 0;
    if (command === 'listDevices') {
      const result = await client.listDevices({ ...call.query, signal: ac.signal });
      if (signalCode !== null) return signalCode;
      process.stdout.write(JSON.stringify(result) + '\n');
      return 0;
    }
    if (command === 'renameDevice') {
      const result = await client.renameDevice(call.input, { signal: ac.signal });
      if (signalCode !== null) return signalCode;
      process.stdout.write(JSON.stringify(result) + '\n');
      return 0;
    }
    if (command === 'live') {
      await streamLive(client, values['target-device-id'], call.target, ac);
      if (signalCode !== null) return signalCode;
      return 0;
    }
    const result = await client.call(values['target-device-id'], call.method, call.params, { signal: ac.signal });
    if (signalCode !== null) return signalCode;
    process.stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (err) {
    if (signalCode !== null) return signalCode;
    if (stdoutError?.code === 'EPIPE') return 0;
    if (stdoutError !== null) {
      workError = stdoutError;
      throw stdoutError;
    }
    workError = err;
    throw err;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.stdout.removeListener('error', onStdoutError);
    if (client !== null) {
      try {
        await client.close();
      } catch (cleanupErr) {
        if (workError === null && signalCode === null) throw cleanupErr;
      }
    }
  }
}

// 仅被直接运行（node host-core/remote-control-cli.js）时解析 CLI；被 import 时不解析、
// 不读 env/文件、不连接、不改 exitCode。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      const outcome = err instanceof RemoteControlError ? err.outcome : 'not-sent';
      const code =
        err instanceof RemoteControlError
          ? err.code
          : typeof err?.code === 'string'
            ? err.code
            : err instanceof TypeError
              ? 'INVALID_ARGUMENT'
              : 'INTERNAL';
      process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err), outcome } }) + '\n');
      process.exitCode = outcome === 'unconfirmed' ? 2 : 1;
    }
  );
}
