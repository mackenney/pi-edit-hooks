/**
 * Integration tests — real Anthropic API with Claude Haiku.
 *
 * These tests make actual API calls. They are automatically skipped when
 * ANTHROPIC_API_KEY is not set so they never block CI without credentials.
 *
 * Cost per full run: ~$0.01 (a handful of Haiku calls with file writes).
 *
 * Strategy:
 *   - Each test creates its own temp project dir with an edit-hooks.json config.
 *   - A real agent session is created with the pi-edit-hooks extension loaded.
 *   - The agent is prompted to write a file; the real LLM decides to call the
 *     write tool, which triggers the extension's tool_result and agent_end handlers.
 *   - Tests assert on the conversation messages or follow-up behavior.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession } from "@mariozechner/pi-coding-agent";
import { describe, it, expect } from "vitest";
import { createTestSession } from "../helpers/create-test-session.ts";

const HAS_KEY = Boolean(process.env["ANTHROPIC_API_KEY"]);

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeProject(config: object): { dir: string; cleanup(): void } {
	const dir = mkdtempSync(join(tmpdir(), "pi-edit-hooks-real-"));
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "edit-hooks.json"), JSON.stringify(config, null, 2));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Serialize all session messages to a searchable string. */
function allText(session: AgentSession): string {
	return JSON.stringify(session.messages);
}

/**
 * After session.prompt() returns the extension's agent_end handler is still
 * running asynchronously (it executes shell commands before queuing follow-ups).
 * Poll until the predicate is satisfied or the timeout expires.
 */
async function waitFor(
	session: AgentSession,
	predicate: (text: string) => boolean,
	timeoutMs = 10_000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate(allText(session))) return true;
		await new Promise((r) => setTimeout(r, 300));
	}
	return false;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_KEY)("pi-edit-hooks extension — real Haiku API", () => {
	it("onEdit: hook output appended to tool result", async () => {
		const { dir, cleanup } = makeProject({ onEdit: { "*.py": "echo EDIT_HOOK_FIRED" } });
		try {
			const session = await createTestSession({ cwd: dir });
			await session.prompt(`Write the file ${join(dir, "test.py")} with content: x = 1`);

			const text = allText(session);
			expect(text).toContain("EDIT_HOOK_FIRED");
			expect(text).toContain("⚠ onEdit");
			expect(text).toContain("config:");
			expect(text).toContain("commands:");
		} finally {
			cleanup();
		}
	});

	it("onStop: clean run sends informational follow-up, no errors", async () => {
		const { dir, cleanup } = makeProject({ onStop: { "*.py": "echo ALL_GOOD" } });
		try {
			const session = await createTestSession({ cwd: dir });
			await session.prompt(`Write the file ${join(dir, "check.py")} with content: y = 2`);

			// onStop sends an informational follow-up (triggerTurn: false) when commands
			// have output but exit 0. Poll until it arrives.
			const found = await waitFor(session, (t) => t.includes("onStop checks after edits"));
			expect(found).toBe(true);
			expect(allText(session)).toContain("✓ ALL_GOOD");
			expect(allText(session)).not.toContain("✗");
		} finally {
			cleanup();
		}
	});

	it("onStop: failure sends follow-up with error output", async () => {
		const { dir, cleanup } = makeProject({
			onStop: { "*.py": "bash -c 'echo STOP_HOOK_ERROR >&2; exit 1'" },
		});
		try {
			const session = await createTestSession({ cwd: dir });
			await session.prompt(`Write the file ${join(dir, "bad.py")} with content: z = 3`);

			// Poll: extension's agent_end fires async, executes the hook, then
			// calls sendUserMessage to queue a follow-up turn.
			const found = await waitFor(session, (t) => t.includes("onStop checks after edits"));
			expect(found).toBe(true);
			expect(allText(session)).toContain("STOP_HOOK_ERROR");
		} finally {
			cleanup();
		}
	});

	it("onEdit with array commands — every step runs", async () => {
		const { dir, cleanup } = makeProject({
			onEdit: { "*.py": ["echo STEP_ONE", "echo STEP_TWO"] },
		});
		try {
			const session = await createTestSession({ cwd: dir });
			await session.prompt(`Write the file ${join(dir, "steps.py")} with content: a = 1`);

			const text = allText(session);
			expect(text).toContain("STEP_ONE");
			expect(text).toContain("STEP_TWO");
		} finally {
			cleanup();
		}
	});

	it("path-keyed false disables hooks for that subtree", async () => {
		const { dir, cleanup } = makeProject({
			".": { onEdit: { "*.py": "echo ROOT_HOOK" } },
			"legacy/": false,
		});
		try {
			mkdirSync(join(dir, "legacy"));
			const session = await createTestSession({ cwd: dir });
			await session.prompt(
				`Write the file ${join(dir, "legacy", "old.py")} with content: old = True`,
			);

			expect(allText(session)).not.toContain("ROOT_HOOK");
		} finally {
			cleanup();
		}
	});
});
