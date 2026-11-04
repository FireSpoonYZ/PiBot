import { parseArgs } from 'node:util';
import readline from 'node:readline';
import { statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openDeviceLink } from './device-link.js';

const MAX_CA_BYTES = 1024 * 1024;

const USAGE = `usage: node host-core/device-link-cli.js --data-root <dir> --url <ws(s)://...> --token-env <name> [--ca <file>] [--control-url <url> --control-token-env <name>]

options:
  --data-root <dir>   verified absolute data directory (required)
  --url <url>         relay WebSocket URL (required; path must be /v1/link)
  --token-env <name>  environment variable holding the device token (required, must be set)
  --ca <file>         custom CA bundle PEM file, regular UTF-8, max 1MiB (optional)
  --control-url <url> local Host control base URL, paired with --control-token-env (optional)
  --control-token-env <name>  environment variable holding the control bearer token (optional, pair)
  -h, --help          show this help
`;

const OPTIONS = {
  'data-root': { type: 'string' },
  url: { type: 'string' },
  'token-env': { type: 'string' },
  ca: { type: 'string' },
  'control-url': { type: 'string' },
  'control-token-env': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const REQUIRED = ['data-root', 'url', 'token-env'];

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

// 先拒绝非普通文件，open 后 fstat 取真实大小；缓冲最多 1MiB+1，绝不无界 readFile。
function readCaFile(file) {
  let fd;
  try {
    const st = statSync(file);
    if (!st.isFile()) {
      throw invalid('--ca must be a regular file');
    }
    fd = openSync(file, 'r');
    const real = fstatSync(fd);
    if (!real.isFile()) {
      throw invalid('--ca must be a regular file');
    }
    if (real.size > MAX_CA_BYTES) {
      throw invalid('--ca file exceeds 1MiB');
    }
    const buf = Buffer.allocUnsafe(real.size + 1);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead !== real.size) {
      throw invalid('--ca file changed while reading');
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, bytesRead));
    } catch {
      throw invalid('--ca file is not valid UTF-8');
    }
    if (text.trim() === '') {
      throw invalid('--ca file is empty');
    }
    return text;
  } catch (err) {
    if (err?.code === 'INVALID_ARGUMENT') throw err;
    throw invalid(`cannot read --ca: ${err.message}`);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不掩盖原错误。
      }
    }
  }
}

function parseArgv() {
  let values;
  try {
    ({ values } = parseArgs({ options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (err) {
    throw invalid(err.message);
  }
  return values;
}

async function main() {
  const values = parseArgv();
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  for (const key of REQUIRED) {
    if (values[key] === undefined) {
      throw invalid(`missing required option --${key}`);
    }
  }
  // token 仅来自环境变量，绝不作为 flag 值、绝不输出。
  const tokenEnv = values['token-env'];
  if (!ENV_NAME_RE.test(tokenEnv)) {
    throw invalid('--token-env must be a valid environment variable name');
  }
  const token = process.env[tokenEnv];
  if (typeof token !== 'string' || token === '') {
    throw invalid(`environment variable ${tokenEnv} is not set`);
  }
  // 参数/CA 文件校验全部发生在 openDeviceLink 之前：坏参数不会先写数据。
  const options = { dataRoot: values['data-root'], url: values.url, token };
  if (values.ca !== undefined) options.ca = readCaFile(values.ca);
  // 可选控制通道凭据与链路凭据分开：--control-token-env 独立命名，两者必须成对出现；
  // 深层 URL/token 校验由 openDeviceLink 构造控制适配器时完成（发生在写任何数据之前）。
  const controlUrl = values['control-url'];
  const controlTokenEnv = values['control-token-env'];
  if ((controlUrl === undefined) !== (controlTokenEnv === undefined)) {
    throw invalid('--control-url and --control-token-env must be used together');
  }
  if (controlUrl !== undefined) {
    if (!ENV_NAME_RE.test(controlTokenEnv)) {
      throw invalid('--control-token-env must be a valid environment variable name');
    }
    const controlToken = process.env[controlTokenEnv];
    if (typeof controlToken !== 'string' || controlToken === '') {
      throw invalid(`environment variable ${controlTokenEnv} is not set`);
    }
    options.control = { url: controlUrl, token: controlToken };
  }

  let link = null;
  let pendingBlocked = false;
  let lastStatusLine = null;
  let closing = false;
  let rl = null;

  const finish = (code) => {
    if (closing) return;
    closing = true;
    if (rl !== null) {
      rl.close();
      rl = null;
    }
    const closeAndExit = () => {
      link.close().then(
        () => process.exit(code),
        (err) => {
          const closeCode = typeof err?.code === 'string' ? err.code : 'INTERNAL';
          process.stderr.write(
            JSON.stringify({ error: { code: closeCode, message: err?.message ?? String(err) } }) + '\n',
            () => process.exit(1)
          );
        }
      );
    };
    if (link !== null) closeAndExit();
    else process.exit(code);
  };

  // onStatus 可能在 openDeviceLink 返回前触发：link 尚未赋值时只记录 blocked，
  // 等 open 返回后再关闭退出。回调异常隔离，不影响链接主流程。
  const onStatus = (status) => {
    try {
      const line = JSON.stringify({ event: 'link_status', ...status });
      if (line !== lastStatusLine) {
        lastStatusLine = line;
        process.stdout.write(line + '\n');
      }
      if (status.phase === 'blocked') {
        if (link === null) pendingBlocked = true;
        else finish(2);
      }
    } catch {
      // onStatus 是外部回调边界：异常不得影响链接主流程。
    }
  };

  link = await openDeviceLink({ ...options, onStatus });
  if (pendingBlocked) {
    pendingBlocked = false;
    finish(2);
    return;
  }

  // 私有管理通道：stdin 一行 shutdown 触发显式关闭；stdin EOF/远程断线不触发退出。
  rl = readline.createInterface({ input: process.stdin, terminal: false });
  const shutdown = () => finish(0);
  rl.on('line', (line) => {
    if (line.trim() === 'shutdown') shutdown();
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// 仅被直接运行（node host-core/device-link-cli.js）时启动；被 import 时不解析参数、
// 不读 env/文件、不监听 stdin/信号、不写 stderr/exitCode。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const code = typeof err?.code === 'string' ? err.code : err instanceof TypeError ? 'INVALID_ARGUMENT' : 'INTERNAL';
    process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  });
}
