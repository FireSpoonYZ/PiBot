// From stablyai/orca v1.4.265 (src/main/runtime/rpc/methods/bots-google-setup.ts).
// Copyright (c) 2026 Lovecast Inc. See ../../LICENSE-ORCA-MIT.txt.
function googleSetupAnswerLine(card, values) {
  return `Card google-setup/${card} answered: ${values.join(", ")}`;
}
export {
  googleSetupAnswerLine
};
