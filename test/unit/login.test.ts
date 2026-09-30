import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __internals as api } from "../../index";
import { cleanupTempAgentDir, scriptedInteraction, useTempAgentDir } from "./util";

let dir: string;

beforeEach(() => {
	dir = useTempAgentDir();
});

afterEach(() => {
	cleanupTempAgentDir(dir);
});

function writeAuth(key: string, type = "api_key") {
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ deepseek: { type, key } }));
}

const asInteraction = (interaction: unknown) => interaction as never;

describe("readStoredKey", () => {
	it("reads a stored api_key credential", () => {
		writeAuth("sk-stored");
		expect(api.readStoredKey("deepseek")).toBe("sk-stored");
	});

	it("ignores other credential types and missing files", () => {
		writeAuth("oauth-token", "oauth");
		expect(api.readStoredKey("deepseek")).toBeUndefined();
		expect(api.readStoredKey("anthropic")).toBeUndefined();
	});
});

describe("importExistingKeys", () => {
	it("seeds an empty pool from the stored credential", () => {
		writeAuth("sk-stored");
		expect(api.importExistingKeys("deepseek")).toBe(1);
		expect(api.getPool("deepseek")?.keys[0]).toMatchObject({ key: "sk-stored", label: "imported" });
	});

	it("returns 0 when there is nothing stored", () => {
		expect(api.importExistingKeys("deepseek")).toBe(0);
	});
});

describe("addKeyInteractive", () => {
	it("adds a key with a label", async () => {
		const interaction = scriptedInteraction(["sk-new", "my label"]);
		await api.addKeyInteractive("deepseek", "DeepSeek", asInteraction(interaction));
		expect(api.getPool("deepseek")?.keys[0]).toMatchObject({ key: "sk-new", label: "my label" });
	});

	it("rejects a duplicate value", async () => {
		api.addKey("deepseek", "sk-dup");
		const interaction = scriptedInteraction(["sk-dup"]);
		await api.addKeyInteractive("deepseek", "DeepSeek", asInteraction(interaction));
		expect(api.getPool("deepseek")?.keys).toHaveLength(1);
		expect(interaction.notifications.some((message) => message.includes("Already in the pool"))).toBe(true);
	});

	it("ignores an empty submission", async () => {
		const interaction = scriptedInteraction([""]);
		await api.addKeyInteractive("deepseek", "DeepSeek", asInteraction(interaction));
		expect(api.getPool("deepseek")).toBeUndefined();
	});
});

describe("runKeyPoolLogin", () => {
	it("imports the stored credential and finishes on Done", async () => {
		writeAuth("sk-stored");
		const interaction = scriptedInteraction(["done"]);
		const credential = await api.runKeyPoolLogin("deepseek", "DeepSeek", asInteraction(interaction));
		expect(credential).toEqual({ type: "api_key", key: "sk-stored" });
	});

	it("prompts for a key when nothing is stored", async () => {
		const interaction = scriptedInteraction(["sk-new", "", "done"]);
		const credential = await api.runKeyPoolLogin("deepseek", "DeepSeek", asInteraction(interaction));
		expect(credential).toEqual({ type: "api_key", key: "sk-new" });
	});

	it("opens a key submenu to switch the active key", async () => {
		api.addKey("deepseek", "sk-a");
		api.addKey("deepseek", "sk-b");
		const id = api.makeKeyId("sk-b");
		const interaction = scriptedInteraction([`key:${id}`, "use", "back", "done"]);
		const credential = await api.runKeyPoolLogin("deepseek", "DeepSeek", asInteraction(interaction));
		expect(credential).toEqual({ type: "api_key", key: "sk-b" });
		expect(api.getPool("deepseek")?.activeIndex).toBe(1);
	});

	it("relabels a key", async () => {
		api.addKey("deepseek", "sk-a");
		const id = api.makeKeyId("sk-a");
		const interaction = scriptedInteraction([`key:${id}`, "label", "renamed", "back", "done"]);
		await api.runKeyPoolLogin("deepseek", "DeepSeek", asInteraction(interaction));
		expect(api.getPool("deepseek")?.keys[0].label).toBe("renamed");
	});

	it("edits a key value", async () => {
		api.addKey("deepseek", "sk-a");
		const id = api.makeKeyId("sk-a");
		const interaction = scriptedInteraction([`key:${id}`, "edit", "sk-replaced", "done"]);
		await api.runKeyPoolLogin("deepseek", "DeepSeek", asInteraction(interaction));
		expect(api.getPool("deepseek")?.keys[0].key).toBe("sk-replaced");
	});

	it("removes a key after confirmation", async () => {
		api.addKey("deepseek", "sk-a");
		api.addKey("deepseek", "sk-b");
		const id = api.makeKeyId("sk-a");
		const interaction = scriptedInteraction([`key:${id}`, "remove", "yes", "done"]);
		await api.runKeyPoolLogin("deepseek", "DeepSeek", asInteraction(interaction));
		expect(api.getPool("deepseek")?.keys.map((entry) => entry.key)).toEqual(["sk-b"]);
	});

	it("re-enables disabled keys", async () => {
		api.addKey("deepseek", "sk-a");
		api.mutatePool("deepseek", (pool) => {
			pool.keys[0].disabled = true;
			pool.keys[0].disabledReason = "insufficient balance";
		});
		const interaction = scriptedInteraction(["reset", "done"]);
		await api.runKeyPoolLogin("deepseek", "DeepSeek", asInteraction(interaction));
		expect(api.getPool("deepseek")?.keys[0].disabled).toBeFalsy();
	});

	it("adds a key through the menu", async () => {
		api.addKey("deepseek", "sk-a");
		const interaction = scriptedInteraction(["add", "sk-b", "second", "done"]);
		await api.runKeyPoolLogin("deepseek", "DeepSeek", asInteraction(interaction));
		expect(api.getPool("deepseek")?.keys.map((entry) => entry.key)).toEqual(["sk-a", "sk-b"]);
	});

	it("forces at least one key before finishing", async () => {
		const interaction = scriptedInteraction(["", "done", "sk-only", "", "done"]);
		const credential = await api.runKeyPoolLogin("deepseek", "DeepSeek", asInteraction(interaction));
		expect(credential).toEqual({ type: "api_key", key: "sk-only" });
	});

	it("propagates cancellation", async () => {
		const interaction = scriptedInteraction([]);
		await expect(api.runKeyPoolLogin("deepseek", "DeepSeek", asInteraction(interaction))).rejects.toThrow(
			"Login cancelled",
		);
	});
});

describe("stored credential cleanup", () => {
	it("forgetStoredKey only removes a matching api_key entry", () => {
		writeAuth("sk-a");
		api.forgetStoredKey("deepseek", "sk-other");
		expect(api.readStoredKey("deepseek")).toBe("sk-a");
		api.forgetStoredKey("deepseek", "sk-a");
		expect(api.readStoredKey("deepseek")).toBeUndefined();
	});

	it("removes Pi's stored credential when the matching key is deleted", async () => {
		writeAuth("sk-a");
		api.addKey("deepseek", "sk-a");
		api.addKey("deepseek", "sk-b");
		const id = api.makeKeyId("sk-a");
		await api.runKeyPoolLogin("deepseek", "DeepSeek", scriptedInteraction([`key:${id}`, "remove", "yes", "done"]) as never);
		expect(api.readStoredKey("deepseek")).toBeUndefined();
	});

	it("keeps a stored credential that is not the removed key", async () => {
		writeAuth("sk-b");
		api.addKey("deepseek", "sk-a");
		api.addKey("deepseek", "sk-b");
		const id = api.makeKeyId("sk-a");
		await api.runKeyPoolLogin("deepseek", "DeepSeek", scriptedInteraction([`key:${id}`, "remove", "yes", "done"]) as never);
		expect(api.readStoredKey("deepseek")).toBe("sk-b");
	});

	it("clears the stored credential when its key is replaced", async () => {
		writeAuth("sk-a");
		api.addKey("deepseek", "sk-a");
		const id = api.makeKeyId("sk-a");
		await api.runKeyPoolLogin("deepseek", "DeepSeek", scriptedInteraction([`key:${id}`, "edit", "sk-new", "done"]) as never);
		expect(api.readStoredKey("deepseek")).toBeUndefined();
	});

	it("forgetStoredKey is a no-op without auth.json", () => {
		expect(() => api.forgetStoredKey("deepseek", "sk-x")).not.toThrow();
	});
});
