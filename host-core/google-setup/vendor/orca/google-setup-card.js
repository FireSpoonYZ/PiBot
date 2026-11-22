// From stablyai/orca v1.4.265 (src/shared/google/google-setup-card.ts).
// Copyright (c) 2026 Lovecast Inc. See ../../LICENSE-ORCA-MIT.txt.
const GOOGLE_SETUP_CARD_PRESENTATION = "google-setup";
function googleSetupCardKey(ref) {
  return ref.step ? `step:${ref.step}` : ref.card;
}
function isNewestGoogleSetupCard(run, ref) {
  return (run.cardCopies?.[googleSetupCardKey(ref)] ?? 0) === (ref.copy ?? 0);
}
export {
  GOOGLE_SETUP_CARD_PRESENTATION,
  googleSetupCardKey,
  isNewestGoogleSetupCard
};
