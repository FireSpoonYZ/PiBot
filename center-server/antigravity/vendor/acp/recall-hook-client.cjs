// agy executes this shipped JavaScript directly, without loading TypeScript.
const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { createConnection } = require("node:net");

// Match MAX_FRAME_BYTES in the TypeScript bridge without loading TypeScript.
const MAX_HOOK_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_REPLY_BYTES = MAX_HOOK_INPUT_BYTES + 65;
const HOOK_DEADLINE_MS = 1_500;
const denyResourceDiscovery = process.argv[2] === "--deny-list-resources";
const nativeResourceDenial = JSON.stringify({
	decision: "deny",
	reason: "Native resource discovery is unavailable in PiBot Center. Continue the reply using the conversation and available pibot-bridge tools.",
});

async function readBounded(stream, maxBytes) {
	const chunks = [];
	let size = 0;
	for await (const chunk of stream) {
		size += chunk.length;
		if (size > maxBytes) return;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size);
}

async function requestTurnHook() {
	const port = Number(process.env.PI_AGY_RECALL_PORT);
	const encodedKey = process.env.PI_AGY_RECALL_KEY ?? "";
	if (!Number.isInteger(port) || port <= 0 || port > 65535 || !/^[a-f0-9]{64}$/.test(encodedKey)) return;
	const key = Buffer.from(encodedKey, "hex");

	let socket;
	const timeout = setTimeout(() => {
		process.stdin.destroy();
		socket?.destroy();
	}, HOOK_DEADLINE_MS);
	try {
		const input = await readBounded(process.stdin, MAX_HOOK_INPUT_BYTES);
		if (!input) return;
		const event = JSON.parse(input.toString("utf8"));
		const conversationId = event?.conversationId;
		if (typeof conversationId !== "string" || !conversationId || conversationId.length > 256) return;

		let deniedToolCallId;
		if (denyResourceDiscovery) {
			if (event.hookEventName !== "PreToolUse" || event.toolCall?.name !== "list_resources") return;
			deniedToolCallId = event.toolCall.id;
			if (typeof deniedToolCallId !== "string" || deniedToolCallId.length === 0 || deniedToolCallId.length > 256) return;
		}
		// Send only the correlation identifiers. Prompt, tool arguments and
		// workspace data never cross the hook transport.
		const nonce = randomBytes(16).toString("hex");
		const subject = denyResourceDiscovery ? JSON.stringify([conversationId, deniedToolCallId]) : conversationId;
		const proof = createHmac("sha256", key).update(denyResourceDiscovery ? "deny:" : "read:").update(nonce).update(subject).digest("hex");
		const request = JSON.stringify({ conversationId, nonce, proof, deniedToolCallId });
		socket = createConnection({ host: "127.0.0.1", port }, () => socket.end(request));
		const reply = await readBounded(socket, MAX_REPLY_BYTES);
		if (!reply || reply[64] !== 10) return;

		// Authenticate the reply too, in case another process later takes the port.
		const signature = reply.subarray(0, 64).toString("utf8");
		if (!/^[a-f0-9]{64}$/.test(signature)) return;
		const body = reply.subarray(65);
		const expected = createHmac("sha256", key).update("reply:").update(nonce).update(body).digest();
		if (timingSafeEqual(Buffer.from(signature, "hex"), expected)) return body.toString("utf8");
	} finally {
		clearTimeout(timeout);
		socket?.destroy();
	}
}

process.stdout.on("error", () => {});

if (denyResourceDiscovery) {
	// Flush the deny decision before reporting it to Center. AGY waits for
	// the hook to exit, so its failed update follows the receipt.
	process.stdout.write(`${nativeResourceDenial}\n`, (error) => {
		if (!error) void requestTurnHook().catch(() => {});
	});
} else {
	requestTurnHook().catch(() => undefined).then((body) => process.stdout.write(`${body ?? "{}"}\n`));
}
