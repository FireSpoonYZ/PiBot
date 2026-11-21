// From stablyai/orca v1.4.265 (src/main/browser/agent-browser/helper-process/agent-browser-user-settings-isolation.ts).
// Copyright (c) 2026 Lovecast Inc. See ./LICENSE.
function isolateFromUserAgentBrowserSettings(inheritedEnv, keepKeys) {
  return Object.fromEntries(
    Object.entries(inheritedEnv).filter(([key]) => {
      const upper = key.toUpperCase();
      return !upper.startsWith("AGENT_BROWSER_") || keepKeys.includes(upper);
    })
  );
}
export {
  isolateFromUserAgentBrowserSettings
};
