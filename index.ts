/**
 * pi-deepseek-keypool
 *
 * A Pi extension that lets you keep several DeepSeek API keys and rotates
 * automatically when one runs out of balance or hits its rate limit.
 *
 * How it works:
 *  - It replaces the built-in `deepseek` provider with a thin wrapper that
 *    reuses the built-in provider's models + streaming, but resolves the
 *    request key from a local key pool.
 *  - The wrapper buffers the `start` event of a response. If the request fails
 *    before any content is produced (the usual quota / rate-limit shape) it
 *    marks that key and retries the same request with the next usable key.
 *  - A balance / invalid-key failure disables the key (persisted); a rate-limit
 *    failure parks it for a cooldown window.
 *
 * Keys live in `<agent-dir>/deepseek-keypool.json` (mode 0600).
 * Manage them through the normal login flow: `/login deepseek`.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
	Api,
	ApiKeyAuth,
	ApiKeyCredential,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	Provider,
	ProviderAuthInteraction,
	SimpleStreamOptions,
	StreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Configuration
// =============================================================================

const PROVIDER_ID = "deepseek";
const STORE_FILE = "deepseek-keypool.json";
/** A key parked after a transient rate limit is retried after this long. */
const RATE_LIMIT_COOLDOWN_MS = 30_000;

// =============================================================================
// Store
// =============================================================================

interface KeyEntry {
	id: string;
	key: string;
	label?: string;
	/** Set when the key failed with a non-transient reason (balance, bad key). */
	disabled?: boolean;
	disabledReason?: string;
	disabledAt?: number;
}

interface PoolState {
	keys: KeyEntry[];
	activeIndex: number;
}

interface StoreFile {
	version: 1;
	providers: Record<string, PoolState>;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function storePath(): string {
	return join(agentDir(), STORE_FILE);
}

function emptyPool(): PoolState {
	return { keys: [], activeIndex: 0 };
}

function loadStore(): StoreFile {
	try {
		const raw = readFileSync(storePath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<StoreFile>;
		return {
			version: 1,
			providers: parsed.providers && typeof parsed.providers === "object" ? parsed.providers : {},
		};
	} catch {
		return { version: 1, providers: {} };
	}
}

function saveStore(store: StoreFile): void {
	const path = storePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// best effort (e.g. Windows)
	}
}

function getPool(providerId: string): PoolState | undefined {
	return loadStore().providers[providerId];
}

function mutatePool(providerId: string, fn: (pool: PoolState) => void): PoolState {
	const store = loadStore();
	const pool = store.providers[providerId] ?? emptyPool();
	fn(pool);
	if (pool.keys.length === 0) {
		delete store.providers[providerId];
	} else if (pool.activeIndex < 0 || pool.activeIndex >= pool.keys.length) {
		pool.activeIndex = 0;
	}
	store.providers[providerId] = pool;
	saveStore(store);
	return pool;
}

function makeKeyId(key: string): string {
	// Stable short id so cooldowns survive reloads without exposing the secret.
	let hash = 2166136261;
	for (let i = 0; i < key.length; i++) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function addKey(providerId: string, key: string, label?: string): KeyEntry {
	let added: KeyEntry | undefined;
	mutatePool(providerId, (pool) => {
		const entry: KeyEntry = { id: makeKeyId(key), key, label, disabled: false };
		pool.keys.push(entry);
		added = entry;
	});
	return added!;
}

// =============================================================================
// Rotation state (ephemeral)
// =============================================================================

/** providerId -> keyId -> epoch ms until which the key is parked. */
const cooldowns = new Map<string, Map<string, number>>();

function isCoolingDown(providerId: string, entry: KeyEntry): boolean {
	const until = cooldowns.get(providerId)?.get(entry.id);
	return typeof until === "number" && until > Date.now();
}

function parkRateLimited(providerId: string, entry: KeyEntry): void {
	const providerCooldowns = cooldowns.get(providerId) ?? new Map<string, number>();
	providerCooldowns.set(entry.id, Date.now() + RATE_LIMIT_COOLDOWN_MS);
	cooldowns.set(providerId, providerCooldowns);
}

function isUsable(providerId: string, entry: KeyEntry): boolean {
	return !entry.disabled && !isCoolingDown(providerId, entry);
}

/** Usable keys in preference order: current active first, then the rest in order. */
function orderedCandidates(providerId: string): KeyEntry[] {
	const pool = getPool(providerId);
	if (!pool || pool.keys.length === 0) return [];
	const usable = pool.keys.filter((entry) => isUsable(providerId, entry));
	if (usable.length === 0) return [];
	const active = pool.keys[pool.activeIndex];
	const ordered = [...usable];
	if (active && isUsable(providerId, active)) {
		return [active, ...ordered.filter((entry) => entry.id !== active.id)];
	}
	return ordered;
}

/** Best key for auth resolution: a usable one, else any so the provider counts as configured. */
function preferredKey(providerId: string, pool: PoolState): KeyEntry | undefined {
	const usable = pool.keys.find((entry) => !entry.disabled && !isCoolingDown(providerId, entry));
	return usable ?? pool.keys[0];
}

type FailureKind = "balance" | "auth" | "rate";

function classifyFailure(message: AssistantMessage | undefined): FailureKind | undefined {
	const raw = message?.errorMessage ?? "";
	if (!raw) return undefined;
	if (/insufficient.?balance|insufficient_quota|quota|out of budget|billing|not enough balance|余额不足|欠费/i.test(raw)) {
		return "balance";
	}
	if (/invalid.?api.?key|authentication fail|unauthorized|invalid token|\b401\b|api key not valid/i.test(raw)) {
		return "auth";
	}
	if (/rate.?limit|too many requests|\b429\b|overloaded|server busy|请求过多|服务繁忙/i.test(raw)) {
		return "rate";
	}
	return undefined;
}

function noteFailure(providerId: string, entry: KeyEntry, kind: FailureKind, _detail: string): void {
	if (kind === "rate") parkRateLimited(providerId, entry);
	mutatePool(providerId, (pool) => {
		const index = pool.keys.findIndex((candidate) => candidate.id === entry.id);
		if (kind !== "rate" && index >= 0) {
			const target = pool.keys[index];
			target.disabled = true;
			target.disabledReason = kind === "balance" ? "insufficient balance" : "invalid key";
			target.disabledAt = Date.now();
		}
		// Advance the active pointer so future sessions start on a fresh key.
		if (index >= 0 && pool.keys.length > 0) pool.activeIndex = (index + 1) % pool.keys.length;
	});
}

// =============================================================================
// Streaming wrapper
// =============================================================================

async function* attemptWithRotation(
	base: Provider,
	method: "stream" | "streamSimple",
	model: Model<Api>,
	context: TranscriptContext,
	options: (StreamOptions & Record<string, unknown>) | undefined,
): AsyncGenerator<AssistantMessageEvent> {
	const providerId = model.provider;
	const candidates = orderedCandidates(providerId);
	const attempts: (KeyEntry | undefined)[] = candidates.length > 0 ? candidates : [undefined];

	for (let attempt = 0; attempt < attempts.length; attempt++) {
		const entry = attempts[attempt];
		const apiKey = entry?.key ?? options?.apiKey;
		const callOptions = { ...(options ?? {}), apiKey } as StreamOptions & Record<string, unknown>;
		const inner = (base[method] as unknown as (
			model: Model<Api>,
			context: TranscriptContext,
			options: StreamOptions,
		) => AssistantMessageEventStream)(model, context, callOptions);

		const iterator = inner[Symbol.asyncIterator]();
		const pending: AssistantMessageEvent[] = [];
		let committed = false;
		let errorEvent: Extract<AssistantMessageEvent, { type: "error" }> | undefined;

		while (true) {
			const { value, done } = await iterator.next();
			if (done) break;
			if (value.type === "start") {
				pending.push(value);
				continue;
			}
			if (value.type === "error") {
				errorEvent = value;
				break;
			}
			// First real content (or `done`): commit to this attempt.
			for (const buffered of pending) yield buffered;
			pending.length = 0;
			committed = true;
			yield value;
			if (value.type === "done") return;
		}

		const failure = errorEvent ? classifyFailure(errorEvent.error) : undefined;
		const canRetry = Boolean(failure && entry && !committed && attempt < attempts.length - 1);

		if (canRetry) {
			noteFailure(providerId, entry!, failure!, errorEvent?.error.errorMessage ?? "");
			continue;
		}

		for (const buffered of pending) yield buffered;
		if (errorEvent) yield errorEvent;
		return;
	}
}

function wrapStreams(base: Provider): Pick<Provider, "stream" | "streamSimple"> {
	return {
		stream: (model, context, options) =>
			lazyStream(model, async () =>
				attemptWithRotation(base, "stream", model as Model<Api>, context, options as StreamOptions),
			),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () =>
				attemptWithRotation(base, "streamSimple", model as Model<Api>, context, options as SimpleStreamOptions),
			),
	};
}

function poolAuth(base: Provider): ApiKeyAuth {
	const baseAuth = base.auth.apiKey;
	return {
		name: baseAuth?.name ?? `${base.name} API key`,
		// `/login <provider>` lands here: the whole key-pool management menu is the
		// provider's api-key login flow, so there is no separate slash command.
		login: (interaction) => runKeyPoolLogin(interaction),
		check: async (input) => {
			const pool = getPool(base.id);
			if (pool && pool.keys.length > 0) return { type: "api_key", source: "key pool" };
			return baseAuth?.check ? baseAuth.check(input) : undefined;
		},
		resolve: async (input) => {
			const pool = getPool(base.id);
			const preferred = pool ? preferredKey(base.id, pool) : undefined;
			if (preferred) {
				return { auth: { apiKey: preferred.key }, source: `key pool (${pool!.keys.length} keys)` };
			}
			return baseAuth ? baseAuth.resolve(input) : undefined;
		},
	};
}

// =============================================================================
// Provider registration
// =============================================================================

let wrappedProvider: Provider | undefined;
let registry: ExtensionContext["modelRegistry"] | undefined;

function buildWrapper(base: Provider): Provider {
	return {
		...base,
		auth: { apiKey: poolAuth(base), oauth: base.auth.oauth },
		...wrapStreams(base),
	};
}

/**
 * Wrap the built-in provider once the runtime is available. The built-in
 * provider is captured before we replace it, so streaming is delegated to the
 * original implementation and only the key + retry behavior changes.
 */
function ensureRegistered(pi: ExtensionAPI, ctx: ExtensionContext): string | undefined {
	try {
		const existing = ctx.modelRegistry.getRegisteredNativeProvider(PROVIDER_ID);
		if (existing && existing === wrappedProvider) return undefined;
		if (existing) return undefined; // another extension owns this provider id

		const base = ctx.modelRegistry.getProvider(PROVIDER_ID);
		if (!base) return `provider "${PROVIDER_ID}" is not available`;

		registry = ctx.modelRegistry;
		wrappedProvider = buildWrapper(base);
		pi.registerProvider(wrappedProvider);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

// =============================================================================
// Key management, exposed as the provider's api-key /login flow
// =============================================================================

function maskKey(key: string): string {
	if (key.length <= 12) return `${key.slice(0, 3)}...`;
	return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

/**
 * One menu row. The login selector only renders `label` (it drops
 * `description`), so the label and status must live in this string.
 */
function formatKeyRow(providerId: string, entry: KeyEntry, index: number, active: boolean): string {
	const marker = active ? "▶" : " ";
	const label = entry.label ? `  (${entry.label})` : "";
	const status = entry.disabled
		? `  [disabled: ${entry.disabledReason ?? "unknown"}]`
		: isCoolingDown(providerId, entry)
			? "  [cooling down]"
			: "";
	return `${marker} #${index + 1} ${maskKey(entry.key)}${label}${status}`;
}

async function addKeyInteractive(providerId: string, interaction: ProviderAuthInteraction): Promise<void> {
	const key = (await interaction.prompt({ type: "secret", message: "Paste your DeepSeek API key (sk-...)" })).trim();
	if (!key) return;
	const label = (await interaction.prompt({ type: "text", message: "Label for this key (optional)" })).trim();
	addKey(providerId, key, label || undefined);
	interaction.notify({ type: "info", message: `Added ${maskKey(key)}` });
}

const ENV_KEY_NAMES: Record<string, string> = { deepseek: "DEEPSEEK_API_KEY" };

/**
 * Seed the pool from keys the provider already has configured (auth.json,
 * models.json apiKey, or the provider's environment variable) so an existing
 * single-key setup shows up in the pool instead of forcing a re-paste.
 */
async function importExistingKeys(providerId: string): Promise<number> {
	const found = new Map<string, string>();
	try {
		const resolved = await registry?.getApiKeyForProvider(providerId);
		if (resolved?.trim()) found.set(resolved.trim(), "imported");
	} catch {
		// ignore resolution failures; fall through to env / manual entry
	}
	const envName = ENV_KEY_NAMES[providerId];
	const envKey = envName ? process.env[envName]?.trim() : undefined;
	if (envKey && !found.has(envKey)) found.set(envKey, `imported (${envName})`);

	const existing = new Set((getPool(providerId)?.keys ?? []).map((entry) => entry.key));
	let imported = 0;
	for (const [key, label] of found) {
		if (existing.has(key)) continue;
		addKey(providerId, key, label);
		imported++;
	}
	return imported;
}

/**
 * The provider's api-key login flow: add keys, switch the active one, remove
 * keys, or re-enable disabled keys. Returns the active credential so Pi can
 * finish its normal login bookkeeping.
 */
async function runKeyPoolLogin(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
	const providerId = PROVIDER_ID;

	// First run: import keys the provider already has, otherwise ask for one.
	if (!getPool(providerId)?.keys.length) {
		const imported = await importExistingKeys(providerId);
		if (imported > 0) {
			interaction.notify({ type: "info", message: `Imported ${imported} existing DeepSeek key(s)` });
		} else {
			await addKeyInteractive(providerId, interaction);
		}
	}

	for (;;) {
		const pool = getPool(providerId) ?? emptyPool();
		const options = pool.keys.map((entry, index) => ({
			id: `use:${index}`,
			label: formatKeyRow(providerId, entry, index, index === pool.activeIndex),
		}));
		options.push({ id: "add", label: "➕ Add key", description: "Store another DeepSeek API key" });
		if (pool.keys.length > 0) {
			options.push({ id: "label", label: "✎ Set label", description: "Rename a stored key" });
			options.push({ id: "remove", label: "🗑 Remove key" });
			options.push({ id: "reset", label: "↻ Re-enable disabled keys", description: "Clear disabled state and cooldowns" });
		}
		options.push({ id: "done", label: "✔ Done" });

		const choice = await interaction.prompt({
			type: "select",
			message: `DeepSeek key pool (${pool.keys.length} stored)`,
			options,
		});

		if (choice === "done") {
			const preferred = pool.keys.length > 0 ? preferredKey(providerId, pool) : undefined;
			if (!preferred) {
				await addKeyInteractive(providerId, interaction);
				continue;
			}
			interaction.notify({ type: "info", message: `Saved. Active key: ${maskKey(preferred.key)}` });
			return { type: "api_key", key: preferred.key };
		}

		if (choice === "add") {
			await addKeyInteractive(providerId, interaction);
			continue;
		}

		if (choice === "label") {
			const labelOptions = pool.keys.map((entry, index) => ({
				id: `lb:${index}`,
				label: formatKeyRow(providerId, entry, index, false),
			}));
			labelOptions.push({ id: "cancel", label: "Cancel" });
			const target = await interaction.prompt({ type: "select", message: "Label which key?", options: labelOptions });
			if (target?.startsWith("lb:")) {
				const index = Number(target.slice(3));
				const entry = Number.isInteger(index) ? pool.keys[index] : undefined;
				if (entry) {
					const label = (
						await interaction.prompt({
							type: "text",
							message: `New label for ${maskKey(entry.key)} (leave empty to clear)`,
						})
					).trim();
					mutatePool(providerId, (current) => {
						const found = current.keys.find((candidate) => candidate.id === entry.id);
						if (found) found.label = label || undefined;
					});
					interaction.notify({
						type: "info",
						message: label ? `Labeled ${maskKey(entry.key)} as "${label}"` : `Cleared label for ${maskKey(entry.key)}`,
					});
				}
			}
			continue;
		}

		if (choice === "remove") {
			const removeOptions = pool.keys.map((entry, index) => ({
				id: `rm:${index}`,
				label: formatKeyRow(providerId, entry, index, false),
			}));
			removeOptions.push({ id: "cancel", label: "Cancel" });
			const target = await interaction.prompt({ type: "select", message: "Remove which key?", options: removeOptions });
			if (target?.startsWith("rm:")) {
				const index = Number(target.slice(3));
				const entry = Number.isInteger(index) ? pool.keys[index] : undefined;
				if (entry) {
					mutatePool(providerId, (current) => {
						current.keys = current.keys.filter((candidate) => candidate.id !== entry.id);
					});
					interaction.notify({ type: "info", message: `Removed ${maskKey(entry.key)}` });
				}
			}
			continue;
		}

		if (choice === "reset") {
			mutatePool(providerId, (current) => {
				for (const entry of current.keys) {
					entry.disabled = false;
					entry.disabledReason = undefined;
					entry.disabledAt = undefined;
				}
			});
			cooldowns.delete(providerId);
			interaction.notify({ type: "info", message: "Re-enabled all keys" });
			continue;
		}

		if (choice?.startsWith("use:")) {
			const index = Number(choice.slice(4));
			const entry = Number.isInteger(index) ? pool.keys[index] : undefined;
			if (entry) {
				mutatePool(providerId, (current) => {
					current.activeIndex = index;
				});
				interaction.notify({ type: "info", message: `Active key: ${maskKey(entry.key)}` });
			}
		}
	}
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function piDeepSeekKeyPool(pi: ExtensionAPI): void {
	// The runtime is only reachable from a session, so wrap the provider on start.
	// This also re-asserts the wrapper after a session switch rebuilds the runtime.
	// The key-pool UI lives in the provider's api-key login flow: /login deepseek.
	pi.on("session_start", (_event, ctx) => {
		const error = ensureRegistered(pi, ctx);
		if (error) ctx.ui.notify(`deepseek-keypool: ${error}`, "error");
	});
}
