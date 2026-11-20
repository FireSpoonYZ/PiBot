// Shared built-in identity and wire bounds for Center-hosted Google Workspace MCP.

export const GOOGLE_WORKSPACE_INSTALLATION_ID = 'builtin-google-workspace-mcp';
export const GOOGLE_WORKSPACE_PACKAGE_ID = 'e-launcher.google-workspace';
export const GOOGLE_WORKSPACE_VERSION = '1.0.0';
export const GOOGLE_WORKSPACE_DISPLAY_NAME = 'Google Workspace';
export const GOOGLE_CALLBACK_PATH = '/api/oauth/google/callback';

// Bounded route-level limits (never raising the global Fastify bodyLimit):
// - configure: Google Web OAuth client JSON is a few KiB; 64 KiB caps abuse.
// - tool calls: upstream Drive downloads/uploads & Gmail attachments cap at ~2.9 MiB raw (~4 MiB base64).
export const GOOGLE_CONFIGURE_BODY_LIMIT = 64 * 1024;
export const GOOGLE_ACTION_BODY_LIMIT = 32 * 1024;
export const GOOGLE_RULE_BODY_LIMIT = 64 * 1024;
export const GOOGLE_TOOL_CALL_BODY_LIMIT = 6 * 1024 * 1024;

export const INTERNAL_GOOGLE_RULE_ROUTE_PREFIX = 'center-internal-google-rule:';
