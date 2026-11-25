// Shared whitelist of safe, caller-actionable operation error codes.
//
// Single source of truth for:
// - Center HTTP status mapping (`OPERATION_ERROR_STATUS`, for `center-server/server.js`)
// - Center MCP tool error mapping (`OPERATION_ERROR_MESSAGES`, for `center-server/mcp/server.js`)
//
// Security invariant:
// - Only explicitly whitelisted domain error codes appear here.
// - Each entry carries a fixed generic message; thrown error.message, stack traces,
//   driver/FS/SQL errors, and unwhitelisted codes are never surfaced to callers.

const OPERATION_ERRORS = Object.freeze({
  // Input & validation (400)
  INVALID_ARGUMENT: Object.freeze({ status: 400, message: 'Invalid argument' }),
  INVALID_CWD: Object.freeze({ status: 400, message: 'Invalid working directory' }),
  VALIDATION_FAILED: Object.freeze({ status: 400, message: 'Validation failed' }),
  UNSUPPORTED_TARGET: Object.freeze({ status: 400, message: 'Unsupported target' }),

  // Authorization & scope permissions (403)
  FORBIDDEN: Object.freeze({ status: 403, message: 'Forbidden' }),
  SCOPE_FORBIDDEN: Object.freeze({ status: 403, message: 'Scope forbidden' }),
  SCOPE_AUTHORITY_REQUIRED: Object.freeze({ status: 403, message: 'Scope authority required' }),

  // Resource lookup (404)
  NOT_FOUND: Object.freeze({ status: 404, message: 'Not found' }),
  BOT_NOT_FOUND: Object.freeze({ status: 404, message: 'Bot not found' }),
  TASK_NOT_FOUND: Object.freeze({ status: 404, message: 'Task not found' }),
  SCOPE_NOT_FOUND: Object.freeze({ status: 404, message: 'Scope not found' }),
  MESSAGE_NOT_FOUND: Object.freeze({ status: 404, message: 'Message not found' }),
  DELIVERY_NOT_FOUND: Object.freeze({ status: 404, message: 'Delivery not found' }),
  SUBMISSION_NOT_FOUND: Object.freeze({ status: 404, message: 'Submission not found' }),
  BOT_REQUEST_NOT_FOUND: Object.freeze({ status: 404, message: 'Bot request not found' }),
  WORK_CONTEXT_NOT_FOUND: Object.freeze({ status: 404, message: 'Work context not found' }),
  ATTACHMENT_NOT_FOUND: Object.freeze({ status: 404, message: 'Attachment not found' }),

  // Conflict & state constraints (409)
  CONFLICT: Object.freeze({ status: 409, message: 'Conflict' }),
  REVISION_CONFLICT: Object.freeze({ status: 409, message: 'Revision conflict' }),
  REQUEST_CONFLICT: Object.freeze({ status: 409, message: 'Request conflict' }),
  INVALID_STATE: Object.freeze({ status: 409, message: 'Invalid state' }),
  BOT_ARCHIVED: Object.freeze({ status: 409, message: 'Bot is archived' }),
  PRIMARY_BOT_PROTECTED: Object.freeze({ status: 409, message: 'Primary bot is protected' }),
  RUNTIME_BUSY: Object.freeze({ status: 409, message: 'Runtime busy' }),
  SCOPE_UNMANAGED: Object.freeze({ status: 409, message: 'Scope is unmanaged' }),
  STALE_INPUT: Object.freeze({ status: 409, message: 'Stale input' }),
  WORK_STOPPED: Object.freeze({ status: 409, message: 'Work is stopped' }),
  WORK_CONTEXT_INACTIVE: Object.freeze({ status: 409, message: 'Work context is inactive' }),
  CONTEXT_LIMIT: Object.freeze({ status: 409, message: 'Context limit exceeded' }),
  MODEL_REQUIRED: Object.freeze({ status: 409, message: 'Model is required' }),
  MODEL_NOT_FOUND: Object.freeze({ status: 409, message: 'Model not available' }),
  AGY_HISTORY_CHANGED: Object.freeze({ status: 409, message: 'Antigravity requires an unchanged session. Use /clear before changing models or continuing with changed instructions/tools; history editing and Pi compaction are unavailable.' }),
  MODEL_NO_VISION: Object.freeze({ status: 409, message: 'Model does not support vision' }),
  PACKAGE_NOT_READY: Object.freeze({ status: 409, message: 'Package not ready' }),
  CANCELLED: Object.freeze({ status: 409, message: 'Operation cancelled' }),

  // Permanently deleted resource (410)
  SCOPE_DELETED: Object.freeze({ status: 410, message: 'Scope deleted' }),

  // Size limits (413)
  PAYLOAD_TOO_LARGE: Object.freeze({ status: 413, message: 'Payload too large' }),
  RESPONSE_TOO_LARGE: Object.freeze({ status: 413, message: 'Response exceeds size limit' }),

  // Rate limits (429)
  RATE_LIMITED: Object.freeze({ status: 429, message: 'Rate limit exceeded' }),

  // Availability & timeouts (503 / 504)
  DEVICE_OFFLINE: Object.freeze({ status: 503, message: 'Device offline' }),
  CENTER_OFFLINE: Object.freeze({ status: 503, message: 'Center offline' }),
  TIMEOUT: Object.freeze({ status: 504, message: 'Operation timed out' }),
  CALL_TIMEOUT: Object.freeze({ status: 504, message: 'Operation timed out' }),
});

/** Whitelisted operation error code -> HTTP status code (for spreading into server.js status map). */
export const OPERATION_ERROR_STATUS = Object.freeze(
  Object.fromEntries(Object.entries(OPERATION_ERRORS).map(([code, { status }]) => [code, status])),
);

/** Whitelisted operation error code -> fixed non-leaking generic message (for MCP tool errors). */
export const OPERATION_ERROR_MESSAGES = Object.freeze(
  Object.fromEntries(Object.entries(OPERATION_ERRORS).map(([code, { message }]) => [code, message])),
);
