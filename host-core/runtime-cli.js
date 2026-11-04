import { parseArgs } from 'node:util';
import { openRuntime } from './runtime.js';
import { loadRuntimeConfig } from './runtime-models.js';

const USAGE = `usage: node host-core/runtime-cli.js <send|wait|history|status|context> [options]

commands:
  send             submit a message and wait for its answer; requires --data-root --config --bot-id --request-id --text
  wait             wait for an existing submission; requires --data-root --config --bot-id --request-id
  history          list conversation history; requires --data-root --bot-id [--limit] [--cursor]
  status           print one submission; requires --data-root --bot-id --request-id
  context          print context status; requires --data-root --bot-id

options:
  --data-root <dir>   verified absolute data directory (required, except help)
  --config <file>     runtime config file (required for send/wait)
  --bot-id <id>
  --request-id <id>
  --text <text>
  --limit <int>       strict decimal positive integer (history)
  --cursor <json>     JSON object cursor (history)
  -h, --help          show this help
`;

const OPTIONS = {
  'data-root': { type: 'string' },
  config: { type: 'string' },
  'bot-id': { type: 'string' },
  'request-id': { type: 'string' },
  text: { type: 'string' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const REQUIRED = {
  send: ['data-root', 'config', 'bot-id', 'request-id', 'text'],
  wait: ['data-root', 'config', 'bot-id', 'request-id'],
  history: ['data-root', 'bot-id'],
  status: ['data-root', 'bot-id', 'request-id'],
  context: ['data-root', 'bot-id'],
};

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

function parseLimit(value) {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw invalid('--limit must be a strict decimal positive integer');
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

async function main() {
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
  const historyOptions = {};
  if (command === 'history') {
    if (values.limit !== undefined) historyOptions.limit = parseLimit(values.limit);
    if (values.cursor !== undefined) historyOptions.cursor = parseCursor(values.cursor);
  }

  let runtime;
  try {
    const openOptions = { dataRoot: values['data-root'] };
    if (command === 'send' || command === 'wait') {
      const { models, defaultModel, thinkingLevel, bashPath, toolPaths, hindsight, extensions } = await loadRuntimeConfig(values.config);
      openOptions.models = models;
      openOptions.defaultModel = defaultModel;
      if (thinkingLevel !== undefined) openOptions.thinkingLevel = thinkingLevel;
      if (bashPath !== undefined) openOptions.bashPath = bashPath;
      if (toolPaths !== undefined) openOptions.toolPaths = toolPaths;
      if (hindsight !== undefined) openOptions.hindsight = hindsight;
      // 规范扩展配置必须一并转发：只传兼容字段会让 Bot 默认值按 legacy 语义回退。
      if (extensions !== undefined) openOptions.extensions = extensions;
    }
    runtime = await openRuntime(openOptions);

    let result;
    switch (command) {
      case 'send':
        await runtime.submit(values['bot-id'], { requestId: values['request-id'], text: values.text });
        result = await runtime.wait(values['bot-id'], values['request-id']);
        break;
      case 'wait':
        result = await runtime.wait(values['bot-id'], values['request-id']);
        break;
      case 'history':
        result = await runtime.history(values['bot-id'], historyOptions);
        break;
      case 'status':
        result = await runtime.getSubmission(values['bot-id'], values['request-id']);
        break;
      case 'context':
        result = await runtime.contextStatus(values['bot-id']);
        break;
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    if ((command === 'send' || command === 'wait') && result?.status === 'unanswered') {
      process.exitCode = 2;
    }
  } finally {
    if (runtime) await runtime.close();
  }
}

try {
  await main();
} catch (err) {
  const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
  process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
  process.exitCode = 1;
}
