/**
 * pi-switch
 *
 * A Pi extension that keeps several API keys per provider and rotates to the
 * next one when a key runs out of balance or hits its rate limit. The provider
 * list lives in `PROVIDERS`; everything else is provider-agnostic.
 *
 * How it works:
 *  - It replaces the built-in provider with a thin wrapper that reuses the
 *    built-in provider's models + streaming, but resolves the request key from
 *    a local key pool.
 *  - The wrapper buffers the `start` event of a response. If the request fails
 *    before any content is produced (the usual quota / rate-limit shape) it
 *    marks that key and retries the same request with the next usable key.
 *  - A balance / invalid-key failure disables the key (persisted); a rate-limit
 *    failure parks it for a cooldown window.
 *
 * Keys live in `<agent-dir>/pi-switch.json` (mode 0600).
 * Manage them through the normal login flow: `/login <provider>`.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

/** Supported providers. Add more as they are implemented; each is wrapped at session start. */
const PROVIDERS = ["deepseek", "zai-coding-cn", "anthropic", "google", "huggingface", "openai"];
const STORE_FILE = "pi-switch.json";
/** Older store names, read for migration and removed after the first write. */
const LEGACY_STORE_FILES = ["deepseek-keypool.json"];
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
	// `||` (not `??`) so an empty env var falls back instead of writing to cwd.
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function storePath(): string {
	return join(agentDir(), STORE_FILE);
}

function legacyStorePaths(): string[] {
	return LEGACY_STORE_FILES.map((file) => join(agentDir(), file));
}

function emptyPool(): PoolState {
	return { keys: [], activeIndex: 0 };
}

/** Drop duplicate key values, keeping the first occurrence. */
function dedupePool(pool: PoolState): PoolState {
	const seen = new Set<string>();
	const keys: KeyEntry[] = [];
	for (const entry of pool.keys) {
		if (seen.has(entry.key)) continue;
		seen.add(entry.key);
		keys.push(entry);
	}
	if (keys.length === pool.keys.length) return pool;
	const activeValue = pool.keys[pool.activeIndex]?.key;
	const activeIndex = activeValue ? Math.max(0, keys.findIndex((entry) => entry.key === activeValue)) : 0;
	return { keys, activeIndex };
}

/** The store exists but is not parseable. Never overwrite it; surface the path. */
class StoreCorruptError extends Error {
	constructor(path: string) {
		super(`${path} is not valid JSON. Fix or remove that file, then retry; it was left untouched.`);
		this.name = "StoreCorruptError";
	}
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function loadStore(): StoreFile {
	for (const path of [storePath(), ...legacyStorePaths()]) {
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (error) {
			if (isEnoent(error)) continue; // try the next candidate (new path, then legacy)
			throw error; // e.g. EACCES: never pretend the store is empty and overwrite it
		}
		let parsed: Partial<StoreFile>;
		try {
			parsed = JSON.parse(raw) as Partial<StoreFile>;
		} catch {
			throw new StoreCorruptError(path);
		}
		const providers: Record<string, PoolState> = {};
		if (parsed.providers && typeof parsed.providers === "object") {
			for (const [id, pool] of Object.entries(parsed.providers)) {
				if (!pool || !Array.isArray(pool.keys)) continue;
				providers[id] = dedupePool({
					keys: pool.keys,
					activeIndex: typeof pool.activeIndex === "number" ? pool.activeIndex : 0,
				});
			}
		}
		return { version: 1, providers };
	}
	return { version: 1, providers: {} };
}

function saveStore(store: StoreFile): void {
	const path = storePath();
	mkdirSync(dirname(path), { recursive: true });
	// Write a sibling temp file and rename it into place: a crash mid-write then
	// leaves the previous store intact instead of a truncated/corrupt file.
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(tmp, 0o600);
	} catch {
		// best effort (e.g. Windows)
	}
	renameSync(tmp, path);
	// Drop older store names now that the data has been written here.
	for (const legacy of legacyStorePaths()) {
		try {
			unlinkSync(legacy);
		} catch {
			// nothing to migrate
		}
	}
}

/** Reads the pool, degrading to "no pool" when the store is corrupt/unreadable. */
function getPool(providerId: string): PoolState | undefined {
	try {
		return loadStore().providers[providerId];
	} catch {
		return undefined;
	}
}

function mutatePool(providerId: string, fn: (pool: PoolState) => void): PoolState {
	const store = loadStore(); // throws (and writes nothing) on a corrupt store
	const pool = store.providers[providerId] ?? emptyPool();
	const before = JSON.stringify(store.providers);
	fn(pool);
	if (pool.keys.length === 0) {
		delete store.providers[providerId];
	} else {
		if (pool.activeIndex < 0 || pool.activeIndex >= pool.keys.length) pool.activeIndex = 0;
		store.providers[providerId] = pool;
	}
	// Only touch the disk when something actually changed (a rate-limit failure on
	// a single-key pool, for example, is a no-op).
	if (JSON.stringify(store.providers) !== before) saveStore(store);
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

function hasKeyValue(providerId: string, key: string): boolean {
	return (getPool(providerId)?.keys ?? []).some((entry) => entry.key === key);
}

/** Returns the new entry, or undefined when the value is already in the pool. */
function addKey(providerId: string, key: string, label?: string): KeyEntry | undefined {
	if (hasKeyValue(providerId, key)) return undefined;
	let added: KeyEntry | undefined;
	mutatePool(providerId, (pool) => {
		if (pool.keys.some((entry) => entry.key === key)) return;
		added = { id: makeKeyId(key), key, label, disabled: false };
		pool.keys.push(added);
	});
	return added;
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

/** Best key for auth resolution: the active one if usable, else any usable, else the first. */
function preferredKey(providerId: string, pool: PoolState): KeyEntry | undefined {
	const active = pool.keys[pool.activeIndex];
	if (active && isUsable(providerId, active)) return active;
	return pool.keys.find((entry) => isUsable(providerId, entry)) ?? pool.keys[0];
}

type FailureKind = "balance" | "auth" | "rate";

function classifyFailure(message: AssistantMessage | undefined): FailureKind | undefined {
	const raw = message?.errorMessage ?? "";
	if (!raw) return undefined;
	if (/insufficient.?balance|insufficient.?quota|quota.?exceeded|exceeded.{0,20}quota|out of budget|not enough balance|billing.{0,20}(limit|exceed|required|issue)|余额不足|欠费/i.test(raw)) {
		return "balance";
	}
	if (/invalid.?api.?key|authentication fail|unauthorized|invalid token|api key not valid|\b401\b/i.test(raw)) {
		return "auth";
	}
	if (/rate.?limit|too many requests|\b429\b|overloaded|server busy|请求过多|服务繁忙/i.test(raw)) {
		return "rate";
	}
	return undefined;
}

function noteFailure(providerId: string, entry: KeyEntry, kind: FailureKind, _detail: string): void {
	if (kind === "rate") parkRateLimited(providerId, entry);
	try {
		mutatePool(providerId, (pool) => {
			const index = pool.keys.findIndex((candidate) => candidate.id === entry.id);
			if (kind !== "rate" && index >= 0) {
				// Only disable when another enabled key remains. Disabling the last
				// usable key would force a manual re-enable after a top-up; keeping it
				// lets it recover on its own.
				const hasOtherEnabled = pool.keys.some((candidate) => candidate.id !== entry.id && !candidate.disabled);
				if (hasOtherEnabled) {
					const target = pool.keys[index];
					target.disabled = true;
					target.disabledReason = kind === "balance" ? "insufficient balance" : "invalid key";
					target.disabledAt = Date.now();
				}
			}
			// Advance the active pointer so future sessions start on a fresh key.
			if (index >= 0 && pool.keys.length > 0) pool.activeIndex = (index + 1) % pool.keys.length;
		});
	} catch {
		// A damaged or unreadable store must not turn a provider error into a crash;
		// loadStore left the file untouched and reads fall back to the provider auth.
	}
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
		login: (interaction) => runKeyPoolLogin(base.id, base.name, interaction),
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

function buildWrapper(base: Provider): Provider {
	return {
		...base,
		auth: { apiKey: poolAuth(base), oauth: base.auth.oauth },
		...wrapStreams(base),
	};
}

/**
 * Wrap each supported provider once the runtime is available. The built-in
 * provider is captured before we replace it, so streaming is delegated to the
 * original implementation and only the key + retry behavior changes.
 */
export function ensureRegistered(pi: ExtensionAPI, ctx: ExtensionContext): string | undefined {
	const errors: string[] = [];
	for (const providerId of PROVIDERS) {
		try {
			// Already wrapped by us, or owned by another extension: leave it alone.
			const existing = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
			if (existing) continue;

			const base = ctx.modelRegistry.getProvider(providerId);
			if (!base) {
				// One unavailable provider must not block the rest.
				errors.push(`provider "${providerId}" is not available`);
				continue;
			}

			pi.registerProvider(buildWrapper(base));
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	return errors.length > 0 ? errors.join("; ") : undefined;
}

// =============================================================================
// Key management, exposed as the provider's api-key /login flow
// =============================================================================

function maskKey(key: string): string {
	if (key.length <= 12) return `${key.slice(0, 3)}...`;
	return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

/** Labels are user-provided and rendered in a single-line menu; strip control/format characters. */
function sanitizeLabel(label: string): string {
	return label
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 40);
}

/**
 * One menu row. The login selector only renders `label` (it drops
 * `description`), so the label and status must live in this string.
 */
function formatKeyRow(providerId: string, entry: KeyEntry, index: number, active: boolean): string {
	const marker = active ? "▶" : " ";
	const label = entry.label ? `  (${sanitizeLabel(entry.label)})` : "";
	const status = entry.disabled
		? `  [disabled: ${entry.disabledReason ?? "unknown"}]`
		: isCoolingDown(providerId, entry)
			? "  [cooling down]"
			: "";
	return `${marker} #${index + 1} ${maskKey(entry.key)}${label}${status}`;
}

async function addKeyInteractive(providerId: string, providerName: string, interaction: ProviderAuthInteraction): Promise<void> {
	const key = (await interaction.prompt({ type: "secret", message: `Paste your ${providerName} API key` })).trim();
	if (!key) return;
	if (hasKeyValue(providerId, key)) {
		interaction.notify({ type: "info", message: `Already in the pool: ${maskKey(key)}` });
		return;
	}
	const label = sanitizeLabel((await interaction.prompt({ type: "text", message: "Label for this key (optional)" })).trim());
	addKey(providerId, key, label || undefined);
	interaction.notify({ type: "info", message: `Added ${maskKey(key)}` });
}

/**
 * The api-key credential Pi itself has stored for this provider, read straight
 * from `auth.json`. Environment variables and models.json config are left
 * alone: those keep working through the provider's normal auth fallback, but
 * they are not imported into the pool.
 */
function readStoredKey(providerId: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(agentDir(), "auth.json"), "utf8")) as Record<
			string,
			{ type?: string; key?: string } | undefined
		>;
		const entry = parsed[providerId];
		if (entry?.type === "api_key" && typeof entry.key === "string" && entry.key.trim()) {
			return entry.key.trim();
		}
	} catch {
		// no auth.json / unreadable / no entry
	}
	return undefined;
}

/** Seed an empty pool from Pi's stored credential, if there is one. */
function importExistingKeys(providerId: string): number {
	const stored = readStoredKey(providerId);
	if (!stored) return 0;
	return addKey(providerId, stored, "imported") ? 1 : 0;
}

/**
 * Drop Pi's stored credential for this provider when it holds exactly the key the
 * user just deleted or replaced. Otherwise that value would come back through the
 * built-in auth fallback (or a later import). Written atomically; Pi notices the
 * revision change and reloads. Best effort: a failure must not break the menu.
 */
function forgetStoredKey(providerId: string, key: string): void {
	try {
		const path = join(agentDir(), "auth.json");
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
			string,
			{ type?: string; key?: string } | undefined
		>;
		const entry = parsed[providerId];
		if (!entry || entry.type !== "api_key" || entry.key !== key) return;
		delete parsed[providerId];
		const tmp = `${path}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		try {
			chmodSync(tmp, 0o600);
		} catch {
			// best effort
		}
		renameSync(tmp, path);
	} catch {
		// best effort: no auth.json / unreadable / not a plain api_key entry
	}
}

/**
 * Per-key submenu: use, relabel, replace the secret, or remove one key. Works on
 * the key id so index shifts can never target the wrong key.
 */
async function manageOneKey(providerId: string, interaction: ProviderAuthInteraction, keyId: string): Promise<void> {
	for (;;) {
		const pool = getPool(providerId) ?? emptyPool();
		const index = pool.keys.findIndex((entry) => entry.id === keyId);
		if (index < 0) return;
		const entry = pool.keys[index];
		const active = index === pool.activeIndex;
		const options = [
			{ id: "use", label: active ? "● Already active" : "▶ Use this key" },
			{ id: "label", label: entry.label ? `✎ Change label (${entry.label})` : "✎ Set label" },
			{ id: "edit", label: "✎ Edit key value" },
			{ id: "remove", label: "🗑 Remove this key" },
			{ id: "back", label: "↩ Back" },
		];
		const choice = await interaction.prompt({
			type: "select",
			message: formatKeyRow(providerId, entry, index, active),
			options,
		});

		if (!choice || choice === "back") return;

		if (choice === "use") {
			mutatePool(providerId, (current) => {
				const at = current.keys.findIndex((candidate) => candidate.id === keyId);
				if (at >= 0) current.activeIndex = at;
			});
			interaction.notify({ type: "info", message: `Active key: ${maskKey(entry.key)}` });
			continue;
		}

		if (choice === "label") {
			const label = sanitizeLabel(
				(
					await interaction.prompt({
						type: "text",
						message: `New label for ${maskKey(entry.key)} (leave empty to clear)`,
					})
				).trim(),
			);
			mutatePool(providerId, (current) => {
				const found = current.keys.find((candidate) => candidate.id === keyId);
				if (found) found.label = label || undefined;
			});
			interaction.notify({
				type: "info",
				message: label ? `Labeled ${maskKey(entry.key)} as "${label}"` : `Cleared label for ${maskKey(entry.key)}`,
			});
			continue;
		}

		if (choice === "edit") {
			const replacement = (
				await interaction.prompt({
					type: "secret",
					message: `New value for ${maskKey(entry.key)} (leave empty to keep)`,
				})
			).trim();
			if (!replacement) continue;
			if (getPool(providerId)?.keys.some((candidate) => candidate.id !== keyId && candidate.key === replacement)) {
				interaction.notify({ type: "info", message: "Another key already has that value" });
				continue;
			}
			mutatePool(providerId, (current) => {
				const found = current.keys.find((candidate) => candidate.id === keyId);
				if (found) {
					found.key = replacement;
					found.id = makeKeyId(replacement);
					found.disabled = false;
					found.disabledReason = undefined;
					found.disabledAt = undefined;
				}
			});
			forgetStoredKey(providerId, entry.key); // the replaced value must not linger in auth.json
			interaction.notify({ type: "info", message: `Updated key to ${maskKey(replacement)}` });
			return; // id changed; leave the submenu
		}

		if (choice === "remove") {
			const confirm = await interaction.prompt({
				type: "select",
				message: `Remove ${maskKey(entry.key)}?`,
				options: [
					{ id: "yes", label: "Yes, remove" },
					{ id: "no", label: "Cancel" },
				],
			});
			if (confirm === "yes") {
				mutatePool(providerId, (current) => {
					current.keys = current.keys.filter((candidate) => candidate.id !== keyId);
				});
				forgetStoredKey(providerId, entry.key); // so the deleted key cannot come back
				interaction.notify({ type: "info", message: `Removed ${maskKey(entry.key)}` });
				return;
			}
			continue;
		}
	}
}

/**
 * The provider's api-key login flow: add keys, open a key to use / relabel /
 * edit / remove it, or re-enable disabled keys. Returns the active credential
 * so Pi can finish its normal login bookkeeping.
 */
async function runKeyPoolLogin(providerId: string, providerName: string, interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
	// First run: import the stored credential, otherwise ask for one.
	if (!getPool(providerId)?.keys.length) {
		const imported = importExistingKeys(providerId);
		if (imported > 0) {
			interaction.notify({ type: "info", message: `Imported ${imported} stored ${providerName} key(s)` });
		} else {
			await addKeyInteractive(providerId, providerName, interaction);
		}
	}

	for (;;) {
		const pool = getPool(providerId) ?? emptyPool();
		const options = pool.keys.map((entry, index) => ({
			id: `key:${entry.id}`,
			label: formatKeyRow(providerId, entry, index, index === pool.activeIndex),
		}));
		options.push({ id: "add", label: "➕ Add key" });
		if (pool.keys.length > 0) {
			options.push({ id: "reset", label: "↻ Re-enable disabled keys" });
		}
		options.push({ id: "done", label: "✔ Done" });

		const choice = await interaction.prompt({
			type: "select",
			message: `${providerName} key pool (${pool.keys.length} stored)`,
			options,
		});

		if (choice === "done") {
			const preferred = pool.keys.length > 0 ? preferredKey(providerId, pool) : undefined;
			if (!preferred) {
				await addKeyInteractive(providerId, providerName, interaction);
				continue;
			}
			interaction.notify({ type: "info", message: `Saved. Active key: ${maskKey(preferred.key)}` });
			return { type: "api_key", key: preferred.key };
		}

		if (choice === "add") {
			await addKeyInteractive(providerId, providerName, interaction);
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

		if (choice?.startsWith("key:")) {
			await manageOneKey(providerId, interaction, choice.slice(4));
		}
	}
}

/**
 * Exports for unit tests. This module is not the plugin entry point; see
 * `index.ts` for the extension factory.
 */
export const __internals = {
	agentDir,
	storePath,
	legacyStorePaths,
	emptyPool,
	dedupePool,
	loadStore,
	saveStore,
	getPool,
	mutatePool,
	makeKeyId,
	hasKeyValue,
	addKey,
	isCoolingDown,
	parkRateLimited,
	isUsable,
	orderedCandidates,
	preferredKey,
	classifyFailure,
	noteFailure,
	attemptWithRotation,
	wrapStreams,
	poolAuth,
	buildWrapper,
	ensureRegistered,
	maskKey,
	formatKeyRow,
	addKeyInteractive,
	readStoredKey,
	importExistingKeys,
	forgetStoredKey,
	sanitizeLabel,
	manageOneKey,
	runKeyPoolLogin,
};
