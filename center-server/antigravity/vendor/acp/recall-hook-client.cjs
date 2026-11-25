// agy executes this shipped JavaScript directly, without loading TypeScript.
const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { createConnection } = require("node:net");

// Match MAX_FRAME_BYTES in the TypeScript bridge without loading TypeScript.
const MAX_HOOK_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_REPLY_BYTES = MAX_HOOK_INPUT_BYTES + 65;
const HOOK_DEADLINE_MS = 5_000;
const denyNativeTools = process.argv[2] === "--deny-native-tools";
// Persisted older sessions may still call this flag. No denial receipt is needed.
const denyResourceDiscovery = process.argv[2] === "--deny-list-resources";

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

		// Only the native session identifier crosses this private transport.
		// The Center owns the current prompt's queue and image provenance.
		const nonce = randomBytes(16).toString("hex");
		const proof = createHmac("sha256", key).update("read:").update(nonce).update(conversationId).digest("hex");
		const request = JSON.stringify({ conversationId, nonce, proof });
		socket = createConnection({ host: "127.0.0.1", port }, () => socket.end(request));
		const reply = await readBounded(socket, MAX_REPLY_BYTES);
		if (!reply || reply[64] !== 10) return;
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

if (denyNativeTools || denyResourceDiscovery) {
	// The dedicated agent's exact PreToolUse matcher selects business tools.
	// Deny this call only; internal progress and the rest of the turn continue.
	process.stdout.write(JSON.stringify({
		decision: "deny",
		reason: "This action is provided by PiBot host tools. Continue using pibot-bridge codemode, or a directly offered model-only tool. Do not run the native CLI business tool.",
	}) + "\n");
} else {
	requestTurnHook().catch(() => undefined).then((body) => process.stdout.write((body ?? "{}") + "\n"));
}
