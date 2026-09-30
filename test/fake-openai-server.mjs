/**
 * Minimal fake OpenAI-compatible server for testing key rotation.
 *
 * BAD_KEY gets HTTP 402 "Insufficient Balance", RATE_KEY gets HTTP 429
 * "Rate Limit Reached", any other key gets a valid SSE completion.
 *
 * Env:
 *   PORT            port to listen on (default 8799)
 *   BAD_KEY         key that should be rejected with 402
 *   LOG             path to append one JSON line per request
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.env.PORT ?? 8799);
const badKey = process.env.BAD_KEY ?? "sk-bad";
const rateKey = process.env.RATE_KEY ?? "sk-rate";
const logPath = process.env.LOG;

function log(entry) {
	const line = `${JSON.stringify(entry)}\n`;
	if (logPath) appendFileSync(logPath, line);
	else process.stdout.write(line);
}

function readBody(req) {
	return new Promise((resolve) => {
		let data = "";
		req.on("data", (chunk) => (data += chunk));
		req.on("end", () => resolve(data));
	});
}

const server = createServer(async (req, res) => {
	const auth = req.headers["authorization"] ?? "";
	const apiKey = auth.replace(/^Bearer\s+/i, "");
	const body = await readBody(req);
	log({ path: req.url, method: req.method, apiKey, bodyLength: body.length });

	if (apiKey === badKey) {
		res.writeHead(402, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				error: {
					message: "Insufficient Balance",
					type: "unknown_error",
					param: null,
					code: "invalid_request_error",
				},
			}),
		);
		return;
	}

	if (apiKey === rateKey) {
		res.writeHead(429, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				error: { message: "Rate Limit Reached", type: "rate_limit_reached_error", code: "rate_limit" },
			}),
		);
		return;
	}

	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const chunk = (delta, finish) =>
		`data: ${JSON.stringify({
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 1,
			model: "fake-model",
			choices: [{ index: 0, delta, finish_reason: finish ?? null }],
		})}\n\n`;
	res.write(chunk({ role: "assistant", content: "pong from " + apiKey.slice(0, 8) }));
	res.write(chunk({}, "stop"));
	res.write("data: [DONE]\n\n");
	res.end();
});

server.listen(port, "127.0.0.1", () => {
	log({ event: "listening", port });
});
