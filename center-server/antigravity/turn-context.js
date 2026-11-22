// Shared wire and service boundary validation for Antigravity turnContext.

const TURN_CONTEXT_KEYS = new Set(['inputIndex', 'auxiliaryIndices']);

function invalidArgument(message) {
	return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

function isPlainObject(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

export function isHindsightRecallMessage(message) {
	return message?.role === 'user' && Object.hasOwn(message, 'hindsightRecall') && message.hindsightRecall === true;
}

export function validateAntigravityTurnContext(messages, turnContext) {
	if (!Array.isArray(messages)) {
		throw invalidArgument('Invalid messages');
	}
	if (!isPlainObject(turnContext)) {
		throw invalidArgument('Invalid turnContext');
	}
	for (const key of Object.keys(turnContext)) {
		if (!TURN_CONTEXT_KEYS.has(key)) {
			throw invalidArgument('Unexpected turnContext field');
		}
	}
	if (turnContext.inputIndex === undefined || turnContext.auxiliaryIndices === undefined) {
		throw invalidArgument('Incomplete turnContext');
	}
	const { inputIndex, auxiliaryIndices } = turnContext;
	if (
		inputIndex !== null &&
		(typeof inputIndex !== 'number' ||
			!Number.isSafeInteger(inputIndex) ||
			inputIndex < 0 ||
			inputIndex >= messages.length)
	) {
		throw invalidArgument('Invalid turnContext.inputIndex');
	}
	if (!Array.isArray(auxiliaryIndices) || auxiliaryIndices.length > messages.length) {
		throw invalidArgument('Invalid turnContext.auxiliaryIndices');
	}
	const auxSet = new Set();
	const normalizedAuxiliaryIndices = [];
	let prev = -1;
	for (let i = 0; i < auxiliaryIndices.length; i++) {
		const idx = auxiliaryIndices[i];
		if (
			typeof idx !== 'number' ||
			!Number.isSafeInteger(idx) ||
			idx <= prev ||
			idx >= messages.length
		) {
			throw invalidArgument('Invalid turnContext.auxiliaryIndices');
		}
		if (messages[idx]?.role !== 'user') {
			throw invalidArgument('turnContext.auxiliaryIndices must reference user messages');
		}
		const normalizedIdx = idx === 0 ? 0 : idx;
		auxSet.add(normalizedIdx);
		normalizedAuxiliaryIndices.push(normalizedIdx);
		prev = normalizedIdx;
	}
	if (inputIndex !== null) {
		const role = messages[inputIndex]?.role;
		if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') {
			throw invalidArgument('Invalid turnContext.inputIndex role');
		}
		if (isHindsightRecallMessage(messages[inputIndex])) {
			throw invalidArgument('turnContext.inputIndex cannot reference automatic Hindsight recall');
		}
	}
	let expectedInputIndex = null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role === 'system' || auxSet.has(i)) continue;
		expectedInputIndex = i;
		break;
	}
	const normalizedInputIndex = inputIndex === null ? null : inputIndex === 0 ? 0 : inputIndex;
	if (expectedInputIndex !== normalizedInputIndex) {
		throw invalidArgument('Contradictory turnContext.inputIndex');
	}
	return {
		inputIndex: normalizedInputIndex,
		auxiliaryIndices: normalizedAuxiliaryIndices,
	};
}
