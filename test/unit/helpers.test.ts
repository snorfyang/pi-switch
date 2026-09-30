import { describe, expect, it } from "vitest";

import { __internals as api } from "../../index";

describe("maskKey", () => {
	it("shortens long keys to first6…last4", () => {
		expect(api.maskKey("sk-abcdefghijklmnop")).toBe("sk-abc...mnop");
	});

	it("handles short keys", () => {
		expect(api.maskKey("short")).toBe("sho...");
	});
});

describe("makeKeyId", () => {
	it("is stable and value-dependent", () => {
		expect(api.makeKeyId("sk-a")).toBe(api.makeKeyId("sk-a"));
		expect(api.makeKeyId("sk-a")).not.toBe(api.makeKeyId("sk-b"));
	});
});

describe("emptyPool", () => {
	it("starts with no keys", () => {
		expect(api.emptyPool()).toEqual({ keys: [], activeIndex: 0 });
	});
});

describe("dedupePool", () => {
	it("keeps the first entry for a repeated value and follows the active key", () => {
		const pool = {
			keys: [
				{ id: "1", key: "a", label: "first" },
				{ id: "2", key: "a", label: "second" },
				{ id: "3", key: "b" },
			],
			activeIndex: 1,
		};
		const result = api.dedupePool(pool);
		expect(result.keys.map((entry) => entry.id)).toEqual(["1", "3"]);
		expect(result.activeIndex).toBe(0); // active "a" collapses onto the kept first entry
	});

	it("returns the same pool when there are no duplicates", () => {
		const pool = { keys: [{ id: "1", key: "a" }], activeIndex: 0 };
		expect(api.dedupePool(pool)).toBe(pool);
	});
});

describe("classifyFailure", () => {
	it("classifies balance exhaustion", () => {
		expect(api.classifyFailure({ errorMessage: "Insufficient Balance" })).toBe("balance");
		expect(api.classifyFailure({ errorMessage: "insufficient_quota" })).toBe("balance");
		expect(api.classifyFailure({ errorMessage: "余额不足" })).toBe("balance");
	});

	it("classifies invalid credentials", () => {
		expect(api.classifyFailure({ errorMessage: "Authentication Fails" })).toBe("auth");
		expect(api.classifyFailure({ errorMessage: "401 Unauthorized" })).toBe("auth");
	});

	it("classifies rate limits", () => {
		expect(api.classifyFailure({ errorMessage: "Rate Limit Reached" })).toBe("rate");
		expect(api.classifyFailure({ errorMessage: "server busy" })).toBe("rate");
	});

	it("returns undefined for unclassified and empty messages", () => {
		expect(api.classifyFailure({ errorMessage: "connection reset" })).toBeUndefined();
		expect(api.classifyFailure({ errorMessage: "" })).toBeUndefined();
		expect(api.classifyFailure(undefined)).toBeUndefined();
	});
});

describe("formatKeyRow", () => {
	it("shows marker, index, mask, label and status", () => {
		const entry = { id: "1", key: "sk-abcdefghijkl", label: "main" };
		expect(api.formatKeyRow("deepseek", entry, 0, true)).toBe("▶ #1 sk-abc...ijkl  (main)");
	});

	it("marks disabled keys", () => {
		const entry = { id: "1", key: "sk-abcdefghijkl", disabled: true, disabledReason: "invalid key" };
		expect(api.formatKeyRow("deepseek", entry, 1, false)).toBe("  #2 sk-abc...ijkl  [disabled: invalid key]");
	});
});
