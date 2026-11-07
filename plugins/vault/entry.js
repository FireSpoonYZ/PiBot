export function createPlugin({ host }) {
  const bots = new Set();
  return {
    async forBot() {
      let active = false;
      let controller = new AbortController();
      const execute = method => async (args, api, context) => {
        if (!active) return { output: [{ type: 'text', text: 'Vault access is not permitted.' }], isError: true };
        try {
          // Preserve Context methods while adding this Bot binding's quiesce/close signal.
          const invocation = method === 'unlock' ? {
            abortSignal: context.abortSignal ? AbortSignal.any([context.abortSignal, controller.signal]) : controller.signal,
            telemetry: context.telemetry,
            value: key => context.value(key),
            toString: () => context.toString(),
          } : context;
          const result = await host.vault[method](args, api, invocation);
          const content = [{ type: 'text', text: JSON.stringify(result) }];
          return { output: content, structuredOutput: { content, isError: false } };
        } catch (error) {
          // The trusted Host facade supplies only fixed, bounded Vault errors.
          return { output: [{ type: 'text', text: JSON.stringify({ code: error.code, message: error.message }) }], isError: true };
        }
      };
      const output = { type: 'object', properties: {
        content: { type: 'array', items: { type: 'object', properties: {
          type: { const: 'text' }, text: { type: 'string' },
        }, required: ['type', 'text'] } }, isError: { type: 'boolean' },
      }, required: ['content', 'isError'] };
      const bot = {
        durableContributions: { tools: [
          host.sdk.defineTool({
            name: 'vault_unlock',
            description: 'Open a private Vault card in this chat so the user can unlock this Host’s Vault, or initialize it on first use. Call directly, not from codemode. Never ask for a master password in chat or tool arguments. Waits for the user and returns only unlocked or cancelled; if already unlocked, returns immediately without extending the idle timeout. Per-Bot item authorization still applies.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            callers: ['model'], replay: 'unsafe', structuredOutputSchema: output, execute: execute('unlock'),
          }),
          host.sdk.defineTool({
            name: 'vault_find',
            description: 'Find safe Vault metadata and opaque secretRef values authorized for this conversation’s Bot. Never request passwords in chat. If locked or not initialized, call vault_unlock directly to open the private in-chat card, then retry after the user unlocks.',
            parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 200 } }, additionalProperties: false },
            structuredOutputSchema: output, replay: 'unsafe', execute: execute('find'),
          }),
          host.sdk.defineTool({
            name: 'vault_fill',
            description: 'Type the password identified by secretRef into a field in the existing Shower session, through private secret input, never generic CUA. Before vault_fill, use ordinary Shower/CUA to focus the intended input control, then reobserve its current full-source-screen coordinates; focus, keyboard or layout changes can move it. target x/y are full Shower source-screen physical pixels, NOT window-relative CUA screenshot coordinates. windowId is an optional positive integer on desktop and unsupported on Android. On Windows, restore and reobserve minimized windows before filling; this tool does not restore them. Does not submit login. Returns status only. If locked, call vault_unlock directly to open the private in-chat card. Interrupted input is unconfirmed: never retry automatically; ask the user to inspect the field.',
            parameters: { type: 'object', properties: {
              secretRef: { type: 'string', minLength: 1, maxLength: 128 },
              target: { type: 'object', properties: {
                x: { type: 'integer', minimum: 0, maximum: 2147483647 },
                y: { type: 'integer', minimum: 0, maximum: 2147483647 },
                windowId: { type: 'integer', minimum: 1, maximum: 2147483647 },
              }, required: ['x', 'y'], additionalProperties: false },
            }, required: ['secretRef', 'target'], additionalProperties: false },
            structuredOutputSchema: output, replay: 'unsafe', executionMode: 'sequential', execute: execute('fill'),
          }),
        ] },
        async prepare() {},
        async activate() {
          if (controller.signal.aborted) controller = new AbortController();
          active = true;
        },
        async quiesce() { active = false; controller.abort(); },
        async close() { await bot.quiesce(); bots.delete(bot); },
      };
      bots.add(bot);
      return bot;
    },
    async close() { await Promise.all([...bots].map(bot => bot.close())); },
  };
}
