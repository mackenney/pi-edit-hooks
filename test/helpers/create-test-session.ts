import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
	AuthStorage,
	createAgentSession,
	createWriteTool,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

export interface TestSessionOptions {
	/**
	 * Working directory for the session. Used for config resolution, tool
	 * execution, and the session boundary. Required — pi-edit-hooks is
	 * path-sensitive.
	 */
	cwd: string;

	/**
	 * Override the Anthropic API base URL. Point at a mock server to avoid
	 * real API calls. When omitted, the real Anthropic API is used
	 * (requires ANTHROPIC_API_KEY).
	 */
	mockBaseUrl?: string;

	/**
	 * Extra extensionFactories loaded AFTER the pi-edit-hooks extension.
	 * Useful for capturing events or payloads in tests.
	 */
	extraFactories?: ExtensionFactory[];
}

/**
 * Creates an in-process pi session with the pi-edit-hooks extension loaded.
 *
 * Load order:
 *   1. additionalExtensionPaths  ← pi-edit-hooks extension (tool_result / agent_end handlers)
 *   2. extensionFactories        ← mock provider + any extra factories
 *
 * The mock provider (if mockBaseUrl is set) redirects Anthropic traffic to a
 * local HTTP server, so tests never make real API calls.
 *
 * Tools: only the write tool is registered. The mock server instructs the agent
 * to call it; the extension's tool_result handler then fires and runs onEdit hooks.
 */
export async function createTestSession(options: TestSessionOptions) {
	const { cwd, mockBaseUrl, extraFactories = [] } = options;

	const authStorage = AuthStorage.create();

	if (mockBaseUrl) {
		// Fake key so pi doesn't reject before sending to the mock server.
		authStorage.setRuntimeApiKey("anthropic", "test-api-key");
	}

	const modelRegistry = ModelRegistry.inMemory(authStorage);

	const providerFactory: ExtensionFactory = (pi) => {
		if (mockBaseUrl) {
			pi.registerProvider("anthropic", { baseUrl: mockBaseUrl });
		}
	};

	// agentDir became a required (non-defaulted) option in pi 0.68.x.
	// Mirror pi's own resolution: PI_CODING_AGENT_DIR env var, else ~/.pi/agent.
	const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");

	const loader = new DefaultResourceLoader({
		cwd: resolve(cwd),
		agentDir,
		// noExtensions prevents discovery of global/project extensions so
		// only our additionalExtensionPaths + factories are loaded.
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		additionalExtensionPaths: [resolve("./src/index.ts")],
		extensionFactories: [providerFactory, ...extraFactories],
		systemPromptOverride: () =>
			"You are a test assistant. When asked to write a file, call the write tool " +
			"exactly once with the requested content, then stop.",
	});
	await loader.reload();

	const model = modelRegistry.find("anthropic", "claude-haiku-4-5");
	if (!model) throw new Error("claude-haiku-4-5 not found in model registry");

	const { session } = await createAgentSession({
		model,
		cwd,
		resourceLoader: loader,
		// Only the write tool: the mock server calls it; the extension watches it.
		tools: [createWriteTool(cwd)],
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
		authStorage,
		modelRegistry,
	});

	return session;
}
