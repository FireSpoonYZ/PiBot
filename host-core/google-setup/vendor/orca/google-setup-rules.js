// From stablyai/orca v1.4.265 (src/main/google/google-setup-rules.ts).
// Copyright (c) 2026 Lovecast Inc. See ../../LICENSE-ORCA-MIT.txt.
import {
  GOOGLE_SETUP_STEPS,
  personDoesGoogleSetupStep
} from "./google-setup-run.js";
import { GOOGLE_SERVICE_CHOICES } from "./google-scopes.js";
const GOOGLE_SETUP_STEPS_SET = new Set(GOOGLE_SETUP_STEPS);
const GOOGLE_SERVICE_SET = new Set(GOOGLE_SERVICE_CHOICES);
class GoogleSetupError extends Error {
}
const PERSON_FINISHES = "Only the person can finish this step (signing in, or a step they took): it finishes when they press Done on its card. Tell them what is left, if anything.";
const BOT_CANNOT_TAKE_CLICKS = "Only your owner can hand the clicking back to you. Ask them to press Take over from here on the card.";
const PERSON_STEPS = /* @__PURE__ */ new Set(["connect"]);
function isPersonOwnedStep(run, step) {
  return PERSON_STEPS.has(step) || run.personStep === step || run.steps[step]?.status === "needs-user";
}
const botClicks = (run, step) => !personDoesGoogleSetupStep(run, step);
function recordAnswer(run, actor, card, values, now) {
  const [first, second] = values;
  switch (card) {
    case "path": {
      if (first === "import" || first === "not-now") {
        if (actor === "bot") {
          throw new GoogleSetupError("Only your owner imports a setup file or stops the setup.");
        }
        if (first === "not-now") {
          run.state = "cancelled";
        } else {
          for (const step of IMPORTED_STEPS) {
            run.steps[step] = { status: "skipped", at: now };
          }
        }
        break;
      }
      const mode = GOOGLE_SETUP_MODE_OF[first ?? ""];
      if (!mode) {
        throw new GoogleSetupError("Choose do-it-for-me, guide-here or guide-browser.");
      }
      if (actor === "bot" && mode === "do-it-for-me" && run.mode !== "do-it-for-me") {
        throw new GoogleSetupError(BOT_CANNOT_TAKE_CLICKS);
      }
      run.mode = mode;
      delete run.personStep;
      break;
    }
    case "step": {
      if (OWNER_ONLY_STEP_ANSWERS.has(first ?? "") && actor === "bot") {
        throw new GoogleSetupError(OWNER_RECOVERS);
      }
      if (first === "resume" || first === "start-over") {
      } else if (first === "redo" && isStep(second)) {
        run.steps[second] = { status: "active", at: now };
        if (second === "client") {
          delete run.steps.connect;
          delete run.keyMissed;
        }
      } else if (first === "take-over") {
        if (actor === "bot") {
          throw new GoogleSetupError(BOT_CANNOT_TAKE_CLICKS);
        }
        run.mode = "do-it-for-me";
        delete run.personStep;
        for (const [step, state] of Object.entries(run.steps)) {
          if (state?.status === "needs-user" && isStep(step)) {
            run.steps[step] = { status: "active", at: now };
          }
        }
      } else if (first === "let-me" && isStep(second)) {
        run.personStep = second;
      } else if (first === "done" && isStep(second)) {
        if (actor === "bot") {
          throw new GoogleSetupError(PERSON_FINISHES);
        }
        const theirs = isPersonOwnedStep(run, second) || !botClicks(run, second);
        run.steps[second] = { status: "done", by: theirs ? "user" : "bot", at: now };
        if (second === "client") {
          delete run.keyMissed;
        }
        if (run.personStep === second) {
          delete run.personStep;
        }
      } else {
        throw new GoogleSetupError(
          "A step answer is take-over, let-me <step>, done <step>, redo <step>, resume or start-over."
        );
      }
      break;
    }
    case "account":
      if (first === "other") {
        delete run.account;
        run.steps.account = { status: "active", at: now };
      } else {
        run.account = first;
      }
      break;
    case "kind":
      if (first !== "work" && first !== "personal") {
        throw new GoogleSetupError("Choose work or personal.");
      }
      run.kind = first;
      break;
    case "services":
      run.services = values.filter(isService);
      break;
  }
  run.answers[card] = { values, at: now, ...actor === "bot" ? { typed: true } : {} };
}
const OWNER_ONLY_STEP_ANSWERS = /* @__PURE__ */ new Set(["redo", "resume", "start-over"]);
const OWNER_RECOVERS = "Only your owner presses Make a new key, Continue or Start over, on the setup card. Tell them which one, in those words.";
const GOOGLE_SETUP_MODE_OF = {
  "do-it-for-me": "do-it-for-me",
  "guide-here": "guide-here",
  "guide-browser": "guide-browser"
};
const IMPORTED_STEPS = [
  "account",
  "project",
  "apis",
  "branding",
  "links",
  "publish",
  "client"
];
function isStep(value) {
  return GOOGLE_SETUP_STEPS_SET.has(value ?? "");
}
function isService(value) {
  return GOOGLE_SERVICE_SET.has(value);
}
export {
  BOT_CANNOT_TAKE_CLICKS,
  GoogleSetupError,
  OWNER_RECOVERS,
  PERSON_FINISHES,
  botClicks,
  isPersonOwnedStep,
  recordAnswer
};
