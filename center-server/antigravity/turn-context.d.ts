import type { Message } from "@earendil-works/pi-ai";
import type { AntigravityTurnContext } from "../../center-contract/antigravity.js";

export function isHindsightRecallMessage(message: unknown): boolean;

export function validateAntigravityTurnContext(
	messages: readonly Message[],
	turnContext: unknown,
): AntigravityTurnContext;
