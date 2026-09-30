import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// The extension only needs `lazyStream` from pi-ai at runtime; the rest of
			// its pi imports are type-only. Stub the host packages so unit tests run
			// without installing the (large) pi-ai dependency tree.
			"@earendil-works/pi-ai": fileURLToPath(new URL("./test/stubs/pi-ai.ts", import.meta.url)),
			"@earendil-works/pi-coding-agent": fileURLToPath(
				new URL("./test/stubs/pi-coding-agent.ts", import.meta.url),
			),
		},
	},
	test: {
		environment: "node",
		include: ["test/unit/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
			include: ["index.ts", "keypool.ts"],
			thresholds: {
				lines: 60,
				functions: 60,
				statements: 60,
				branches: 60,
			},
		},
	},
});
