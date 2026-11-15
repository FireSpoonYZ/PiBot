// plugins/tasks/entry.js
// Native host plugin: unified global tasks & step checklist (`task` tool + `tasks`
// prompt section), backed by Center via `host.tasks`.

import { createTaskTool } from './task-tool.js';
import { projectTaskContext } from './context-projection.js';

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
              const [activeTasks, directoryBots, executionContext] = await Promise.all([
                host.tasks?.getActiveForBot?.(botId, conversationId) ?? [],
                host.tasks?.listDirectoryBots?.(botId, conversationId) ?? [],
                // Only the Host may supply a task focus. Never infer one from
                // conversation text, section input or an SDK generation id.
                host.tasks?.getExecutionContext?.(botId, conversationId) ?? null,
              ]);
              return projectTaskContext({ activeTasks, directoryBots, executionContext, deviceId, botId });
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
