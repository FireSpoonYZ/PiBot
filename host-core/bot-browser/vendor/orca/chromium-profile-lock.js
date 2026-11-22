// From stablyai/orca v1.4.265 (src/main/orcad/browser-providers/chromium/external-chromium-browser-session.ts).
// Copyright (c) 2026 Lovecast Inc. See ./LICENSE.
function unwritableProfileLockLine(message) {
  return message.split("\n").find((line) => /SingletonLock: (Permission denied|Read-only file system)/.test(line))?.trim();
}
export {
  unwritableProfileLockLine
};
