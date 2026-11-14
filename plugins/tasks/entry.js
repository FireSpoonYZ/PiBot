// plugins/tasks/entry.js
// Native host plugin: unified global tasks & step checklist (`task` tool + `tasks`
// prompt section), backed by Center via `host.tasks`.

import { createTaskTool } from './task-tool.js';

function formatBotLabel(bot) {
  return bot?.name ?? bot?.botName ?? bot?.role ?? bot?.botId ?? '未知Bot';
}

function formatCapabilities(bot) {
  const names = [];
  const pushItem = (item) => {
    if (typeof item === 'string' && item.trim()) {
      names.push(item.trim());
    } else if (item && typeof item === 'object' && item.enabled !== false) {
      const label = item.displayName ?? item.name ?? item.id;
      if (typeof label === 'string' && label.trim()) names.push(label.trim());
    }
  };
  for (const field of [bot?.capabilities, bot?.capabilityNames, bot?.skills, bot?.tools]) {
    if (Array.isArray(field)) field.forEach(pushItem);
  }
  const unique = [...new Set(names)];
  if (unique.length > 0) return unique.join(', ');
  if (Array.isArray(bot?.capabilities)) return '无额外扩展能力（仅基础对话）';
  return '未单独标注（请结合职责判断）';
}

function formatBotDirectoryLine(bot, selfDeviceId, selfBotId) {
  const name = formatBotLabel(bot);
  const tags = [];
  if (bot.botId === selfBotId && bot.deviceId === selfDeviceId) tags.push('当前Bot');
  if (bot.isPrimary) tags.push('主Bot');
  if (bot.isDispatcher || bot.dispatcher) tags.push('分派Bot');
  const tagText = tags.length > 0 ? ` [${tags.join(' / ')}]` : '';
  const deviceText = bot.deviceName ? `${bot.deviceName}(${bot.deviceId})` : bot.deviceId;
  const platformText = bot.platform ? `/${bot.platform}` : '';
  const onlineText = bot.online === false ? '离线' : '在线';
  const roleText = bot.description?.trim() || (bot.role && bot.role !== name ? bot.role : '通用助手');
  const capText = formatCapabilities(bot);
  return `- ${name}${tagText} (deviceId=${bot.deviceId}, botId=${bot.botId}) | 设备=${deviceText}${platformText} | 状态=${onlineText} | 职责=${roleText} | 能力=${capText}`;
}

function formatSection({ activeTasks, directoryBots, deviceId, botId }) {
  const lines = [
    '## 全局任务与协作（task 工具）',
    '使用 `task` 工具记录和管理全局任务及个人步骤（已替代旧 `todo` 清单）。用户在对话或语音中顺口交代需要持续跟进、跨步骤或跨 Bot 协作的事项时，主动调用 `task` 记入全局任务。',
    '协作纪律：',
    '1. **分派负责人（`assign`）**：专用任务分派 Bot 或当前协调人移交统筹权时，结合下方目录中各 Bot 的**职责、能力、所属设备与在线概况**由模型语义判断并选择最合适的负责人（禁止简单关键词路由），调用 `task` (`action="assign"`, `coordinatorDeviceId`, `coordinatorBotId`) 指派。',
    '2. **澄清与需求变更范围（`ask_clarification` / `needs_scope`）**：想法含糊或目标边界不清时，先用 `task` (`action="ask_clarification"`) 提问并等待用户回应；若已批准或新收到的需求变更与已完成步骤存在取舍，使用 `adoptionPhase="needs_scope"` 与具体的 `scopeDesc` 说明影响范围，请用户选择保留成果或重做。',
    '3. **计划确认（`propose_plan`）**：仅任务协调人可提交或调整整体分步安排（`propose_plan`）并等待用户在界面点击「确认安排并开始」；未确认前，用户的普通聊天回复不代表批准开工。',
    '4. **已批准需求变更（`adoption.phase === "adjusting"`）**：尽量保留已完成步骤成果（`preserved: true`），使用 `update_step` 修改受影响的未完成步骤，使用 `add_steps` 新增补做项，再用 `update(adoptionPhase=\'adopted\', shortReceipt=...)` 记录回执；**切勿重复调用 `propose_plan` 要求重新确认**。',
    '5. **角色边界与显式验收（`update_step` vs `complete`）**：普通执行 Bot 仅可用 `update_step` 更新指派给自己的步骤（如标为 `working` / `done` 并附 `resultSummary`），不得修改他人或未指派步骤、不得调用 `propose_plan` / `update` 覆盖全局计划、不得调用 `complete` 结束父任务；仅任务协调人在无待回应提示且所有有效步骤均已 `done` 后，显式调用 `complete` 完成收尾验收。',
  ];

  const validBots = directoryBots.filter((b) => b && b.botId && b.deviceId);
  if (validBots.length > 0) {
    lines.push(
      '团队 Bot 目录概况（职责 / 能力 / 设备 / 在线状态）：',
      ...validBots.map((b) => formatBotDirectoryLine(b, deviceId, botId)),
    );
  }

  if (activeTasks.length > 0) {
    lines.push('当前关联的未完成全局任务：');
    for (const task of activeTasks) {
      const isCoord = task.coordinatorBotId === botId && (!task.coordinatorDeviceId || task.coordinatorDeviceId === deviceId);
      const roleTag = isCoord ? '我是协调人' : '我是执行者';
      lines.push(`- ${task.id} [${task.status} | ${roleTag} | rev=${task.revision ?? 0}] ${task.title}`);
      if (task.summary) lines.push(`  摘要: ${task.summary}`);
      if (task.pendingPrompt) {
        const opts = task.pendingPrompt.options?.length
          ? `（选项: ${task.pendingPrompt.options.join(' / ')}）`
          : '';
        lines.push(`  待回应 [${task.pendingPrompt.kind}]: ${task.pendingPrompt.text}${opts}`);
      }
      if (task.adoption && task.adoption.phase !== 'adopted') {
        const scope = task.adoption.scopeDesc ? `（范围: ${task.adoption.scopeDesc}）` : '';
        lines.push(`  需求变更 [${task.adoption.phase}]: ${task.adoption.changeText}${scope}`);
      }
      for (const step of task.steps ?? []) {
        const owner = step.botName || step.botId;
        const ownerTag = owner ? ` (@${owner})` : '';
        const deps = step.dependsOnStepIds?.length ? ` [依赖: ${step.dependsOnStepIds.join(', ')}]` : '';
        const preservedTag = step.preserved ? ' [已保留成果]' : '';
        lines.push(`  - [${step.status}] ${step.id}: ${step.text}${ownerTag}${deps}${preservedTag}`);
      }
    }
  }

  return lines.join('\n');
}

export function createPlugin({ installationId, host }) {
  const bots = new Set();

  return {
    async forBot({ deviceId, botId }) {
      const bot = {
        durableContributions: {
          tools: [createTaskTool({ defineTool: host.sdk.defineTool, installationId, host, deviceId, botId })],
          sections: [
            host.sdk.section('tasks', async (input) => {
              const conversationId = input?.conversationId;
              const activeTasks = (await Promise.resolve(host.tasks?.getActiveForBot?.(botId, conversationId))) ?? [];
              const directoryBots = (await Promise.resolve(host.tasks?.listDirectoryBots?.(botId, conversationId))) ?? [];
              return formatSection({ activeTasks, directoryBots, deviceId, botId });
            }),
          ],
        },
        async prepare() {},
        async activate() {
          host.assertCapabilityAllowed(botId, installationId);
        },
        async quiesce() {},
        async close() {
          await bot.quiesce();
          bots.delete(bot);
        },
      };
      bots.add(bot);
      return bot;
    },
    async close() {
      await Promise.all([...bots].map((bot) => bot.close()));
    },
  };
}
