// Browser-safe protocol identifiers; keep in sync with index.d.ts.
export const CAPABILITY_PROTOCOL = 1;
export const CAPABILITY_KINDS = Object.freeze(['plugin', 'mcp', 'skill']);
export const DEPLOYMENT_PHASES = Object.freeze([
  'queued', 'downloading', 'preparing', 'waiting-idle', 'activating', 'applied', 'failed', 'removed',
]);
export const HEALTH_STATES = Object.freeze(['ready', 'disconnected', 'needs-auth', 'unsupported', 'disabled']);
export const RUNTIME_APPLY_STATUSES = Object.freeze(['pending', 'applying', 'waiting-idle', 'applied', 'failed']);
export const ACTIVATION_STATUSES = Object.freeze(['disabled', 'enabling', 'enabled', 'failed']);
