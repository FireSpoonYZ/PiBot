// host-core/bot-browser/tools.js
// Bot-facing safe browsing tool (`bot_browser`) using Durable `defineTool` + TypeBox.
// Strictly binds every call to persistent conversation -> bot ownership (never trusts model params),
// exposes only restricted DOM navigation/snapshot/act primitives (NO eval, NO cookies, NO CDP,
// NO owner-only takeover/input/handback/release actions), and returns structured PAUSED_FOR_HUMAN
// when human takeover, disconnected hold, or Privacy Shield stops the bot.
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-durable';
import { DEFAULT_IMAGE_LIMITS } from '@earendil-works/pi-durable/tools';
import { resolveBotIdentity } from '../bot-identity.js';
import {
  BROWSER_ACT_KINDS,
  BROWSER_BOT_ACTIONS,
  BROWSER_MAX_FRAME_BASE64_BYTES,
  BROWSER_MAX_SNAPSHOT_TEXT_BYTES,
  browserError,
  isPlainObject,
  normalizeFrameLimits,
} from './protocol.js';

const MAX_TEXT_OUTPUT_BYTES = 50 * 1024;

// Same codemode structuredOutput contract as shower-tools.js and cua-tools.js.
const TOOL_RESULT_SCHEMA = Type.Object({
  content: Type.Array(Type.Union([
    Type.Object({ type: Type.Literal('text'), text: Type.String() }),
    Type.Object({ type: Type.Literal('image'), data: Type.String(), mimeType: Type.String() }),
  ])),
  isError: Type.Boolean(),
});

const SNAPSHOT_SCHEMA = {
  type: 'object',
  properties: {
    interactive: { type: 'boolean' },
    compact: { type: 'boolean' },
    depth: { type: 'integer', minimum: 1, maximum: 20 },
    selector: { type: 'string', minLength: 1, maxLength: 512 },
    urls: { type: 'boolean' },
    delta: { type: 'boolean' },
    full: { type: 'boolean' },
  },
  additionalProperties: false,
};

const ACT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...BROWSER_ACT_KINDS] },
    ref: { type: 'string', minLength: 1, maxLength: 128 },
    value: { type: 'string', maxLength: 4000 },
    text: { type: 'string', minLength: 1, maxLength: 1000 },
    key: { type: 'string', minLength: 1, maxLength: 32 },
    modifiers: {
      type: 'array',
      items: { type: 'string', enum: ['Control', 'Ctrl', 'Alt', 'Shift', 'Meta'] },
      uniqueItems: true,
      maxItems: 4,
    },
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    amount: { type: 'number', minimum: 1, maximum: 4000 },
    selector: {
      type: 'string',
      minLength: 1,
      maxLength: 512,
      description: 'CSS selector for act.wait (defaults to visible unless state="hidden" is also specified).',
    },
    url: {
      type: 'string',
      minLength: 1,
      maxLength: 512,
      description: 'Exact current page URL to wait for in act.wait.',
    },
    load: {
      type: 'string',
      enum: ['load', 'domcontentloaded'],
      description: "Page load state for act.wait ('load' or 'domcontentloaded'; 'networkidle' is unsupported).",
    },
    state: {
      type: 'string',
      enum: ['visible', 'hidden'],
      description: 'Element visibility state for act.wait; requires selector (hidden matches absent or non-visible elements).',
    },
    timeoutMs: { type: 'integer', minimum: 50, maximum: 15000 },
  },
  required: ['kind'],
  additionalProperties: false,
};

const LIMITS_SCHEMA = {
  type: 'object',
  properties: {
    format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
    quality: { type: 'integer', minimum: 10, maximum: 100 },
    maxWidth: { type: 'integer', minimum: 160, maximum: 4096 },
    maxHeight: { type: 'integer', minimum: 160, maximum: 4096 },
    maxBytes: { type: 'integer', minimum: 1, maximum: BROWSER_MAX_FRAME_BASE64_BYTES },
  },
  additionalProperties: false,
};

const PAUSED_ERROR_CODES = new Set([
  'BROWSER_PAUSED_FOR_HUMAN',
  'BROWSER_TAKEOVER_PENDING',
  'BROWSER_TAKEOVER_UNCONFIRMED',
  'BROWSER_SENSITIVE_BLOCKED',
  'BROWSER_SECRET_STEP_BLOCKED',
]);

function toolResult(bounded) {
  if (bounded.isError === true) return bounded;
  return { ...bounded, structuredOutput: { content: bounded.output ?? [], isError: false } };
}

function textOutput(text) {
  return { output: [{ type: 'text', text }] };
}

function checkedTextOutput(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_OUTPUT_BYTES) {
    return errorOutput('RESPONSE_TOO_LARGE', 'Bot browser response exceeded 50 KiB; narrow snapshot with compact/depth/selector.');
  }
  return textOutput(text);
}

function errorOutput(code, message, extra = {}) {
  const payload = { code, message };
  if (PAUSED_ERROR_CODES.has(code)) {
    payload.status = 'PAUSED_FOR_HUMAN';
  }
  if (extra.outcome === 'unconfirmed' || extra.outcome === 'not-sent') payload.outcome = extra.outcome;
  for (const key of ['phase', 'reason', 'guidance', 'fallbackToSystemBrowser', 'pageId', 'revision']) {
    if (extra[key] !== undefined && extra[key] !== null) {
      payload[key] = extra[key];
    }
  }
  return { ...textOutput(JSON.stringify(payload)), isError: true };
}

async function resolveVisionLimits(api, context) {
  if (typeof api?.agent !== 'function') {
    throw browserError('BROWSER_UNSUPPORTED', 'Current model vision capability cannot be verified for screenshot.');
  }
  const agent = await api.agent(context);
  const ref = agent?.model;
  if (!ref || typeof ref.provider !== 'string' || typeof ref.modelId !== 'string') {
    throw browserError('BROWSER_UNSUPPORTED', 'Current model cannot be determined for screenshot.');
  }
  const model = api.models?.getModel?.(ref.provider, ref.modelId);
  if (!model) {
    throw browserError('BROWSER_UNSUPPORTED', 'Current model metadata is unavailable for screenshot.');
  }
  const vision = Array.isArray(model.input) && model.input.includes('image');
  const resize = model.inputLimits?.images?.resize;
  return {
    vision,
    limits: {
      maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
      maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
      maxBytes: Math.min(
        resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
        BROWSER_MAX_FRAME_BASE64_BYTES
      ),
    },
  };
}

/**
 * Resolves the authoritative local bot identity from persistent conversation ownership.
 * Never trusts cwd, role, or model-supplied botId parameters.
 */
async function resolveAuthoritativeBotIdentity({
  host,
  getHarness,
  resolveConversationBot,
  resolveIdentity,
  boundBotId,
  api,
  context,
}) {
  let identity = null;
  if (typeof resolveIdentity === 'function') {
    identity = await resolveIdentity(api, context);
  } else if (typeof getHarness === 'function') {
    const harness = getHarness();
    if (!harness) {
      throw browserError('BOT_CONTEXT_REQUIRED', 'Host harness is unavailable.');
    }
    identity = await resolveBotIdentity(host, harness, api?.conversationId, context);
  }

  if (typeof resolveConversationBot === 'function') {
    const verifiedBotId = await resolveConversationBot(api?.conversationId, context);
    if (typeof verifiedBotId !== 'string' || verifiedBotId.trim() === '') {
      throw browserError('BOT_CONTEXT_REQUIRED');
    }
    if (identity && identity.botId !== verifiedBotId) {
      throw browserError('BOT_CONTEXT_REQUIRED', 'Conversation ownership mismatch.');
    }
    if (!identity) {
      const bot = host.getBot(verifiedBotId);
      if (!bot || bot.deviceId !== host.deviceId) {
        throw browserError('BOT_CONTEXT_REQUIRED');
      }
      identity = {
        deviceId: host.deviceId,
        botId: bot.botId,
        conversationId: String(api?.conversationId ?? bot.primaryConversationId),
        scopeId: null,
        kind: 'primary',
      };
    }
  }

  if (!identity || typeof identity.botId !== 'string' || identity.deviceId !== host.deviceId) {
    throw browserError('BOT_CONTEXT_REQUIRED');
  }
  const bot = host.getBot(identity.botId);
  if (!bot || bot.deviceId !== host.deviceId) {
    throw browserError('BOT_CONTEXT_REQUIRED');
  }
  if (boundBotId && identity.botId !== boundBotId) {
    throw browserError('BOT_CONTEXT_REQUIRED', 'Tool invocation does not belong to the bound bot.');
  }
  return identity;
}

export function createBotBrowserTools({
  host,
  getHarness,
  resolveConversationBot,
  resolveIdentity,
  runBotAction,
  boundBotId = null,
}) {
  return [
    defineTool({
      name: 'bot_browser',
      description:
        'Operate this bot\'s isolated built-in browser (per-bot profile and tabs, never the user\'s personal browser). ' +
        'Actions: status, open, navigate, back, forward, reload, select, closeTab, snapshot, act, screenshot, requestTakeover. ' +
        'Use snapshot (interactive/compact/depth/selector/urls/delta/full) to inspect elements and get refs, then act ' +
        '(click/dblclick/fill/type/select/scroll/hover/press/wait) with those refs. ' +
        'For act.wait, omitting conditions sleeps timeoutMs; supplying any combination of selector (+ optional state: visible|hidden, ' +
        'requiring selector; hidden includes absent), text (visible document text substring), url (exact current URL), and load ' +
        '(load|domcontentloaded; networkidle returns BROWSER_UNSUPPORTED) waits until all conditions hold simultaneously or fails with BROWSER_TIMEOUT. ' +
        'Arbitrary JS eval, cookie access/import, CDP passthrough, and local file:// URLs are forbidden. ' +
        'The human owner can interact with ordinary pages while the bot is active. Refresh the snapshot if the page changes. ' +
        'If the human owner takes exclusive control, or if the page reaches sign-in/MFA/OAuth consent, Terms/User Data Policy checkboxes, ' +
        'password/payment fields, or OAuth Client Secret creation, this tool returns PAUSED_FOR_HUMAN and halts immediately: ' +
        'do NOT retry clicking or continue silently; ask the human to take over or complete OAuth/secrets in their system browser. ' +
        'After human handback, call status/snapshot again before acting.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...BROWSER_BOT_ACTIONS] },
          pageId: { type: 'string', minLength: 1, maxLength: 128 },
          url: { type: 'string', minLength: 1, maxLength: 4096 },
          ignoreCache: { type: 'boolean' },
          snapshot: SNAPSHOT_SCHEMA,
          act: ACT_SCHEMA,
          limits: LIMITS_SCHEMA,
          reason: { type: 'string', minLength: 1, maxLength: 240 },
        },
        required: ['action'],
        additionalProperties: false,
      },
      structuredOutputSchema: TOOL_RESULT_SCHEMA,
      replay: 'unsafe',
      executionMode: 'sequential',
      async execute(args, api, context) {
        try {
          if (!isPlainObject(args) || typeof args.action !== 'string') {
            return errorOutput('INVALID_ARGUMENT', 'bot_browser requires an object with action.');
          }
          const identity = await resolveAuthoritativeBotIdentity({
            host,
            getHarness,
            resolveConversationBot,
            resolveIdentity,
            boundBotId,
            api,
            context,
          });

          const callOpts = {
            taskId: api?.taskId,
            callId: api?.callId,
            signal: context?.abortSignal,
          };

          if (args.action === 'screenshot') {
            const shot = await resolveVisionLimits(api, context);
            if (!shot.vision) {
              return errorOutput(
                'BROWSER_UNSUPPORTED',
                'Current model does not support image input; use snapshot instead of screenshot.'
              );
            }
            const reqLimits = normalizeFrameLimits(args.limits ?? {}, shot.limits.maxBytes);
            const effectiveLimits = {
              ...reqLimits,
              maxWidth: Math.min(reqLimits.maxWidth ?? shot.limits.maxWidth, shot.limits.maxWidth),
              maxHeight: Math.min(reqLimits.maxHeight ?? shot.limits.maxHeight, shot.limits.maxHeight),
              maxBytes: Math.min(reqLimits.maxBytes ?? shot.limits.maxBytes, shot.limits.maxBytes),
            };
            const frame = await runBotAction(identity, {
              action: 'screenshot',
              pageId: args.pageId,
              limits: effectiveLimits,
            }, callOpts);

            const metadata = {
              pageId: frame.pageId,
              revision: frame.revision,
              width: frame.width,
              height: frame.height,
              mimeType: frame.mimeType,
              url: frame.url,
              title: frame.title,
            };
            return toolResult({
              output: [
                { type: 'text', text: JSON.stringify(metadata) },
                { type: 'image', data: frame.data, mimeType: frame.mimeType },
              ],
            });
          }

          const result = await runBotAction(identity, args, callOpts);
          const serialized = JSON.stringify(result);
          if (Buffer.byteLength(serialized, 'utf8') > BROWSER_MAX_SNAPSHOT_TEXT_BYTES + 2048) {
            return errorOutput(
              'RESPONSE_TOO_LARGE',
              'Bot browser output exceeded size budget; use compact/depth/selector options.'
            );
          }
          return toolResult(checkedTextOutput(serialized));
        } catch (err) {
          const code = typeof err?.code === 'string' ? err.code : 'BROWSER_BACKEND_FAILED';
          const details = isPlainObject(err?.details) ? err.details : {};
          return errorOutput(code, err?.message || 'Bot browser operation failed.', { ...details, outcome: err?.outcome });
        }
      },
    }),
  ];
}
