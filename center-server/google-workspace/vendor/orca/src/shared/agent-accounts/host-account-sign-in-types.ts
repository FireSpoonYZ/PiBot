// Minimal type-only extract from upstream src/shared/agent-accounts/host-account-sign-in-types.ts
// for vendored Google Workspace types without pulling unrelated host-account providers.

export type HostAccountSignInPhase =
  | 'starting'
  | 'waiting'
  | 'verifying'
  | 'signedIn'
  | 'failed'
  | 'cancelled'
