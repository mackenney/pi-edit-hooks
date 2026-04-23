/**
 * Integration tests — mock Anthropic server (no API costs, no API key required).
 *
 * Strategy:
 *   - A local HTTP server captures every POST /v1/messages body and replies
 *     with a canned Anthropic SSE stream.
 *   - Request 1: server returns a write tool_use, causing the agent to call
 *     the write tool (which creates a real file in a temp dir).
 *   - The extension's tool_result handler fires, runs onEdit hooks, and
 *     appends hook output to the tool result content.
 *   - Request 2: the agent sends the modified conversation back. Tests assert
 *     on the captured request 2 body (which includes the injected hook text).
 *   - Request 3+ (onStop failure): the extension's agent_end handler fires,
 *     runs onStop hooks, and calls pi.sendUserMessage to trigger a follow-up
 *     turn. Tests assert on the captured request 3 body.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	collectToolResultText,
	createMockHooksServer,
	getLastUserMessageText,
	waitForRequests,
} from "../helpers/mock-hooks-server.ts";
import { createTestSession } from "../helpers/create-test-session.ts";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeProject(config: object): { dir: string; pyFile: string; cleanup(): void } {
	const dir = mkdtempSync(join(tmpdir(), "pi-edit-hooks-mock-"));
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "edit-hooks.json"), JSON.stringify(config, null, 2));
	const pyFile = join(dir, "test.py");
	return { dir, pyFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("pi-edit-hooks extension — mock server", () => {
	let mockUrl: string;
	let cleanup: () => void;
	let serverStop: () => Promise<void>;

	// Each test creates its own project fixture and mock server instance.
	// afterEach tears them down to keep tests isolated.
	afterEach(async () => {
		cleanup?.();
		await serverStop?.();
	});

	it("onEdit hook output is appended to the tool result (request 2 body)", async () => {
		const { dir, pyFile, cleanup: c } = makeProject({
			onEdit: { "*.py": "echo HOOK_FIRED" },
		});
		cleanup = c;

		const server = createMockHooksServer({ filePath: pyFile });
		mockUrl = await server.start();
		serverStop = () => server.stop();

		const session = await createTestSession({ cwd: dir, mockBaseUrl: mockUrl });
		await session.prompt("write test.py");

		// Request 2 carries the tool result (with hook output appended).
		expect(server.requests).toHaveLength(2);
		const toolResultText = collectToolResultText(server.requests[1].body);
		expect(toolResultText).toContain("HOOK_FIRED");
		expect(toolResultText).toContain("⚠ onEdit:");
	});

	it("onEdit with no matching glob pattern — no hook text in tool result", async () => {
		const { dir, pyFile, cleanup: c } = makeProject({
			onEdit: { "*.ts": "echo TS_HOOK" }, // .py won't match
		});
		cleanup = c;

		const server = createMockHooksServer({ filePath: pyFile });
		mockUrl = await server.start();
		serverStop = () => server.stop();

		const session = await createTestSession({ cwd: dir, mockBaseUrl: mockUrl });
		await session.prompt("write test.py");

		expect(server.requests).toHaveLength(2);
		const toolResultText = collectToolResultText(server.requests[1].body);
		expect(toolResultText).not.toContain("TS_HOOK");
		expect(toolResultText).not.toContain("⚠ onEdit:");
	});

	it("onEdit with array commands — each command runs and all output appears", async () => {
		const { dir, pyFile, cleanup: c } = makeProject({
			onEdit: { "*.py": ["echo STEP_ONE", "echo STEP_TWO"] },
		});
		cleanup = c;

		const server = createMockHooksServer({ filePath: pyFile });
		mockUrl = await server.start();
		serverStop = () => server.stop();

		const session = await createTestSession({ cwd: dir, mockBaseUrl: mockUrl });
		await session.prompt("write test.py");

		expect(server.requests).toHaveLength(2);
		const toolResultText = collectToolResultText(server.requests[1].body);
		expect(toolResultText).toContain("STEP_ONE");
		expect(toolResultText).toContain("STEP_TWO");
	});

	it("onStop: passes silently — no follow-up request when command exits 0", async () => {
		const { dir, pyFile, cleanup: c } = makeProject({
			onStop: { "*.py": "echo ALL_GOOD" },
		});
		cleanup = c;

		const server = createMockHooksServer({ filePath: pyFile });
		mockUrl = await server.start();
		serverStop = () => server.stop();

		const session = await createTestSession({ cwd: dir, mockBaseUrl: mockUrl });
		await session.prompt("write test.py");

		// Give agent_end handler time to execute and confirm it did NOT send a follow-up.
		await new Promise((r) => setTimeout(r, 1_500));
		expect(server.requests).toHaveLength(2);
	});

	it("onStop: failure sends follow-up message with error output", async () => {
		const { dir, pyFile, cleanup: c } = makeProject({
			onStop: { "*.py": "bash -c 'echo STOP_ERR >&2; exit 1'" },
		});
		cleanup = c;

		const server = createMockHooksServer({ filePath: pyFile });
		mockUrl = await server.start();
		serverStop = () => server.stop();

		const session = await createTestSession({ cwd: dir, mockBaseUrl: mockUrl });
		await session.prompt("write test.py");

		// agent_end fires asynchronously after prompt() returns; poll for request 3.
		const arrived = await waitForRequests(server, 3, 8_000);
		expect(arrived).toBe(true);

		const followUpText = getLastUserMessageText(server.requests[2].body);
		expect(followUpText).toContain("Checks failed after edits");
		expect(followUpText).toContain("STOP_ERR");
	});

	it("path-keyed false disables hooks for that subtree", async () => {
		const { dir, cleanup: c } = makeProject({
			".": { onEdit: { "*.py": "echo ROOT_HOOK" } },
			"legacy/": false,
		});
		cleanup = c;

		mkdirSync(join(dir, "legacy"));
		const legacyFile = join(dir, "legacy", "old.py");

		const server = createMockHooksServer({ filePath: legacyFile });
		mockUrl = await server.start();
		serverStop = () => server.stop();

		const session = await createTestSession({ cwd: dir, mockBaseUrl: mockUrl });
		await session.prompt("write legacy/old.py");

		expect(server.requests).toHaveLength(2);
		const toolResultText = collectToolResultText(server.requests[1].body);
		expect(toolResultText).not.toContain("ROOT_HOOK");
		expect(toolResultText).not.toContain("⚠ onEdit:");
	});

	it("the mock server captured the correct number of requests", async () => {
		const { dir, pyFile, cleanup: c } = makeProject({
			onEdit: { "*.py": "echo COUNTED" },
		});
		cleanup = c;

		const server = createMockHooksServer({ filePath: pyFile });
		mockUrl = await server.start();
		serverStop = () => server.stop();

		const session = await createTestSession({ cwd: dir, mockBaseUrl: mockUrl });
		await session.prompt("write test.py");

		// Exactly 2 requests: initial prompt → tool_use, tool result → end_turn.
		expect(server.requests).toHaveLength(2);
	});
});
