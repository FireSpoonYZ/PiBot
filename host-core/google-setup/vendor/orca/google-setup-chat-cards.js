// From stablyai/orca v1.4.265 (src/main/google/google-setup-chat-cards.ts).
// Copyright (c) 2026 Lovecast Inc. See ../../LICENSE-ORCA-MIT.txt.
import {
  GOOGLE_SETUP_STEPS,
  personDoesGoogleSetupStep
} from "./google-setup-run.js";
function personsTurn(run, step) {
  const status = run?.steps[step]?.status;
  return status === "needs-user" || status === "active" && run !== null && personDoesGoogleSetupStep(run, step);
}
function answered(run, card) {
  return run?.answers[card] !== void 0;
}
function googleSetupCardsDue(prev, next) {
  const before = prev?.id === next.id ? prev : null;
  const ref = (card, step) => ({
    botId: next.botId,
    runId: next.id,
    card,
    ...step ? { step } : {}
  });
  if (!before) {
    if (next.state !== "running") {
      return [];
    }
    if (!answered(next, "path") || next.mode === "unchosen") {
      return [ref("path")];
    }
    return [answered(next, "services") ? ref("progress") : ref("services")];
  }
  if (next.state === "done") {
    return before.state === "done" ? [] : [ref("connected")];
  }
  if (next.state === "failed") {
    return before.state === "failed" ? [] : [ref("progress")];
  }
  if (next.state !== "running") {
    return [];
  }
  const due = [];
  const path = next.answers.path?.values[0];
  const imported = path === "import";
  if (!answered(before, "path") && answered(next, "path") && !imported) {
    due.push(next.answers.services ? ref("progress") : ref("services"));
  }
  if (!answered(before, "services") && answered(next, "services") && answered(next, "path")) {
    due.push(ref("progress"));
  }
  if ((next.accounts?.length ?? 0) > 1 && !before.accounts?.length && !answered(next, "account")) {
    due.push(ref("account"));
  }
  for (const step of GOOGLE_SETUP_STEPS) {
    if (step !== "connect" && personsTurn(next, step) && !personsTurn(before, step)) {
      due.push(ref("step", step));
    }
  }
  const clientDone = (run) => {
    const status = run.steps.client?.status;
    return status === "done" || status === "skipped";
  };
  if (clientDone(next) && !clientDone(before)) {
    due.push(ref("connect"));
  }
  if (next.keyMissed && !before.keyMissed && !clientDone(next)) {
    due.push(ref("progress"));
  }
  return due;
}
function googleSetupWaitingCard(run) {
  if (run.state !== "running") {
    return null;
  }
  const ref = { botId: run.botId, runId: run.id };
  const handed = GOOGLE_SETUP_STEPS.find((step) => personsTurn(run, step) && step !== "connect");
  if (handed) {
    return { ...ref, card: "step", step: handed };
  }
  const client = run.steps.client?.status;
  if (client === "done" || client === "skipped") {
    return { ...ref, card: "connect" };
  }
  return run.keyMissed ? { ...ref, card: "progress" } : null;
}
export {
  googleSetupCardsDue,
  googleSetupWaitingCard,
  personsTurn
};
