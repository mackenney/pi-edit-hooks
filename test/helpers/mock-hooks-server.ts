import { createServer, type Server } from "node:http";

export interface CapturedRequest {
	body: Record<string, unknown>;
	headers: Record<string, string | string[] | undefined>;
}

/**
 * Mock Anthropic Messages API server for pi-edit-hooks integration tests.
 *
 * The pi-edit-hooks extension fires on tool_result and agent_end events, which
 * require an actual tool call round-trip. This server simulates that:
 *
 *   Request 1 (user prompt arrives):
 *     → respond with a streaming tool_use for the write tool
 *
 *   Request 2 (tool result arrives, with hook output appended by the extension):
 *     → respond with an end_turn text response
 *
 *   Request 3+ (e.g. onStop follow-up messages from sendUserMessage):
 *     → respond with an end_turn text response
 *
 * Tests assert on captured request bodies:
 *   - Request 2 body contains the hook output injected into the tool result.
 *   - Request 3 body contains the "Checks failed" follow-up (onStop failure).
 */
export function createMockHooksServer(options: {
	/** Absolute path of the file the agent should write. */
	filePath: string;
	/** Content to write into the file (default: "x = 1"). */
	fileContent?: string;
}) {
	const { filePath, fileContent = "x = 1" } = options;
	const requests: CapturedRequest[] = [];

	/** Streaming SSE response asking the agent to call the write tool. */
	function makeWriteToolUseResponse() {
		const toolId = "toolu_01";
		const inputJson = JSON.stringify({ path: filePath, content: fileContent });

		const events: Array<{ event: string; data: unknown }> = [
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: {
						id: "msg_01",
						type: "message",
						role: "assistant",
						model: "claude-haiku-4-5",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: {
							input_tokens: 10,
							output_tokens: 0,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
						},
					},
				},
			},
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: toolId, name: "write", input: {} },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: inputJson },
				},
			},
			{
				event: "content_block_stop",
				data: { type: "content_block_stop", index: 0 },
			},
			{
				event: "message_delta",
				data: {
					type: "message_delta",
					delta: { stop_reason: "tool_use", stop_sequence: null },
					usage: { output_tokens: 10 },
				},
			},
			{
				event: "message_stop",
				data: { type: "message_stop" },
			},
		];

		return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
	}

	/** Streaming SSE response for a simple end_turn text message. */
	function makeEndTurnResponse(text = "Done.") {
		const events: Array<{ event: string; data: unknown }> = [
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: {
						id: "msg_02",
						type: "message",
						role: "assistant",
						model: "claude-haiku-4-5",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: {
							input_tokens: 20,
							output_tokens: 0,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
						},
					},
				},
			},
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text },
				},
			},
			{
				event: "content_block_stop",
				data: { type: "content_block_stop", index: 0 },
			},
			{
				event: "message_delta",
				data: {
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 5 },
				},
			},
			{
				event: "message_stop",
				data: { type: "message_stop" },
			},
		];

		return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
	}

	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk: Buffer) => {
			raw += chunk.toString("utf8");
		});
		req.on("end", () => {
			let body: Record<string, unknown> = {};
			try {
				body = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				/* ignore */
			}

			requests.push({ body, headers: req.headers });

			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});

			// First request: return the write tool_use.
			// All subsequent requests: return end_turn.
			if (requests.length === 1) {
				res.write(makeWriteToolUseResponse());
			} else {
				res.write(makeEndTurnResponse());
			}

			res.end();
		});
	});

	return {
		/** All requests captured so far, in order. */
		get requests() {
			return requests;
		},

		/** Clear captured requests (useful between test cases in the same server). */
		clearRequests() {
			requests.length = 0;
		},

		/** Start the server on a random port. Returns the base URL. */
		start(): Promise<string> {
			return new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					const addr = server.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("unexpected server address"));
						return;
					}
					resolve(`http://127.0.0.1:${addr.port}`);
				});
			});
		},

		/** Stop the server and close all connections. */
		stop(): Promise<void> {
			return new Promise((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
	};
}

/**
 * Poll until the server has received at least `count` requests or the timeout expires.
 * Useful for waiting for async agent_end follow-up messages.
 */
export async function waitForRequests(
	server: ReturnType<typeof createMockHooksServer>,
	count: number,
	timeoutMs = 5_000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (server.requests.length >= count) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

/**
 * Walk a request body's messages array and collect all tool_result content
 * blocks as a single flat string. Useful for asserting on hook output.
 */
export function collectToolResultText(body: Record<string, unknown>): string {
	const parts: string[] = [];

	const messages = body["messages"];
	if (!Array.isArray(messages)) return "";

	for (const msg of messages) {
		if (
			msg === null ||
			typeof msg !== "object" ||
			(msg as Record<string, unknown>)["role"] !== "user"
		) {
			continue;
		}

		const content = (msg as Record<string, unknown>)["content"];
		if (!Array.isArray(content)) continue;

		for (const block of content) {
			if (block === null || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;

			if (b["type"] !== "tool_result") continue;

			const inner = b["content"];
			if (Array.isArray(inner)) {
				for (const ib of inner) {
					if (ib !== null && typeof ib === "object") {
						const text = (ib as Record<string, unknown>)["text"];
						if (typeof text === "string") parts.push(text);
					}
				}
			} else if (typeof inner === "string") {
				parts.push(inner);
			}
		}
	}

	return parts.join("\n");
}

/**
 * Walk a request body's messages array and find the last user message text.
 * Useful for asserting on onStop follow-up message content.
 */
export function getLastUserMessageText(body: Record<string, unknown>): string {
	const messages = body["messages"];
	if (!Array.isArray(messages)) return "";

	// Walk in reverse to find the last user message.
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg === null || typeof msg !== "object") continue;
		const m = msg as Record<string, unknown>;
		if (m["role"] !== "user") continue;

		const content = m["content"];
		if (typeof content === "string") return content;

		if (Array.isArray(content)) {
			return content
				.filter((b) => b !== null && typeof b === "object" && (b as Record<string, unknown>)["type"] === "text")
				.map((b) => (b as Record<string, unknown>)["text"] as string)
				.join("\n");
		}
	}

	return "";
}
