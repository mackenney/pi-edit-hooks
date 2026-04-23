import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Integration tests run real tools and may wait for async agent_end handlers.
		testTimeout: 30_000,
		// Run test files sequentially — mock servers bind to random ports but
		// singleFork avoids any port-reuse races and keeps output readable.
		pool: "forks",
		poolOptions: {
			forks: { singleFork: true },
		},
	},
});
