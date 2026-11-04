import { parseArgs } from 'node:util';
import readline from 'node:readline';
import { statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openRelayServer } from './relay-server.js';

const MAX_PEM_BYTES = 1024 * 1024;

const USAGE = `usage: node host-core/relay-server-cli.js --data-root <dir> [--port <0..65535>] [--listen-host <ip>] [--tls-cert <file> --tls-key <file>]

options:
  --data-root <dir>   verified absolute data directory (required)
  --port <int>        listen port, strict decimal 0..65535 (default 8790)
  --listen-host <ip>  literal IPv4/IPv6 address to bind (default 127.0.0.1)
  --tls-cert <file>   TLS certificate PEM file, regular UTF-8, max 1MiB
  --tls-key <file>    TLS private key PEM file, regular UTF-8, max 1MiB
  -h, --help          show this help
`;

const OPTIONS = {
  'data-root': { type: 'string' },
  port: { type: 'string' },
  'listen-host': { type: 'string' },
  'tls-cert': { type: 'string' },
  'tls-key': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

function parsePort(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw invalid('--port must be a strict decimal integer');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw invalid('--port must be in range 0..65535');
  }
  return port;
}

// 先拒绝非普通文件，open 后 fstat 取真实大小；缓冲最多 1MiB+1，绝不无界 readFile。
function readPemFile(file, label) {
  let fd;
  try {
    const st = statSync(file);
    if (!st.isFile()) {
      throw invalid(`${label} must be a regular file`);
    }
    fd = openSync(file, 'r');
    const real = fstatSync(fd);
    if (!real.isFile()) {
      throw invalid(`${label} must be a regular file`);
    }
    if (real.size > MAX_PEM_BYTES) {
      throw invalid(`${label} file exceeds 1MiB`);
    }
    const buf = Buffer.allocUnsafe(real.size + 1);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead !== real.size) {
      throw invalid(`${label} file changed while reading`);
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, bytesRead));
    } catch {
      throw invalid(`${label} file is not valid UTF-8`);
    }
    if (text.trim() === '') {
      throw invalid(`${label} file is empty`);
    }
    return text;
  } catch (err) {
    if (err?.code === 'INVALID_ARGUMENT') throw err;
    throw invalid(`cannot read ${label}: ${err.message}`);
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
  if (values['data-root'] === undefined) {
    throw invalid('missing required option --data-root');
  }
  const tlsCert = values['tls-cert'];
  const tlsKey = values['tls-key'];
  if ((tlsCert === undefined) !== (tlsKey === undefined)) {
    throw invalid('--tls-cert and --tls-key must be provided together');
  }
  // 纯参数/文件校验全部发生在 openRelayServer 之前：坏端口/TLS 文件不会先建数据目录或监听。
  const options = { dataRoot: values['data-root'] };
  if (values.port !== undefined) options.port = parsePort(values.port);
  if (values['listen-host'] !== undefined) options.listenHost = values['listen-host'];
  if (tlsCert !== undefined) {
    options.tls = {
      cert: readPemFile(tlsCert, '--tls-cert'),
      key: readPemFile(tlsKey, '--tls-key'),
    };
  }

  const server = await openRelayServer(options);

  // 私有管理通道：stdin 一行 shutdown 触发同一幂等关闭；stdin EOF/关闭不影响服务。
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    rl.close();
    server.close().then(
      () => process.exit(0),
      (err) => {
        const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
        process.stderr.write(
          JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n',
          () => process.exit(1)
        );
      }
    );
  };
  rl.on('line', (line) => {
    if (line.trim() === 'shutdown') shutdown();
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.stdout.write(JSON.stringify({ event: 'listening', url: server.url }) + '\n');
}

// 仅被直接运行（node host-core/relay-server-cli.js）时启动服务；被 import 时不解析参数、
// 不读 env/文件、不监听 stdin/信号、不写 stderr/exitCode。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const code = typeof err?.code === 'string' ? err.code : err instanceof TypeError ? 'INVALID_ARGUMENT' : 'INTERNAL';
    process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  });
}
