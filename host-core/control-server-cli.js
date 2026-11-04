import { parseArgs } from 'node:util';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { openControlServer } from './control-server.js';
import { loadRuntimeConfig } from './runtime-models.js';

const USAGE = `usage: node host-core/control-server-cli.js --data-root <dir> --config <file> --token-env <name> [--port <0..65535>]

options:
  --data-root <dir>   verified absolute data directory (required)
  --config <file>     runtime config file (required)
  --token-env <name>  environment variable holding the control token (required, must be set)
  --port <int>        TCP port on 127.0.0.1, decimal 0..65535 (default 8787)
  -h, --help          show this help
`;

const OPTIONS = {
  'data-root': { type: 'string' },
  config: { type: 'string' },
  'token-env': { type: 'string' },
  port: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const REQUIRED = ['data-root', 'config', 'token-env'];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  const tokenEnv = values['token-env'];
  if (!ENV_NAME.test(tokenEnv)) {
    throw invalid('--token-env must be a valid environment variable name');
  }
  const token = process.env[tokenEnv];
  if (typeof token !== 'string' || token === '') {
    throw invalid(`environment variable ${tokenEnv} is not set`);
  }
  const options = { dataRoot: values['data-root'], token };
  if (values.port !== undefined) options.port = parsePort(values.port);
  const { models, defaultModel, thinkingLevel, bashPath, toolPaths, hindsight, extensions } = await loadRuntimeConfig(values.config);
  options.models = models;
  options.defaultModel = defaultModel;
  if (thinkingLevel !== undefined) options.thinkingLevel = thinkingLevel;
  if (bashPath !== undefined) options.bashPath = bashPath;
  if (toolPaths !== undefined) options.toolPaths = toolPaths;
  if (hindsight !== undefined) options.hindsight = hindsight;
  // 规范扩展配置必须一并转发：只传兼容字段会让 Bot 默认值按 legacy 语义回退。
  if (extensions !== undefined) options.extensions = extensions;

  const server = await openControlServer(options);

  // 私有管理通道：本机父进程向 stdin 发一行 shutdown 触发同一幂等关闭；
  // stdin EOF/关闭不影响 Host，不 abort Agent，其他输入忽略且不回显。
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

  process.stdout.write(JSON.stringify({ event: 'listening', deviceId: server.deviceId, url: server.url }) + '\n');
}

// 仅被直接运行（node host-core/control-server-cli.js）时启动服务；被 import 时不解析参数、
// 不读 env、不监听 stdin/信号、不写 stderr/exitCode。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
    process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  });
}
