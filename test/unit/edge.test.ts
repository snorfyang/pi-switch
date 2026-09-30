import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import piSwitch, { __internals as api } from "../../index";
import {
	cleanupTempAgentDir,
	collect,
	done,
	failure,
	scriptedInteraction,
	start,
	streamOf,
	text,
	useTempAgentDir,
} from "./util";

let dir: string;

beforeEach(() => {
	dir = useTempAgentDir();
});

afterEach(() => {
	cleanupTempAgentDir(dir);
});

describe("store robustness", () => {
	it("treats an empty PI_CODING_AGENT_DIR as unset", () => {
		process.env.PI_CODING_AGENT_DIR = "";
		expect(api.agentDir()).toBe(join(homedir(), ".pi", "agent"));
	});

	it("survives providers: null / an array", () => {
		writeFileSync(api.storePath(), JSON.stringify({ version: 1, providers: null }));
		expect(api.loadStore().providers).toEqual({});
		writeFileSync(api.storePath(), JSON.stringify({ version: 1, providers: [1, 2] }));
		expect(api.loadStore().providers).toEqual({});
	});

	it("prefers the new store file over a leftover legacy file", () => {
		writeFileSync(
			join(dir, "deepseek-keypool.json"),
			JSON.stringify({ version: 1, providers: { deepseek: { keys: [{ id: "1", key: "old" }], activeIndex: 0 } } }),
		);
		writeFileSync(
			api.storePath(),
			JSON.stringify({ version: 1, providers: { deepseek: { keys: [{ id: "2", key: "new" }], activeIndex: 0 } } }),
		);
		expect(api.loadStore().providers.deepseek.keys[0].key).toBe("new");
	});

	it("keeps providers isolated in one file", () => {
		api.addKey("provA", "sk-a");
		api.addKey("provB", "sk-b");
		api.mutatePool("provA", (pool) => {
			pool.keys[0].disabled = true;
		});
		expect(api.getPool("provB")?.keys[0].disabled).toBeFalsy();
		expect(Object.keys(api.loadStore().providers).sort()).toEqual(["provA", "provB"]);
	});
});

describe("readStoredKey edge cases", () => {
	it("returns undefined for malformed auth.json", () => {
		writeFileSync(join(dir, "auth.json"), "{ not json");
		expect(api.readStoredKey("deepseek")).toBeUndefined();
	});

	it("returns undefined when the entry has no key", () => {
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ deepseek: { type: "api_key" } }));
		expect(api.readStoredKey("deepseek")).toBeUndefined();
	});

	it("does not re-import a value already in the pool", () => {
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-here" } }));
		api.addKey("deepseek", "sk-here");
		expect(api.importExistingKeys("deepseek")).toBe(0);
	});
});

describe("rotation edge cases", () => {
	const model = (provider: string) => ({ provider, id: "m" }) as never;

	it("still attempts a request when every key was manually disabled", async () => {
		api.addKey("p-alldisabled", "sk-a");
		api.addKey("p-alldisabled", "sk-b");
		api.mutatePool("p-alldisabled", (pool) => {
			for (const entry of pool.keys) entry.disabled = true;
		});
		const calls: string[] = [];
		const base = {
			streamSimple: () => {
				calls.push("called");
				return streamOf([start, failure("Insufficient Balance")]);
			},
		};
		const events = await collect(
			api.attemptWithRotation(base as never, "streamSimple", model("p-alldisabled"), {}, { apiKey: "sk-a" } as never),
		);
		expect(calls).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("still attempts while keys are only cooling down", async () => {
		api.addKey("p-coolall", "sk-a");
		api.noteFailure("p-coolall", api.getPool("p-coolall")!.keys[0], "rate", "Rate Limit Reached");
		const calls: string[] = [];
		const base = {
			streamSimple: () => {
				calls.push("called");
				return streamOf([start, failure("Rate Limit Reached")]);
			},
		};
		await collect(api.attemptWithRotation(base as never, "streamSimple", model("p-coolall"), {}, {}));
		expect(calls).toHaveLength(1);
	});

	it("still attempts when a disabled key is mixed with a cooling one", async () => {
		api.addKey("p-mixed", "sk-dead");
		api.addKey("p-mixed", "sk-cool");
		api.mutatePool("p-mixed", (pool) => {
			pool.keys[0].disabled = true;
		});
		api.noteFailure("p-mixed", api.getPool("p-mixed")!.keys[1], "rate", "Rate Limit Reached");
		const calls: string[] = [];
		const base = {
			streamSimple: () => {
				calls.push("called");
				return streamOf([start, failure("Rate Limit Reached")]);
			},
		};
		await collect(api.attemptWithRotation(base as never, "streamSimple", model("p-mixed"), {}, {}));
		expect(calls).toHaveLength(1);
	});

	it("does not retry or mark a key on an unclassified error", async () => {
		api.addKey("p-unclassified", "sk-a");
		api.addKey("p-unclassified", "sk-b");
		const calls: string[] = [];
		const base = {
			streamSimple: (_m: unknown, _c: unknown, options: { apiKey?: string }) => {
				calls.push(options.apiKey ?? "");
				return streamOf([start, failure("connection reset by peer")]);
			},
		};
		await collect(api.attemptWithRotation(base as never, "streamSimple", model("p-unclassified"), {}, {}));
		expect(calls).toEqual(["sk-a"]);
		expect(api.getPool("p-unclassified")?.keys[0].disabled).toBeFalsy();
	});

	it("does not mark a key when balance fails after content", async () => {
		api.addKey("p-latefail", "sk-a");
		api.addKey("p-latefail", "sk-b");
		const base = {
			streamSimple: () => streamOf([start, text("partial"), failure("Insufficient Balance")]),
		};
		await collect(api.attemptWithRotation(base as never, "streamSimple", model("p-latefail"), {}, {}));
		expect(api.getPool("p-latefail")?.keys[0].disabled).toBeFalsy();
	});

	it("wraps the non-simple stream method too", async () => {
		const wrapper = api.wrapStreams({ stream: () => streamOf([start, done()]) } as never);
		const events = await collect(wrapper.stream({ provider: "p-stream", id: "m" } as never, {}, {} as never));
		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
	});
});

describe("login edge cases", () => {
	it("rejects editing a key to a value already in the pool", async () => {
		api.addKey("deepseek", "sk-a");
		api.addKey("deepseek", "sk-b");
		const id = api.makeKeyId("sk-a");
		const interaction = scriptedInteraction([`key:${id}`, "edit", "sk-b", "back", "done"]);
		await api.runKeyPoolLogin("deepseek", "DeepSeek", interaction as never);
		expect(api.getPool("deepseek")?.keys.map((entry) => entry.key)).toEqual(["sk-a", "sk-b"]);
		expect(interaction.notifications.some((message) => message.includes("already has that value"))).toBe(true);
	});

	it("keeps the old value when editing to empty", async () => {
		api.addKey("deepseek", "sk-a");
		const id = api.makeKeyId("sk-a");
		await api.runKeyPoolLogin("deepseek", "DeepSeek", scriptedInteraction([`key:${id}`, "edit", "", "back", "done"]) as never);
		expect(api.getPool("deepseek")?.keys[0].key).toBe("sk-a");
	});

	it("clears a label with an empty submission", async () => {
		api.addKey("deepseek", "sk-a", "named");
		const id = api.makeKeyId("sk-a");
		await api.runKeyPoolLogin("deepseek", "DeepSeek", scriptedInteraction([`key:${id}`, "label", "", "back", "done"]) as never);
		expect(api.getPool("deepseek")?.keys[0].label).toBeUndefined();
	});

	it("keeps a key when removal is cancelled", async () => {
		api.addKey("deepseek", "sk-a");
		const id = api.makeKeyId("sk-a");
		await api.runKeyPoolLogin("deepseek", "DeepSeek", scriptedInteraction([`key:${id}`, "remove", "no", "back", "done"]) as never);
		expect(api.getPool("deepseek")?.keys).toHaveLength(1);
	});

	it("re-adds a key after the pool is emptied", async () => {
		api.addKey("deepseek", "sk-a");
		const id = api.makeKeyId("sk-a");
		const interaction = scriptedInteraction([`key:${id}`, "remove", "yes", "done", "sk-new", "", "done"]);
		const credential = await api.runKeyPoolLogin("deepseek", "DeepSeek", interaction as never);
		expect(credential).toEqual({ type: "api_key", key: "sk-new" });
	});
});

describe("ensureRegistered errors", () => {
	it("reports a registry failure", () => {
		const pi = { registerProvider: () => {} };
		const ctx = {
			modelRegistry: {
				getRegisteredNativeProvider: () => {
					throw new Error("boom");
				},
				getProvider: () => undefined,
			},
		};
		expect(api.ensureRegistered(pi as never, ctx as never)).toBe("boom");
	});
});

describe("extension factory", () => {
	function captureFactory() {
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		const registered: unknown[] = [];
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers[event] = handler;
			},
			registerProvider: (provider: unknown) => registered.push(provider),
		};
		piSwitch(pi as never);
		return { handlers, registered };
	}

	it("registers the provider on session start", () => {
		const { handlers, registered } = captureFactory();
		const base = {
			id: "deepseek",
			name: "DeepSeek",
			auth: { apiKey: { resolve: async () => undefined } },
			getModels: () => [],
			stream: () => streamOf([]),
			streamSimple: () => streamOf([]),
		};
		const ctx = {
			modelRegistry: {
				getRegisteredNativeProvider: () => undefined,
				getProvider: (id: string) => ({ ...base, id, name: id }),
			},
			ui: { notify: () => {} },
		};
		handlers.session_start({}, ctx);
		expect(registered).toHaveLength(2);
	});

	it("notifies when registration fails", () => {
		const { handlers } = captureFactory();
		const messages: string[] = [];
		const ctx = {
			modelRegistry: {
				getRegisteredNativeProvider: () => undefined,
				getProvider: () => undefined,
			},
			ui: { notify: (message: string) => messages.push(message) },
		};
		handlers.session_start({}, ctx);
		expect(messages.some((message) => message.includes("not available"))).toBe(true);
	});
});

describe("remaining visible branches", () => {
	it("shows a cooling-down status after a rate limit", () => {
		api.addKey("p-coolrow", "sk-c");
		const entry = api.getPool("p-coolrow")!.keys[0];
		api.noteFailure("p-coolrow", entry, "rate", "Rate Limit Reached");
		const row = api.formatKeyRow("p-coolrow", api.getPool("p-coolrow")!.keys[0], 0, false);
		expect(row).toContain("[cooling down]");
	});

	it("flushes a start event when the provider stream ends without a terminal event", async () => {
		const base = { streamSimple: () => streamOf([start]) };
		const events = await collect(
			api.attemptWithRotation(base as never, "streamSimple", { provider: "p-noend", id: "m" } as never, {}, {}),
		);
		expect(events.map((event) => event.type)).toEqual(["start"]);
	});
});
