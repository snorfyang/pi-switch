import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __internals as api } from "../../keypool";
import { cleanupTempAgentDir, collect, done, scriptedInteraction, start, streamOf, text, useTempAgentDir } from "./util";

let dir: string;

beforeEach(() => {
	dir = useTempAgentDir();
});

afterEach(() => {
	cleanupTempAgentDir(dir);
});

function fakeBase(overrides: Record<string, unknown> = {}) {
	return {
		id: "deepseek",
		name: "DeepSeek",
		auth: { apiKey: { name: "DeepSeek API key", resolve: async () => ({ auth: { apiKey: "base-key" } }) } },
		getModels: () => [],
		stream: () => streamOf([start, done()]),
		streamSimple: () => streamOf([start, text("hi"), done()]),
		...overrides,
	};
}

describe("buildWrapper", () => {
	it("keeps identity and adds pool auth + wrapped streams", () => {
		const wrapper = api.buildWrapper(fakeBase() as never);
		expect(wrapper.id).toBe("deepseek");
		expect(wrapper.name).toBe("DeepSeek");
		expect(typeof wrapper.auth.apiKey?.login).toBe("function");
		expect(typeof wrapper.stream).toBe("function");
		expect(typeof wrapper.streamSimple).toBe("function");
	});

	it("preserves oauth when present", () => {
		const oauth = { name: "oauth" };
		const wrapper = api.buildWrapper(fakeBase({ auth: { apiKey: { resolve: async () => undefined }, oauth } }) as never);
		expect(wrapper.auth.oauth).toBe(oauth);
	});
});

describe("poolAuth", () => {
	it("reports configured only when the pool has keys", async () => {
		const auth = api.poolAuth(fakeBase({ auth: { apiKey: { resolve: async () => undefined } } }) as never);
		expect(await auth.check!({} as never)).toBeUndefined();
		api.addKey("deepseek", "sk-pool");
		expect(await auth.check!({} as never)).toEqual({ type: "api_key", source: "key pool" });
	});

	it("does not hide a provider that the built-in auth can resolve", async () => {
		const base = fakeBase({
			auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "base-key" }, source: "ANTHROPIC_API_KEY" }) } },
		});
		const auth = api.poolAuth(base as never);
		expect(await auth.check!({} as never)).toEqual({ type: "api_key", source: "ANTHROPIC_API_KEY" });
	});

	it("prefers a side-effect-free base check when present", async () => {
		const base = fakeBase({
			auth: {
				apiKey: {
					check: async () => ({ type: "api_key", source: "base-check" }),
					resolve: async () => undefined,
				},
			},
		});
		const auth = api.poolAuth(base as never);
		expect(await auth.check!({} as never)).toEqual({ type: "api_key", source: "base-check" });
	});

	it("prefers the pool key and otherwise falls back to the built-in auth", async () => {
		const auth = api.poolAuth(fakeBase() as never);
		expect((await auth.resolve!({} as never))?.auth.apiKey).toBe("base-key");
		api.addKey("deepseek", "sk-pool");
		expect((await auth.resolve!({} as never))?.auth.apiKey).toBe("sk-pool");
	});

	it("runs the key-pool login flow", async () => {
		api.addKey("deepseek", "sk-pool");
		const auth = api.poolAuth(fakeBase() as never);
		const interaction = scriptedInteraction(["done"]);
		const credential = await auth.login!(interaction as never);
		expect(credential).toEqual({ type: "api_key", key: "sk-pool" });
	});
});

describe("wrapStreams", () => {
	it("streams through the rotation wrapper", async () => {
		const wrapped = api.wrapStreams(fakeBase() as never);
		const events = await collect(wrapped.streamSimple({ provider: "deepseek", id: "m" } as never, {}, {} as never));
		expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
	});
});

describe("ensureRegistered", () => {
	const registered: unknown[] = [];
	const pi = { registerProvider: (provider: unknown) => registered.push(provider) };

	beforeEach(() => {
		registered.length = 0;
	});

	it("wraps every supported provider", () => {
		const ctx = {
			modelRegistry: {
				getRegisteredNativeProvider: () => undefined,
				getProvider: (id: string) => ({ ...fakeBase(), id, name: id }),
			},
		};
		expect(api.ensureRegistered(pi as never, ctx as never)).toBeUndefined();
		expect((registered as Array<{ id: string }>).map((provider) => provider.id).sort()).toEqual([
			"anthropic",
			"deepseek",
			"google",
			"huggingface",
			"openai",
			"zai-coding-cn",
		]);
	});

	it("wraps the available providers even when one is missing", () => {
		const ctx = {
			modelRegistry: {
				getRegisteredNativeProvider: () => undefined,
				getProvider: (id: string) => (id === "deepseek" ? { ...fakeBase(), id, name: id } : undefined),
			},
		};
		expect(api.ensureRegistered(pi as never, ctx as never)).toContain("not available");
		expect((registered as Array<{ id: string }>).map((provider) => provider.id)).toEqual(["deepseek"]);
	});

	it("leaves an already registered provider alone", () => {
		const base = fakeBase();
		const ctx = {
			modelRegistry: {
				getRegisteredNativeProvider: () => base,
				getProvider: () => base,
			},
		};
		api.ensureRegistered(pi as never, ctx as never);
		expect(registered).toHaveLength(0);
	});

	it("reports a missing provider", () => {
		const ctx = {
			modelRegistry: {
				getRegisteredNativeProvider: () => undefined,
				getProvider: () => undefined,
			},
		};
		expect(api.ensureRegistered(pi as never, ctx as never)).toContain("not available");
	});
});
