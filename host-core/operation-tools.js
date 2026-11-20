import { defineTool } from '@earendil-works/pi-durable';
import { operationCatalog } from '../center-contract/operations/index.js';
import { resolveBotIdentity } from './bot-identity.js';

export function createOperationTools({ host, getHarness, getCenterClient, dataPrivacy }) {
  return operationCatalog.map(({ name, description, inputSchema, readOnly }) => defineTool({
    name, description, parameters: inputSchema,
    deferred: true,
    replay: readOnly ? 'safe' : 'unsafe',
    outputLimits: { maxBytes: 256 * 1024 },
    async execute(args, api, context) {
      try {
        context.abortSignal?.throwIfAborted();
        const { botId } = await resolveBotIdentity(host, getHarness(), api.conversationId, context);
        const center = getCenterClient();
        if (!center) throw Object.assign(new Error('Center is offline'), { code: 'CENTER_OFFLINE' });
        if (!readOnly) await dataPrivacy?.assertExportAllowed(api.conversationId, { operation: name, callContext: context });
        const result = await center.callOperation({ botId, name, args }, context.abortSignal);
        return { output: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        context.abortSignal?.throwIfAborted();
        const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
          ? error.code : 'OPERATION_FAILED';
        return { isError: true, output: [{ type: 'text', text: JSON.stringify({ code }) }] };
      }
    },
  }));
}
