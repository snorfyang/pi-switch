import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __internals as api } from "../../keypool";
import { cleanupTempAgentDir, useTempAgentDir } from "./util";

let dir: string;

beforeEach(() => {
	dir = useTempAgentDir();
});

afterEach(() => {
	cleanupTempAgentDir(dir);
});

describe("agentDir / storePath / legacyStorePaths", () => {
	it("uses PI_CODING_AGENT_DIR when set", () => {
		expect(api.agentDir()).toBe(dir);
	});

	it("falls back to ~/.pi/agent", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		expect(api.agentDir()).toBe(join(homedir(), ".pi", "agent"));
	});

	it("builds the current and legacy store paths", () => {
		expect(api.storePath()).toBe(join(dir, "pi-switch.json"));
		expect(api.legacyStorePaths()).toEqual([join(dir, "deepseek-keypool.json")]);
	});
});

describe("loadStore / saveStore", () => {
	it("returns an empty store when nothing exists", () => {
		expect(api.loadStore()).toEqual({ version: 1, providers: {} });
	});

	it("round-trips and writes 0600", () => {
		const store = { version: 1 as const, providers: { deepseek: { keys: [{ id: "1", key: "k" }], activeIndex: 0 } } };
		api.saveStore(store);
		expect(api.loadStore()).toEqual(store);
		if (process.platform !== "win32") {
			expect(statSync(api.storePath()).mode & 0o777).toBe(0o600);
		}
	});

	it("throws on corrupt json but degrades reads to no pool", () => {
		writeFileSync(api.storePath(), "{ not json");
		expect(() => api.loadStore()).toThrow(/not valid JSON/);
		expect(api.getPool("deepseek")).toBeUndefined();
	});

	it("skips malformed provider entries", () => {
		writeFileSync(
			api.storePath(),
			JSON.stringify({ version: 1, providers: { bad: { nope: true }, good: { keys: [{ id: "1", key: "k" }], activeIndex: 0 } } }),
		);
		expect(Object.keys(api.loadStore().providers)).toEqual(["good"]);
	});

	it("dedupes duplicate values when reading", () => {
		writeFileSync(
			api.storePath(),
			JSON.stringify({
				version: 1,
				providers: { deepseek: { keys: [{ id: "1", key: "dup" }, { id: "2", key: "dup" }], activeIndex: 1 } },
			}),
		);
		expect(api.loadStore().providers.deepseek.keys).toHaveLength(1);
	});

	it("reads the legacy store and migrates it away on save", () => {
		const legacy = join(dir, "deepseek-keypool.json");
		writeFileSync(
			legacy,
			JSON.stringify({ version: 1, providers: { deepseek: { keys: [{ id: "1", key: "old" }], activeIndex: 0 } } }),
		);
		expect(api.loadStore().providers.deepseek.keys[0].key).toBe("old");

		api.saveStore(api.loadStore());
		expect(existsSync(legacy)).toBe(false);
		expect(existsSync(api.storePath())).toBe(true);
		expect(JSON.parse(readFileSync(api.storePath(), "utf8")).providers.deepseek.keys[0].key).toBe("old");
	});
});

describe("addKey / hasKeyValue / getPool / mutatePool", () => {
	it("adds unique keys and rejects duplicates", () => {
		const first = api.addKey("deepseek", "sk-one", "primary");
		expect(first?.label).toBe("primary");
		expect(api.addKey("deepseek", "sk-one")).toBeUndefined();
		expect(api.hasKeyValue("deepseek", "sk-one")).toBe(true);
		expect(api.getPool("deepseek")?.keys).toHaveLength(1);
	});

	it("drops the provider entry when the last key is removed", () => {
		api.addKey("deepseek", "sk-one");
		api.mutatePool("deepseek", (pool) => {
			pool.keys = [];
		});
		expect(api.getPool("deepseek")).toBeUndefined();
	});

	it("clamps an out-of-range activeIndex", () => {
		api.addKey("deepseek", "sk-one");
		api.mutatePool("deepseek", (pool) => {
			pool.activeIndex = 99;
		});
		expect(api.getPool("deepseek")?.activeIndex).toBe(0);
	});
});

describe("store durability", () => {
	it("refuses to write when the store is corrupt and leaves the file untouched", () => {
		const bad = "{ not json";
		writeFileSync(api.storePath(), bad);
		expect(api.getPool("deepseek")).toBeUndefined();
		expect(() => api.addKey("deepseek", "sk-x")).toThrow(/not valid JSON/);
		expect(readFileSync(api.storePath(), "utf8")).toBe(bad);
	});

	it("keeps other providers when one provider changes", () => {
		api.addKey("deepseek", "sk-a");
		api.addKey("openai", "sk-b");
		api.mutatePool("deepseek", (pool) => {
			pool.keys[0].disabled = true;
		});
		const store = api.loadStore();
		expect(store.providers.deepseek?.keys[0].disabled).toBe(true);
		expect(store.providers.openai?.keys[0].key).toBe("sk-b");
	});
});
