import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __internals as api } from "../../keypool";
import { cleanupTempAgentDir, collect, done, failure, start, streamOf, text, useTempAgentDir } from "./util";

let dir: string;

beforeEach(() => {
	dir = useTempAgentDir();
});

afterEach(() => {
	cleanupTempAgentDir(dir);
});

function baseFor(map: Record<string, unknown[]>) {
	const calls: string[] = [];
	return {
		calls,
		provider: {
			streamSimple: (_model: unknown, _context: unknown, options: { apiKey?: string }) => {
				const key = options.apiKey ?? "";
				calls.push(key);
				return streamOf(map[key] ?? [failure("unknown error")]);
			},
		},
	};
}

const model = (provider: string) => ({ provider, id: "m" }) as never;

describe("isUsable / orderedCandidates / preferredKey", () => {
	it("skips disabled keys", () => {
		api.addKey("p-usable", "sk-disabled");
		api.addKey("p-usable", "sk-ok");
		api.mutatePool("p-usable", (pool) => {
			pool.keys[0].disabled = true;
		});
		expect(api.orderedCandidates("p-usable").map((entry) => entry.key)).toEqual(["sk-ok"]);
	});

	it("puts the active key first then the rest", () => {
		api.addKey("p-order", "sk-a");
		api.addKey("p-order", "sk-b");
		api.addKey("p-order", "sk-c");
		api.mutatePool("p-order", (pool) => {
			pool.activeIndex = 2;
		});
		expect(api.orderedCandidates("p-order").map((entry) => entry.key)).toEqual(["sk-c", "sk-a", "sk-b"]);
	});

	it("returns nothing when the pool is empty or fully disabled", () => {
		expect(api.orderedCandidates("p-none")).toEqual([]);
		api.addKey("p-allbad", "sk-x");
		api.mutatePool("p-allbad", (pool) => {
			pool.keys[0].disabled = true;
		});
		expect(api.orderedCandidates("p-allbad")).toEqual([]);
	});

	it("preferredKey falls back to any key when all are disabled", () => {
		api.addKey("p-pref", "sk-x");
		api.mutatePool("p-pref", (pool) => {
			pool.keys[0].disabled = true;
		});
		const pool = api.getPool("p-pref")!;
		expect(api.isUsable("p-pref", pool.keys[0])).toBe(false);
		expect(api.preferredKey("p-pref", pool)?.key).toBe("sk-x");
	});
});

describe("noteFailure", () => {
	it("disables the key on balance failures and advances the pointer", () => {
		api.addKey("p-nf-bal", "sk-a");
		api.addKey("p-nf-bal", "sk-b");
		const entry = api.getPool("p-nf-bal")!.keys[0];
		api.noteFailure("p-nf-bal", entry, "balance", "Insufficient Balance");
		const pool = api.getPool("p-nf-bal")!;
		expect(pool.keys[0].disabled).toBe(true);
		expect(pool.keys[0].disabledReason).toBe("insufficient balance");
		expect(pool.activeIndex).toBe(1);
	});

	it("only cools down the key on rate limits", () => {
		api.addKey("p-nf-rate", "sk-a");
		api.addKey("p-nf-rate", "sk-b");
		const entry = api.getPool("p-nf-rate")!.keys[0];
		api.noteFailure("p-nf-rate", entry, "rate", "Rate Limit Reached");
		const pool = api.getPool("p-nf-rate")!;
		expect(pool.keys[0].disabled).toBeFalsy();
		expect(api.isCoolingDown("p-nf-rate", pool.keys[0])).toBe(true);
		expect(api.orderedCandidates("p-nf-rate").map((candidate) => candidate.key)).toEqual(["sk-b"]);
	});

	it("labels invalid keys when another key remains", () => {
		api.addKey("p-nf-auth", "sk-a");
		api.addKey("p-nf-auth", "sk-b");
		const entry = api.getPool("p-nf-auth")!.keys[0];
		api.noteFailure("p-nf-auth", entry, "auth", "401");
		expect(api.getPool("p-nf-auth")!.keys[0].disabledReason).toBe("invalid key");
	});

	it("never disables the last usable key", () => {
		api.addKey("p-nf-last", "sk-only");
		const entry = api.getPool("p-nf-last")!.keys[0];
		api.noteFailure("p-nf-last", entry, "balance", "Insufficient Balance");
		const pool = api.getPool("p-nf-last")!;
		expect(pool.keys[0].disabled).toBeFalsy();
		expect(pool.keys[0].disabledReason).toBeUndefined();
	});

	it("keeps the only enabled key when the others are already disabled", () => {
		api.addKey("p-nf-remaining", "sk-a");
		api.addKey("p-nf-remaining", "sk-b");
		api.mutatePool("p-nf-remaining", (pool) => {
			pool.keys[0].disabled = true;
		});
		api.noteFailure("p-nf-remaining", api.getPool("p-nf-remaining")!.keys[1], "balance", "Insufficient Balance");
		expect(api.getPool("p-nf-remaining")!.keys[1].disabled).toBeFalsy();
	});
});

describe("attemptWithRotation", () => {
	it("retries the next key when the first fails with insufficient balance", async () => {
		api.addKey("p-balance", "sk-bad");
		api.addKey("p-balance", "sk-good");
		const base = baseFor({
			"sk-bad": [start, failure("Insufficient Balance")],
			"sk-good": [start, text("hello"), done()],
		});
		const events = await collect(api.attemptWithRotation(base.provider, "streamSimple", model("p-balance"), {}, {}));
		expect(base.calls).toEqual(["sk-bad", "sk-good"]);
		expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
		expect(api.getPool("p-balance")!.keys[0].disabled).toBe(true);
	});

	it("retries on rate limit without disabling the key", async () => {
		api.addKey("p-ratelimit", "sk-limited");
		api.addKey("p-ratelimit", "sk-good");
		const base = baseFor({
			"sk-limited": [start, failure("Rate Limit Reached")],
			"sk-good": [start, text("ok"), done()],
		});
		await collect(api.attemptWithRotation(base.provider, "streamSimple", model("p-ratelimit"), {}, {}));
		expect(base.calls).toEqual(["sk-limited", "sk-good"]);
		expect(api.getPool("p-ratelimit")!.keys[0].disabled).toBeFalsy();
	});

	it("does not retry once content has been produced", async () => {
		api.addKey("p-committed", "sk-a");
		api.addKey("p-committed", "sk-b");
		const base = baseFor({ "sk-a": [start, text("partial"), failure("Rate Limit Reached")] });
		const events = await collect(api.attemptWithRotation(base.provider, "streamSimple", model("p-committed"), {}, {}));
		expect(base.calls).toEqual(["sk-a"]);
		expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "error"]);
	});

	it("surfaces the last error when every key fails", async () => {
		api.addKey("p-allfail", "sk-a");
		api.addKey("p-allfail", "sk-b");
		const base = baseFor({
			"sk-a": [start, failure("Insufficient Balance")],
			"sk-b": [start, failure("Insufficient Balance")],
		});
		const events = await collect(api.attemptWithRotation(base.provider, "streamSimple", model("p-allfail"), {}, {}));
		expect(base.calls).toEqual(["sk-a", "sk-b"]);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("uses the request key when the pool is empty and does not retry", async () => {
		const base = baseFor({ "sk-direct": [start, text("hi"), done()] });
		const events = await collect(
			api.attemptWithRotation(base.provider, "streamSimple", model("p-nopool"), {}, { apiKey: "sk-direct" } as never),
		);
		expect(base.calls).toEqual(["sk-direct"]);
		expect(events.at(-1)?.type).toBe("done");
	});
});
