// host-core/schedule-tools.js
// Cross-platform `schedule_task` tool for all Bots (primary and non-primary)
// across all session contexts (primary 1-on-1 chat, room, dm).
// Supports managing the current Bot's own scheduled tasks (default) as well as
// managing another Bot's scheduled tasks on the local or remote Host via
// optional `deviceId` and `botId` parameters.

import { defineTool } from '@earendil-works/pi-durable';
import { resolveBotIdentity } from './bot-identity.js';
import { assertId, messageError } from './message-protocol.js';
import { CONTROL_ERROR_CODES } from './remote-control-protocol.js';

const MAX_TEXT_OUTPUT_BYTES = 50 * 1024;

const TOOL_ERROR_CODES = new Set([
  'INVALID_ARGUMENT',
  'BOT_NOT_FOUND',
  'BOT_ARCHIVED',
  'BOT_CONTEXT_REQUIRED',
  'REQUEST_CONFLICT',
  'STORE_FAILED',
  'UNSUPPORTED_SCHEMA',
  'RESPONSE_TOO_LARGE',
  'CENTER_REQUEST_FAILED',
  'NOT_FOUND',
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'ANDROID_NATIVE_UNAVAILABLE',
  'ANDROID_NATIVE_BUSY',
  'ANDROID_NATIVE_ERROR',
  'ANDROID_NATIVE_UNCONFIRMED',
  ...CONTROL_ERROR_CODES,
]);

function textOutput(text) {
  return { output: [{ type: 'text', text }] };
}

function errorOutput(code, message, outcome) {
  return {
    ...textOutput(
      JSON.stringify({
        code,
        message,
        ...(outcome ? { outcome } : {}),
      }),
    ),
    isError: true,
  };
}

function checkedTextOutput(text, tooLargeCode, tooLargeMessage) {
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_OUTPUT_BYTES) {
    return errorOutput(tooLargeCode, tooLargeMessage);
  }
  return textOutput(text);
}

function assertWellFormedStrings(value) {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) {
      throw messageError('INVALID_ARGUMENT', '字符串参数包含未配对的 UTF-16 代理项');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertWellFormedStrings(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) assertWellFormedStrings(item);
  }
}

export function createScheduleTools({ host, getHarness, schedules, collaboration }) {
  return [
    defineTool({
      name: 'schedule_task',
      description:
        '管理 Bot 的主私聊定时任务（支持 Android、Windows、Linux 等所有运行中的 Host，主 Bot 与普通 Bot 在私聊、room、dm 中均可调用）。' +
        '不传 deviceId/botId 时默认管理当前 Bot 自己的定时任务；传入 botId（及可选 deviceId）时可查看或管理本机或远程设备上指定 Bot 的定时任务。' +
        '任务仅在目标 Host 在线运行期间按计划触发并提交到目标 Bot 的主私聊会话，Host 离线或未运行时错过的时刻不补发。' +
        'action=list 列出目标 Bot 的任务摘要（可选 cursor/limit 分页）；' +
        'create 新建任务，title/prompt/repeat/time 必填，ID 由宿主分配，不接受 id/revision；' +
        'update/delete/setEnabled 必须提供 id 和正整数 revision 做严格 CAS（先 list 获取最新 id 与 revision）。' +
        'repeat 支持 once/daily/weekly/monthly/statutoryWorkday/statutoryHoliday，time 格式 HH:mm，' +
        '可选 alarmMode exact|alarmClock（默认 alarmClock）、vibrate、deleteAfterRun。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'create', 'update', 'delete', 'setEnabled'],
          },
          deviceId: { type: 'string', minLength: 1, maxLength: 128 },
          botId: { type: 'string', minLength: 1, maxLength: 128 },
          title: { type: 'string', minLength: 1, maxLength: 80 },
          prompt: { type: 'string', minLength: 1, maxLength: 8000 },
          repeat: {
            type: 'string',
            enum: [
              'once',
              'daily',
              'weekly',
              'monthly',
              'statutoryWorkday',
              'statutoryHoliday',
            ],
          },
          time: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
          weekday: { type: 'integer', minimum: 1, maximum: 7 },
          weekdays: {
            type: 'array',
            items: { type: 'integer', minimum: 1, maximum: 7 },
            uniqueItems: true,
            maxItems: 7,
          },
          monthDay: { type: 'integer', minimum: 1, maximum: 31 },
          id: { type: 'string', minLength: 1, maxLength: 64 },
          revision: { type: 'integer', minimum: 1 },
          enabled: { type: 'boolean' },
          cursor: {
            type: 'string',
            pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
          },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          alarmMode: { type: 'string', enum: ['exact', 'alarmClock'] },
          vibrate: { type: 'boolean' },
          deleteAfterRun: { type: 'boolean' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      replay: 'unsafe',
      outputLimits: { maxBytes: MAX_TEXT_OUTPUT_BYTES },
      async execute(args, api, context) {
        try {
          context.abortSignal?.throwIfAborted();
          assertWellFormedStrings(args);
          const identity = await resolveBotIdentity(
            host,
            getHarness(),
            api.conversationId,
            context,
          );
          context.abortSignal?.throwIfAborted();

          if (args?.deviceId !== undefined) assertId(args.deviceId, 'deviceId');
          if (args?.botId !== undefined) assertId(args.botId, 'botId');
          const targetDeviceId =
            args?.deviceId !== undefined ? args.deviceId : identity.deviceId;
          const targetBotId =
            args?.botId !== undefined ? args.botId : identity.botId;

          const { deviceId: _deviceId, botId: _botId, ...scheduleInput } = args ?? {};

          let result;
          if (targetDeviceId === host.deviceId) {
            const bot = host.getBot(targetBotId);
            if (!bot) {
              throw messageError('BOT_NOT_FOUND', `bot not found: ${targetBotId}`);
            }
            if (
              bot.archivedAt !== null &&
              bot.archivedAt !== undefined &&
              (scheduleInput.action === 'create' ||
                scheduleInput.action === 'update' ||
                (scheduleInput.action === 'setEnabled' && scheduleInput.enabled === true))
            ) {
              throw messageError('BOT_ARCHIVED', 'bot is archived and read-only');
            }
            result = await schedules.execute(bot, scheduleInput, {
              taskId: api.taskId,
              signal: context.abortSignal,
            });
          } else {
            if (!collaboration || typeof collaboration.scheduleTask !== 'function') {
              throw messageError(
                'CONTROL_UNAVAILABLE',
                'remote schedule collaboration is unavailable',
              );
            }
            result = await collaboration.scheduleTask({
              deviceId: targetDeviceId,
              botId: targetBotId,
              input: scheduleInput,
              signal: context.abortSignal,
            });
          }

          context.abortSignal?.throwIfAborted();
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            throw messageError('STORE_FAILED', '定时任务响应无效');
          }
          return checkedTextOutput(
            JSON.stringify(result),
            'RESPONSE_TOO_LARGE',
            '定时任务响应文本超过 50 KiB；未发送完整内容',
          );
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          if (!TOOL_ERROR_CODES.has(error?.code)) throw error;
          return errorOutput(error.code, error.message, error.outcome);
        }
      },
    }),
  ];
}
