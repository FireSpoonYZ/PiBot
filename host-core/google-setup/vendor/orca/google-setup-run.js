// From stablyai/orca v1.4.265 (src/shared/google/google-setup-run.ts).
// Copyright (c) 2026 Lovecast Inc. See ../../LICENSE-ORCA-MIT.txt.
const GOOGLE_SETUP_STEPS = [
  // Which Google account, and whether it's work or personal.
  "account",
  "project",
  "apis",
  // The sign-in screen: app name, support email, audience, contact (holds the policy box).
  "branding",
  // A personal app's home page, privacy link and domain on Branding, so it can be published.
  "links",
  "publish",
  // The Desktop OAuth client and its key file.
  "client",
  // The owner's own sign-in with the new app, then turning Google on for the bot.
  "connect"
];
const GOOGLE_SETUP_MODES = ["do-it-for-me", "guide-here", "guide-browser"];
const GOOGLE_SETUP_RUN_MODES = [...GOOGLE_SETUP_MODES, "unchosen"];
const GOOGLE_SETUP_STEP_STATUSES = [
  "pending",
  "active",
  // Waiting on the person: a box only they may tick, or a step handed to them.
  "needs-user",
  "done",
  "failed",
  "skipped"
];
const GOOGLE_SETUP_CARDS = ["path", "account", "kind", "services", "step"];
function currentGoogleSetupStep(run) {
  return GOOGLE_SETUP_STEPS.find((step) => {
    const status = run.steps[step]?.status ?? "pending";
    return status !== "done" && status !== "skipped";
  }) ?? null;
}
function googleSetupAwaitsKey(run) {
  const client = run.steps.client?.status;
  return run.state === "running" && client !== "done" && client !== "skipped";
}
function isGoogleClientsPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://console.cloud.google.com" && parsed.pathname.startsWith("/auth/clients");
  } catch {
    return false;
  }
}
function personDoesGoogleSetupStep(run, step) {
  return run.mode !== "do-it-for-me" || run.personStep === step;
}
export {
  GOOGLE_SETUP_CARDS,
  GOOGLE_SETUP_MODES,
  GOOGLE_SETUP_RUN_MODES,
  GOOGLE_SETUP_STEPS,
  GOOGLE_SETUP_STEP_STATUSES,
  currentGoogleSetupStep,
  googleSetupAwaitsKey,
  isGoogleClientsPage,
  personDoesGoogleSetupStep
};
