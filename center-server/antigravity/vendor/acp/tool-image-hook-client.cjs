"use strict";

// Small helper invoked by agy's PreInvocation hook for PiBot Center's isolated
// ACP sessions. Reads pending tool-result image steps from the Center process's
// private loopback listener, verifies HMAC authenticity, writes them to stdout,
// and acknowledges stdout completion before exiting.

const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { createConnection } = require("node:net");

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_REPLY_BYTES = 32 * 1024 * 1024;
const HOOK_DEADLINE_MS = 5_000;

function readBounded(stream, limit) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		stream.on("data", (chunk) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buf.length;
			if (size > limit) reject(new Error("payload too large"));
			else chunks.push(buf);
		});
		stream.once("end", () => resolve(Buffer.concat(chunks, size)));
		stream.once("error", reject);
	});
}

async function requestToolImages() {
	const rawPort = process.env.PI_AGY_IMAGE_HOOK_PORT ?? "";
	const rawKey = process.env.PI_AGY_IMAGE_HOOK_KEY ?? "";
	if (!/^\d+$/.test(rawPort) || !/^[a-f0-9]{64}$/i.test(rawKey)) return;
	const port = Number(rawPort);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return;

	const stdin = await readBounded(process.stdin, MAX_STDIN_BYTES);
	const input = JSON.parse(stdin.toString("utf8"));
	if (!input || input.hookEventName !== "PreInvocation") return;
	const conversationId = typeof input.conversationId === "string" ? input.conversationId : "";
	if (!conversationId) return;

	const key = Buffer.from(rawKey, "hex");
	const nonce = randomBytes(16).toString("hex");
	const proof = createHmac("sha256", key).update("read:").update(nonce).update(conversationId).digest("hex");
	const payload = JSON.stringify({ conversationId, nonce, proof });

	let socket;
	const timeout = setTimeout(() => socket?.destroy(), HOOK_DEADLINE_MS);
	try {
		socket = createConnection({ host: "127.0.0.1", port }, () => socket.end(payload));
		const reply = await readBounded(socket, MAX_REPLY_BYTES + 128);
		if (reply.length < 66 || reply[64] !== 10) return;
		const signature = reply.subarray(0, 64).toString("ascii");
		if (!/^[a-f0-9]{64}$/.test(signature)) return;
		const body = reply.subarray(65);
		const expected = createHmac("sha256", key).update("reply:").update(nonce).update(body).digest();
		if (!timingSafeEqual(Buffer.from(signature, "hex"), expected)) return;
		const text = body.toString("utf8");
		const parsed = JSON.parse(text);
		if (!parsed || !Array.isArray(parsed.injectSteps)) return;
		const deliveryProof = createHmac("sha256", key)
			.update("delivered:")
			.update(nonce)
			.update(conversationId)
			.update(body)
			.digest("hex");
		return {
			text,
			port,
			receipt: JSON.stringify({ conversationId, nonce, delivered: true, proof: deliveryProof }),
		};
	} finally {
		clearTimeout(timeout);
		socket?.destroy();
	}
}

// This acknowledges only local helper stdout delivery, not native DB commit.
async function confirmDelivery({ port, receipt }) {
	let socket;
	const timeout = setTimeout(() => socket?.destroy(), HOOK_DEADLINE_MS);
	try {
		socket = createConnection({ host: "127.0.0.1", port }, () => socket.end(receipt));
		// The listener deletes the inFlight nonce before closing; stay alive until EOF
		// so hook exit strictly happens-after receipt processing.
		await readBounded(socket, 64);
	} finally {
		clearTimeout(timeout);
		socket?.destroy();
	}
}

function writeOutput(text) {
	return new Promise((resolve, reject) => {
		process.stdout.write(text + "\n", (error) => (error ? reject(error) : resolve()));
	});
}

process.stdout.on("error", () => {});

void (async () => {
	const reply = await requestToolImages().catch(() => undefined);
	await writeOutput(reply?.text ?? "{}");
	if (reply) await confirmDelivery(reply);
})().catch(() => {
	process.exitCode = 1;
});
