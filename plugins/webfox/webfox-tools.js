// 复用上游 webfox 4.8 pi 适配思路：按 inspectCapability 动态构建参数 schema，
// 执行时透传 signal/progress，结果同时给模型文本与结构化文档。
// 与上游差异：用 host.sdk.defineTool 注册；details 只做有界状态投影，不放完整文档；
// 模型输出由 outputLimits 限界，超限时完整结果落插件私有目录并给分段读取路径；
// 全部工具 replay:'unsafe'——上游判定网络请求有副作用/计费，重启不重放。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Check, Errors } from 'typebox/value';
import { WebfoxError } from 'webfox';
import { renderTextDocument } from './render.js';

const MAX_INPUT_DETAIL_LENGTH = 200;

const DESCRIPTIONS = {
  search: 'Search up to ten queries and return titles, URLs, and snippets in input order.',
  contents: 'Fetch and extract readable contents from web URLs.',
  answer: 'Answer up to ten questions using web-grounded evidence.',
  research: 'Run foreground multi-step web research and return the final report.',
};

const INPUT_SCHEMAS = {
  search: {
    type: 'object',
    properties: {
      queries: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 10 },
      maxResults: { type: 'integer', minimum: 1 },
      options: { type: 'object' },
    },
    required: ['queries'],
    additionalProperties: false,
  },
  contents: {
    type: 'object',
    properties: {
      urls: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
      options: { type: 'object' },
    },
    required: ['urls'],
    additionalProperties: false,
  },
  answer: {
    type: 'object',
    properties: {
      queries: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 10 },
      options: { type: 'object' },
    },
    required: ['queries'],
    additionalProperties: false,
  },
  research: {
    type: 'object',
    properties: {
      input: { type: 'string', minLength: 1 },
      options: { type: 'object' },
    },
    required: ['input'],
    additionalProperties: false,
  },
};

const metadata = { type: 'object', additionalProperties: true, description: 'Provider-specific fields.' };
const serializedError = {
  type: 'object',
  properties: {
    code: { enum: ['INVALID_CONFIG', 'INVALID_INPUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_FAILURE', 'PARTIAL_BATCH', 'TIMEOUT', 'CANCELLED'] },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
  },
  required: ['code', 'message'],
  additionalProperties: false,
};
const inputResult = (value) => ({
  anyOf: [
    { type: 'object', properties: { input: { type: 'string' }, ok: { const: true }, value }, required: ['input', 'ok', 'value'], additionalProperties: false },
    { type: 'object', properties: { input: { type: 'string' }, ok: { const: false }, error: serializedError }, required: ['input', 'ok', 'error'], additionalProperties: false },
  ],
});
const documentSchema = (capability, value) => ({
  type: 'object',
  properties: {
    schemaVersion: { const: 1 },
    capability: { const: capability },
    provider: { type: 'string' },
    status: { enum: ['ok', 'partial'], description: 'partial when at least one input failed.' },
    results: { type: 'array', items: inputResult(value), description: 'One entry per input, in input order.' },
  },
  required: ['schemaVersion', 'capability', 'provider', 'status', 'results'],
  additionalProperties: false,
});
const searchValue = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' }, url: { type: 'string' }, snippet: { type: 'string' },
          score: { type: 'number' }, metadata,
        },
        required: ['title', 'url', 'snippet'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};
const contentsValue = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Final URL after redirects.' },
    content: { type: 'string' }, summary: {}, metadata,
  },
  required: ['url'],
  additionalProperties: false,
};
const textValue = {
  type: 'object',
  properties: { text: { type: 'string' }, itemCount: { type: 'integer' }, metadata },
  required: ['text'],
  additionalProperties: false,
};
const DOCUMENT_SCHEMAS = {
  search: documentSchema('search', searchValue),
  contents: documentSchema('contents', contentsValue),
  answer: documentSchema('answer', textValue),
  research: documentSchema('research', textValue),
};

// 以下参数纠错逻辑移植自上游 webfox 4.8 src/pi-validation.ts（MIT）：
// 模型常把 provider 选项放到顶层，给出精确路径与建议位置。
function isSchema(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function alternatives(schema) {
  return ['anyOf', 'oneOf', 'allOf'].flatMap((key) => Array.isArray(schema[key]) ? schema[key].filter(isSchema) : []);
}
function acceptsPath(schema, path) {
  if (schema === true) return true;
  if (!isSchema(schema)) return false;
  if (!path.length) return true;
  if (alternatives(schema).some((branch) => acceptsPath(branch, path))) return true;
  const [key, ...rest] = path;
  if (schema.type === 'array') return acceptsPath(schema.items, rest);
  if (schema.properties && Object.hasOwn(schema.properties, key)) return acceptsPath(schema.properties[key], rest);
  if (isSchema(schema.patternProperties)) {
    for (const [pattern, child] of Object.entries(schema.patternProperties)) {
      if (new RegExp(pattern).test(key) && acceptsPath(child, rest)) return true;
    }
  }
  if (schema.additionalProperties === false) return false;
  if (schema.type && schema.type !== 'object') return false;
  if (alternatives(schema).length && !schema.properties && schema.additionalProperties === undefined) return false;
  return schema.additionalProperties === undefined || acceptsPath(schema.additionalProperties, rest);
}
function displayPath(path) {
  return path.map((part, index) => {
    if (/^[a-zA-Z_][\w-]*$/.test(part)) return `${index ? '.' : ''}${part}`;
    if (/^\d+$/.test(part)) return `[${part}]`;
    return `[${JSON.stringify(part)}]`;
  }).join('');
}
function locations(schema, name, path = []) {
  if (!isSchema(schema)) return [];
  const found = alternatives(schema).flatMap((branch) => locations(branch, name, path));
  if (isSchema(schema.properties)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      const next = [...path, key];
      if (key === name) found.push(next);
      found.push(...locations(child, name, next));
    }
  }
  return found;
}
function prepareArguments(schema, args) {
  if (Check(schema, args)) return args;
  const messages = new Set();
  for (const error of Errors(schema, args)) {
    if (error.keyword !== 'additionalProperties') continue;
    const names = error.params.additionalProperties;
    if (!Array.isArray(names)) continue;
    const parent = error.instancePath.split('/').slice(1).map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    for (const name of names) {
      if (typeof name !== 'string') continue;
      const path = [...parent, name];
      if (acceptsPath(schema, path)) continue;
      const targets = [...new Set(locations(schema, name).map(displayPath))];
      const suggestion = targets.length === 1 ? ` Use ${targets[0]} instead.` : " Check the tool's parameter schema.";
      messages.add(`Invalid parameter: ${displayPath(path)}.${suggestion}`);
      if (messages.size === 3) break;
    }
    if (messages.size === 3) break;
  }
  if (messages.size) throw new Error([...messages].join('\n'));
  return args;
}

function boundedInput(input) {
  const text = typeof input === 'string' ? input : String(input ?? '');
  return text.length <= MAX_INPUT_DETAIL_LENGTH ? text : text.slice(0, MAX_INPUT_DETAIL_LENGTH);
}

function statusDetails(capability, provider, inputs, status) {
  return { status, capability, provider, inputs: inputs.map((row) => ({ input: boundedInput(row.input), state: row.state })) };
}

// 输出限界 50KiB/2000 行；任一超限把完整结果写插件 dataDir 下私有 spill 文件，
// 路径与统计放进有界文本开头（SDK retain:'head' 只保头部），供 read 分段读取；
// structuredOutput 仍带完整文档。
const OUTPUT_MAX_BYTES = 50 * 1024;
const OUTPUT_MAX_LINES = 2000;
const SPILL_DIR = 'webfox-output';
let spillCounter = 0;

async function writeSpill(dataDir, capability, provider, result, rendered) {
  const dir = join(dataDir, SPILL_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${process.pid}-${spillCounter++}-${capability}`;
  const file = join(dir, `${name}.json`);
  const payload = JSON.stringify({ capability, provider, rendered, result }, null, 2);
  await writeFile(file, payload, { mode: 0o600 });
  return { file, bytes: Buffer.byteLength(payload, 'utf8') };
}

export function createWebfoxTools(controller, selected, defineTool, dataDir) {
  return selected.map(({ inspection }) => {
    const capability = inspection.capability;
    const provider = inspection.provider;
    const base = INPUT_SCHEMAS[capability];
    const properties = { ...base.properties };
    if (capability !== 'search') delete properties.maxResults;
    if (inspection.optionSchema) properties.options = inspection.optionSchema;
    else delete properties.options;
    const parameters = { ...base, properties };
    const description = [
      DESCRIPTIONS[capability],
      ...(inspection.promptGuidelines ?? []),
      'Provider options go under "options". Output is bounded; partial input failures are reported per input.',
    ].join('\n');
    return defineTool({
      name: `web_${capability}`,
      description,
      parameters,
      structuredOutputSchema: DOCUMENT_SCHEMAS[capability],
      // 四个能力都是 replay:'unsafe'：与上游一致，网络请求有副作用/计费，
      // 已提交结果重启后不自动重跑。
      replay: 'unsafe',
      outputLimits: { maxBytes: OUTPUT_MAX_BYTES, maxLines: OUTPUT_MAX_LINES, retain: 'head' },
      prepareArguments: (args) => prepareArguments(parameters, args),
      async execute(args, api, context) {
        const inputStatuses = [];
        const request = {
          provider,
          signal: context.abortSignal,
          ...(args.options === undefined ? {} : { options: args.options }),
          onProgress: (event) => {
            if (event.inputIndex !== undefined && event.input !== undefined && event.state) {
              inputStatuses[event.inputIndex] = { input: event.input, state: event.state };
            }
            void api.details(statusDetails(capability, provider, inputStatuses.filter(Boolean), 'running'), context).catch(() => {});
          },
        };
        let result;
        try {
          if (capability === 'search') {
            result = await controller.run(capability, { ...request, queries: args.queries,
              ...(args.maxResults === undefined ? {} : { maxResults: args.maxResults }) }, api, context);
          } else if (capability === 'contents') {
            result = await controller.run(capability, { ...request, urls: args.urls }, api, context);
          } else if (capability === 'answer') {
            result = await controller.run(capability, { ...request, queries: args.queries }, api, context);
          } else {
            result = await controller.run(capability, { ...request, input: args.input }, api, context);
          }
        } catch (error) {
          // 宿主授权/归属错误继续抛出；仅 Webfox 规划与执行错误转为工具错误结果。
          if (!(error instanceof WebfoxError)) throw error;
          context.abortSignal?.throwIfAborted();
          return {
            output: [{ type: 'text', text: `Error: ${error.message}` }],
            isError: true,
            details: statusDetails(capability, provider, inputStatuses.filter(Boolean), 'failed'),
          };
        }
        const rendered = renderTextDocument(result);
        let text = rendered;
        const renderedBytes = Buffer.byteLength(rendered, 'utf8');
        const renderedLines = rendered.split('\n').length;
        if (dataDir !== undefined && (renderedBytes > OUTPUT_MAX_BYTES || renderedLines > OUTPUT_MAX_LINES)) {
          // 落文件失败直接抛错，不吞 warn 后假成功截断：丢了完整路径的截断文本
          // 会让模型拿不到剩余内容。
          const spill = await writeSpill(dataDir, capability, provider, result, rendered);
          // 提示放文本开头：SDK retain:'head' 只保头部，拼末尾的提示会被丢掉。
          const notice = `[Output truncated: full result (${spill.bytes} bytes) saved to private file ${spill.file}; read it in segments for the rest.]\n\n`;
          // 字节边界截有效 UTF-8 前缀（slice 按 UTF-16 单元，中文可放大 3 倍）。
          const headBytes = OUTPUT_MAX_BYTES - Buffer.byteLength(notice, 'utf8');
          const head = headBytes > 0 ? Buffer.from(rendered, 'utf8').subarray(0, headBytes).toString('utf8') : '';
          text = notice + head;
        }
        return {
          output: [{ type: 'text', text }],
          structuredOutput: JSON.parse(JSON.stringify(result)),
          isError: result.status === 'partial',
          details: statusDetails(capability, provider, result.results.map((entry) => ({
            input: entry.input,
            state: entry.ok ? 'done' : entry.error.code === 'CANCELLED' ? 'cancelled' : 'failed',
          })), result.status),
        };
      },
    });
  });
}
