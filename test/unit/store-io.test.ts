import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Record every write to the store file (including the atomic temp file). */
const { storeWrites } = vi.hoisted(() => ({ storeWrites: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
			if (String(args[0]).includes("pi-switch.json")) storeWrites.push(String(args[0]));
			return actual.writeFileSync(...args);
		}) as typeof actual.writeFileSync,
	};
});

import { __internals as api } from "../../keypool";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-switch-io-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	storeWrites.length = 0;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("saveStore call count", () => {
	it("only writes the store when it actually changes", () => {
		api.addKey("deepseek", "sk-a");
		expect(storeWrites.length).toBeGreaterThan(0);

		storeWrites.length = 0;
		api.mutatePool("deepseek", () => {}); // no-op
		expect(storeWrites).toHaveLength(0);

		// A rate limit on a single-key pool changes nothing, so it must not write.
		api.noteFailure("deepseek", api.getPool("deepseek")!.keys[0], "rate", "Rate Limit Reached");
		expect(storeWrites).toHaveLength(0);
	});
});
