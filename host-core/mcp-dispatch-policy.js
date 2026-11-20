// host-core/mcp-dispatch-policy.js
// Trusted Center -> Host MCP dispatch markers and strict Host-side safe tool policy.
// Standalone Host cannot import Center packages, so trusted marker constants are mirrored here.
//
// Security boundary:
// - Trusted markers are read exclusively from top-level Center delivery envelope fields emitted
//   by `mcp_dispatch_events`, never from untrusted `event.payload` or message text.
// - MCP-triggered turns run under `MCP_SAFE_TOOL_POLICY` (`'mcp-safe'`), which restricts the
//   active conversation AgentDoc to non-tool runtime infrastructure extensions and an explicit
//   empty tool allowlist (`[]`) — excluding local file (`read`/`write`/`edit`/`grep`/`find`/`ls`),
//   CLI/shell (`bash`), `codemode`, desktop/device/browser (`cua_*`/`shower`/`android_*`/`bot_browser`),
//   admin/Bot management, private transcript readers (`session_search`/`read_scope`), vault,
//   schedule, peer-Bot messaging (`send_to`), and arbitrary plugin/MCP tools.
// - In addition to pre-submit AgentDoc restriction, `assertMcpSafeAgentState` is enforced
//   fail-closed in `host.request-context` `beforeRequest` before any provider request is sent.

export const MCP_DISPATCH_TRUSTED_SOURCE = 'mcp-dispatch';
export const MCP_SAFE_TOOL_POLICY = 'mcp-safe';
export const MAX_DISPATCH_ANSWER_CHARS = 128 * 1024;

// Only non-tool runtime infrastructure extensions are permitted during an MCP-safe turn.
export const MCP_SAFE_EXTENSION_NAMES = Object.freeze([
  'host.base-behavior',
  'host.bot-board',
  'host.request-context',
  'cap-final-budget',
]);

// Explicit safe tool allowlist for MCP-triggered turns: empty (no local file, CLI, shell,
// admin, private history, memory, vault, browser, desktop, or plugin tools).
export const MCP_SAFE_TOOL_NAMES = Object.freeze([]);

const SAFE_EXTENSION_SET = new Set(MCP_SAFE_EXTENSION_NAMES);
const SAFE_TOOL_SET = new Set(MCP_SAFE_TOOL_NAMES);

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Identifies trusted MCP dispatch events strictly from top-level Center envelope fields
 * emitted by `mcp_dispatch_events`. Never inspects untrusted `event.payload`.
 */
export function isTrustedMcpDispatchEvent(event) {
  return (
    event?.trustedSource === MCP_DISPATCH_TRUSTED_SOURCE &&
    event?.toolPolicy === MCP_SAFE_TOOL_POLICY
  );
}

/** Validates a trusted Host-internal toolPolicy marker. */
export function isTrustedToolPolicy(value) {
  return value === MCP_SAFE_TOOL_POLICY;
}

/** Identifies a frozen turn governed by the MCP safe tool policy. */
export function isMcpSafeTurn(turn) {
  return isTrustedToolPolicy(turn?.toolPolicy);
}

/**
 * Projects a Bot profile down to the strict MCP safe subset:
 * - Only non-tool runtime infrastructure extensions remain in `selectedExtensions`.
 * - Explicit `allowTools: []` disables all tools on `AgentDoc`.
 * - `codemode`, `codemodeOnly`, and `pluginTools` are disabled/cleared.
 * - Bot identity (`instructions`, `cwd`, `model`, `thinkingLevel`) is preserved.
 */
export function filterSafeMcpProfile(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const safeExtensions = Array.isArray(profile.selectedExtensions)
    ? profile.selectedExtensions.filter((ext) => typeof ext?.name === 'string' && SAFE_EXTENSION_SET.has(ext.name))
    : [];
  return {
    ...profile,
    selectedExtensions: safeExtensions,
    pluginTools: [],
    removeTools: [],
    managedTools: [],
    allowTools: [...MCP_SAFE_TOOL_NAMES],
    codemode: false,
    codemodeOnly: false,
  };
}

/**
 * Checks whether an `AgentDoc` snapshot (string names) or resolved `Agent` (objects with `.name`)
 * complies with the MCP safe tool policy.
 */
export function isAgentStateMcpSafe(agentState) {
  if (!agentState || typeof agentState !== 'object') return false;
  if (!Array.isArray(agentState.extensions) || agentState.extensions.length === 0) return false;
  for (const ext of agentState.extensions) {
    const name = typeof ext === 'string' ? ext : ext?.name;
    if (typeof name !== 'string' || !SAFE_EXTENSION_SET.has(name)) return false;
  }
  if (!Array.isArray(agentState.tools)) return false;
  for (const tool of agentState.tools) {
    const name = typeof tool === 'string' ? tool : tool?.name;
    if (typeof name !== 'string' || !SAFE_TOOL_SET.has(name)) return false;
  }
  return true;
}

/** Fail-closed runtime guard for `GenerationTask.beforeRequest` on MCP-safe turns. */
export function assertMcpSafeAgentState(agentState) {
  if (!isAgentStateMcpSafe(agentState)) {
    throw errWithCode(
      'MCP safe tool policy violation: unsafe extensions or tools enabled on conversation',
      'FORBIDDEN',
    );
  }
}

/**
 * Bounds `answerText` for Center receipt transport without splitting UTF-16 surrogate pairs.
 */
export function boundDispatchAnswerText(value, maxChars = MAX_DISPATCH_ANSWER_CHARS) {
  if (typeof value !== 'string') return '';
  if (value.length <= maxChars) return value;
  const suffix = '\n[truncated]';
  let end = Math.max(0, maxChars - suffix.length);
  if (end > 0) {
    const lastUnit = value.charCodeAt(end - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1;
  }
  return value.slice(0, end) + suffix;
}
