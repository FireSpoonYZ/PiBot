// Browser-safe shared constants for the Center-backed Antigravity ACP provider.
export const ANTIGRAVITY_PROVIDER_ID = 'antigravity-acp';
export const ANTIGRAVITY_API = 'pibot-antigravity-acp';
export const ANTIGRAVITY_STREAM_PATH = '/api/host/antigravity/stream';
export const ANTIGRAVITY_CANCEL_PATH = '/api/host/antigravity/cancel';
export const ANTIGRAVITY_MAX_FRAME_BYTES = 33554432;

export const ANTIGRAVITY_POLL_TOOL = {
  name: 'bridge_poll_result',
  description: 'Poll the result of an escalated host bridge tool call that returned STILL RUNNING with a callId.',
  parameters: {
    type: 'object',
    properties: { callId: { type: 'string', description: 'The callId returned in the STILL RUNNING acknowledgement.' } },
    required: ['callId'],
    additionalProperties: false,
  },
};
