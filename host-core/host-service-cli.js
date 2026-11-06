// 统一本机服务与离线设置 CLI：默认 serve；显式 serve/settings-get/settings-set 与
// Windows 登录自启动 autostart-enable/autostart-disable/autostart-status。
// 仅被直接运行时解析参数；被 import 时不读 env/文件、不监听 stdin/信号、不改 exitCode。
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateCenterUrl } from './center-client.js';
import { openHost } from './host.js';
import { openHostSettings } from './host-settings.js';
import { openHostService } from './host-service.js';
import { invalid, readInputObject, readTextFile } from './cli-input.js';

const USAGE = `usage: node host-core/host-service-cli.js [serve|settings-get|settings-set|autostart-enable|autostart-disable|autostart-status] [options]

commands (default: serve):
  serve             start the unified local host service; requires --data-root --token-env --center-url --device-token-env
  identity          print the persisted device identity; requires --data-root [--expected-device-id]
  settings-get      print the persisted local host settings snapshot; requires --data-root
  settings-set      replace persisted local host settings (next startup only); requires --data-root --input
  autostart-enable  register logon autostart for the current Windows user; same required options as serve (values not read);
                    preserves the registering process's --env-file and E_LAUNCHER_SHOWER_WINDOWS_EXE into the generated script
  autostart-disable remove the logon autostart file for this data root; requires --data-root (Windows only)
  autostart-status  print the logon autostart registration state; requires --data-root (Windows only)

options:
  --data-root <dir>         verified absolute data directory (required)
  --expected-device-id <id> expected device identity for first pairing or verification (serve, identity)
  --token-env <name>        environment variable holding the control token (serve only, required)
  --center-url <url>        center HTTPS origin (serve only, required)
  --device-token-env <name> environment variable holding the device token (serve only, required)
  --center-ca-file <file>   center CA PEM file (serve only)
  --npm-path <file>         absolute npm-cli.js path (serve only)
  --port <int>              TCP port on 127.0.0.1, decimal 0..65535 (serve only, default 8787)
  --initial-settings <file> settings seed file: single JSON object {runtime,relay} (serve only)
  --input <file>            settings-set input file: single JSON object {expectedRevision,settings} (required)
  -h, --help                show this help
`;

const COMMANDS = new Set([
  'serve',
  'identity',
  'settings-get',
  'settings-set',
  'autostart-enable',
  'autostart-disable',
  'autostart-status',
]);

const OPTIONS = {
  'data-root': { type: 'string' },
  'expected-device-id': { type: 'string' },
  'token-env': { type: 'string' },
  'center-url': { type: 'string' },
  'device-token-env': { type: 'string' },
  'center-ca-file': { type: 'string' },
  'npm-path': { type: 'string' },
  port: { type: 'string' },
  'initial-settings': { type: 'string' },
  input: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const ALLOWED_FLAGS = {
  serve: ['data-root', 'expected-device-id', 'token-env', 'center-url', 'device-token-env', 'center-ca-file', 'npm-path', 'port', 'initial-settings'],
  identity: ['data-root', 'expected-device-id'],
  'settings-get': ['data-root'],
  'settings-set': ['data-root', 'input'],
  'autostart-enable': ['data-root', 'token-env', 'center-url', 'device-token-env', 'center-ca-file', 'npm-path', 'port', 'initial-settings'],
  'autostart-disable': ['data-root'],
  'autostart-status': ['data-root'],
};

const REQUIRED = {
  serve: ['data-root', 'token-env', 'center-url', 'device-token-env'],
  identity: ['data-root'],
  'settings-get': ['data-root'],
  'settings-set': ['data-root', 'input'],
  'autostart-enable': ['data-root', 'token-env', 'center-url', 'device-token-env'],
  'autostart-disable': ['data-root'],
  'autostart-status': ['data-root'],
};

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

function parseDataRoot(value) {
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
    throw invalid('--data-root must be a non-empty absolute path');
  }
  return path.resolve(value);
}

function tokenFromEnv(name, flag) {
  if (!ENV_NAME_RE.test(name)) {
    throw invalid(`invalid --${flag} name`);
  }
  const token = process.env[name];
  if (token === undefined || token === '') {
    throw invalid(`environment variable for --${flag} is not set`);
  }
  return token;
}

function validateSettingsPatch(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('--input must be a plain object');
  }
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('expectedRevision') || !keys.includes('settings')) {
    throw invalid('--input must contain exactly expectedRevision and settings');
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0) {
    throw invalid('expectedRevision must be a positive safe integer');
  }
  if (typeof input.settings !== 'object' || input.settings === null || Array.isArray(input.settings)) {
    throw invalid('settings must be a plain object');
  }
}

function parseArgv() {
  const argv = process.argv.slice(2);
  const hasCommand = argv.length > 0 && !argv[0].startsWith('-');
  const command = hasCommand ? argv[0] : 'serve';
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
  // 拒绝重复选项：parseArgs 默认 last-wins，tokens 逐项核对避免静默覆盖。
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind === 'option') {
      if (seen.has(token.name)) {
        throw invalid(`duplicate option --${token.name}`);
      }
      seen.add(token.name);
    }
  }
  if (!COMMANDS.has(command)) {
    throw invalid(`unknown command: ${command}`);
  }
  return { command, values };
}

function probeDeviceId(dataRoot) {
  const probe = openHost({ dataRoot });
  try {
    return probe.deviceId;
  } finally {
    probe.close();
  }
}

async function settingsGet(dataRoot) {
  const store = openHostSettings({ dataRoot, deviceId: probeDeviceId(dataRoot) });
  try {
    return store.get();
  } finally {
    store.close();
  }
}

const CLI_PATH = fileURLToPath(import.meta.url);

function assertWindowsAutostart() {
  if (process.platform !== 'win32') {
    throw invalid('autostart commands are only supported on Windows');
  }
}

// 启动文件名只按规范化 dataRoot 的稳定摘要区分实例；同一 dataRoot 重复 enable 覆盖同一文件。
function autostartFilePath(dataRoot) {
  const startup = process.env.APPDATA !== undefined && process.env.APPDATA !== ''
    ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    : path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const digest = createHash('sha256').update(path.resolve(dataRoot), 'utf8').digest('hex').slice(0, 16);
  return path.join(startup, `e-launcher-host-${digest}.cmd`);
}

function absolutePath(value, flag) {
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
    throw invalid(`--${flag} must be a non-empty absolute path`);
  }
  return path.resolve(value);
}

function resolvedPath(value, flag) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`--${flag} must be a non-empty path`);
  }
  return path.resolve(value);
}

function validateEnvName(name, flag) {
  if (typeof name !== 'string' || !ENV_NAME_RE.test(name)) {
    throw invalid(`invalid --${flag} name`);
  }
  return name;
}

// 每个参数完整双引号引用：% 在批处理行内写成 %%（不经 call，无二次展开），
// 引号前的末尾反斜杠按 Windows argv 规则翻倍；Unicode、空格、&、()、! 原样可用。
// NUL/CR/LF/双引号无法在这条命令语法中表达，直接拒绝。
function cmdQuote(value, flag) {
  if (/[\u0000\r\n"]/.test(value)) {
    throw invalid(`${flag} contains characters that cannot be written into the startup file`);
  }
  // 先翻倍引号前的末尾反斜杠，再展开 %，避免 %% 压线时把反斜杠计数判错。
  const escaped = value.replace(/\\+$/, (m) => m + m).replace(/%/g, '%%');
  return '"' + escaped + '"';
}

// 注册进程携带的 Node --env-file 是唯一被保留的 execArgv：登录启动需要同一份
// 非秘密配置文件来提供 token 等变量名对应的值；只规范化为绝对路径，不读文件内容。
// 其他 execArgv（debug/preload 等）一律不继承，原无 --env-file 的注册行为不变。
function execArgvEnvFiles() {
  const files = [];
  const argv = process.execArgv;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env-file') {
      const next = argv[i + 1];
      if (next === undefined) break;
      files.push(next);
      i += 1;
    } else if (arg.startsWith('--env-file=')) {
      files.push(arg.slice('--env-file='.length));
    }
  }
  return files.map((file) => resolvedPath(file, 'env-file'));
}

function autostartArgs(values, dataRoot) {
  validateCenterUrl(values['center-url']);
  const args = [
    process.execPath,
    ...execArgvEnvFiles().flatMap((file) => ['--env-file', file]),
    path.resolve(CLI_PATH),
    'serve',
    '--data-root', dataRoot,
    '--token-env', validateEnvName(values['token-env'], 'token-env'),
    '--center-url', values['center-url'],
    '--device-token-env', validateEnvName(values['device-token-env'], 'device-token-env'),
  ];
  if (values['center-ca-file'] !== undefined) {
    args.push('--center-ca-file', resolvedPath(values['center-ca-file'], 'center-ca-file'));
  }
  if (values['npm-path'] !== undefined) {
    args.push('--npm-path', absolutePath(values['npm-path'], 'npm-path'));
  }
  if (values.port !== undefined) {
    args.push('--port', String(parsePort(values.port)));
  }
  if (values['initial-settings'] !== undefined) {
    args.push('--initial-settings', resolvedPath(values['initial-settings'], 'initial-settings'));
  }
  return args;
}

// `set "NAME=value"` 是批处理赋值而非 argv：引号内 &|<>^ 均按字面处理，
// 只有 % 需写成 %%；末尾反斜杠在 set 语义里不是转义，不套用 cmdQuote 的翻倍。
function cmdSet(name, value) {
  if (/[\u0000\r\n"]/.test(value)) {
    throw invalid(`${name} contains characters that cannot be written into the startup file`);
  }
  return `set "${name}=${value.replace(/%/g, '%%')}"`;
}

function autostartScript(args, logFile, envAssignments) {
  const command = args.map((a) => cmdQuote(a, 'startup argument')).join(' ');
  return [
    '@echo off',
    'chcp 65001>nul',
    'setlocal DisableDelayedExpansion',
    'rem e-launcher Host logon autostart entry; delete this file to disable.',
    ...envAssignments.map(([name, value]) => cmdSet(name, value)),
    `${command} >> ${cmdQuote(logFile, 'log file')} 2>&1`,
    'endlocal',
    '',
  ].join('\r\n');
}

function autostartEnable(values) {
  assertWindowsAutostart();
  const dataRoot = parseDataRoot(values['data-root']);
  const file = autostartFilePath(dataRoot);
  // 非秘密原生程序路径（当前仅 Shower Windows 后端 exe）原样带入登录环境；
  // 规范化绝对路径即可，内容不复制、值不含 token。
  const envAssignments = [];
  const showerExe = process.env.E_LAUNCHER_SHOWER_WINDOWS_EXE;
  if (showerExe !== undefined && showerExe !== '') {
    envAssignments.push(['E_LAUNCHER_SHOWER_WINDOWS_EXE', path.resolve(showerExe)]);
  }
  const content = autostartScript(autostartArgs(values, dataRoot), path.join(dataRoot, 'autostart.log'), envAssignments);
  // 登录时 >> 重定向需能打开 <dataRoot>/autostart.log；只建目录，不初始化 Runtime。
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { registered: true, file };
}

function autostartDisable(values) {
  assertWindowsAutostart();
  const file = autostartFilePath(parseDataRoot(values['data-root']));
  rmSync(file, { force: true });
  return { registered: false, file };
}

function autostartStatus(values) {
  assertWindowsAutostart();
  const file = autostartFilePath(parseDataRoot(values['data-root']));
  return { registered: existsSync(file), file };
}

async function settingsSet(dataRoot, patch) {
  const store = openHostSettings({ dataRoot, deviceId: probeDeviceId(dataRoot) });
  try {
    return store.replace({ expectedRevision: patch.expectedRevision, settings: patch.settings });
  } finally {
    store.close();
  }
}

async function serve(values) {
  const options = { dataRoot: parseDataRoot(values['data-root']) };
  if (values['expected-device-id'] !== undefined) {
    options.expectedDeviceId = values['expected-device-id'];
  }
  options.token = tokenFromEnv(values['token-env'], 'token-env');
  options.center = {
    url: values['center-url'],
    deviceToken: tokenFromEnv(values['device-token-env'], 'device-token-env'),
  };
  if (values['center-ca-file'] !== undefined) {
    options.center.ca = readTextFile(values['center-ca-file'], '--center-ca-file');
  }
  if (values['npm-path'] !== undefined) options.npmPath = values['npm-path'];
  if (values.port !== undefined) options.port = parsePort(values.port);
  if (values['initial-settings'] !== undefined) {
    options.initialSettings = readInputObject(values['initial-settings']);
  }

  const service = await openHostService(options);

  // 私有管理通道：stdin 一行 shutdown / SIGINT / SIGTERM 触发同一幂等 await close；
  // stdin EOF 不关服务，不 abort Agent。
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    rl.close();
    service.close().then(
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

  process.stdout.write(JSON.stringify({ event: 'listening', deviceId: service.deviceId, url: service.url }) + '\n');
}

async function main() {
  const { command, values } = parseArgv();

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  for (const key of Object.keys(OPTIONS)) {
    if (key === 'help') continue;
    if (values[key] !== undefined && !ALLOWED_FLAGS[command].includes(key)) {
      throw invalid(`${command} does not take --${key}`);
    }
  }
  for (const key of REQUIRED[command]) {
    if (values[key] === undefined) {
      throw invalid(`missing required option --${key}`);
    }
  }

  if (command === 'serve') {
    await serve(values);
    return;
  }
  if (command === 'autostart-enable') {
    process.stdout.write(JSON.stringify(autostartEnable(values)) + '\n');
    return;
  }
  if (command === 'autostart-disable') {
    process.stdout.write(JSON.stringify(autostartDisable(values)) + '\n');
    return;
  }
  if (command === 'autostart-status') {
    process.stdout.write(JSON.stringify(autostartStatus(values)) + '\n');
    return;
  }

  const dataRoot = parseDataRoot(values['data-root']);
  let result;
  if (command === 'identity') {
    const expectedDeviceId = values['expected-device-id'];
    const probe = openHost({ dataRoot, expectedDeviceId });
    try {
      result = { deviceId: probe.deviceId };
    } finally {
      probe.close();
    }
  } else if (command === 'settings-get') {
    result = await settingsGet(dataRoot);
  } else {
    const patch = readInputObject(values.input);
    validateSettingsPatch(patch);
    result = await settingsSet(dataRoot, patch);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

// 仅被直接运行（node host-core/host-service-cli.js）时执行；被 import 时不解析、
// 不读 env/文件、不监听 stdin/信号、不写 exitCode。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const code = typeof err?.code === 'string' ? err.code : err instanceof TypeError ? 'INVALID_ARGUMENT' : 'INTERNAL';
    process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  });
}
