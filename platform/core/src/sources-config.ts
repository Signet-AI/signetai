import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, resolve } from "node:path";

export type SignetSourceKind = "obsidian" | (string & {});
export type SignetSourceMode = "read-only";
export type SignetSourceProviderSettings = Readonly<Record<string, unknown>>;

export interface SignetSourceEntry {
	readonly id: string;
	readonly kind: SignetSourceKind;
	readonly name: string;
	readonly root: string;
	readonly enabled: boolean;
	readonly mode: SignetSourceMode;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly lastIndexedAt?: string;
	readonly excludeGlobs?: readonly string[];
	readonly providerSettings?: SignetSourceProviderSettings;
}

export const DEFAULT_OBSIDIAN_EXCLUDE_GLOBS = [
	"**/.obsidian/**",
	"**/.trash/**",
	"**/.hermes/**",
	"**/.*/**",
	"**/.*",
] as const;

export interface SignetSourcesConfig {
	readonly version: 1;
	readonly sources: readonly SignetSourceEntry[];
}

export interface AddObsidianSourceInput {
	readonly root: string;
	readonly name?: string;
	readonly excludeGlobs?: readonly string[];
	readonly now?: string;
}

export type DiscordSourceSyncMode = "rest" | "gateway-tail" | "desktop-cache";

export interface DiscordSourceSettings {
	readonly guildIds: readonly string[];
	readonly tokenRef: string;
	readonly desktopCachePath?: string;
	readonly desktopCacheFullScan: boolean;
	readonly channelFilter?: readonly string[];
	readonly maxMessagesPerChannel: number;
	readonly includeThreads: boolean;
	readonly includeArchivedThreads: boolean;
	readonly includePrivateArchivedThreads: boolean;
	readonly includeMembers: boolean;
	readonly includeAttachments: boolean;
	readonly includeEmbeds: boolean;
	readonly includePolls: boolean;
	readonly includeThreadMembers: boolean;
	readonly since?: string;
	readonly syncMode: DiscordSourceSyncMode;
}

export interface AddDiscordSourceInput {
	readonly guildIds?: readonly string[];
	readonly tokenRef?: string;
	readonly desktopCachePath?: string;
	readonly desktopCacheFullScan?: boolean;
	readonly name?: string;
	readonly channelFilter?: readonly string[];
	readonly maxMessagesPerChannel?: number;
	readonly includeThreads?: boolean;
	readonly includeArchivedThreads?: boolean;
	readonly includePrivateArchivedThreads?: boolean;
	readonly includeMembers?: boolean;
	readonly includeAttachments?: boolean;
	readonly includeEmbeds?: boolean;
	readonly includePolls?: boolean;
	readonly includeThreadMembers?: boolean;
	readonly since?: string;
	readonly syncMode?: DiscordSourceSyncMode;
	readonly now?: string;
}

export type AddSourceResult =
	| { readonly ok: true; readonly source: SignetSourceEntry; readonly created: boolean }
	| { readonly ok: false; readonly error: string };

export type RemoveSourceResult =
	| { readonly ok: true; readonly source: SignetSourceEntry }
	| { readonly ok: false; readonly error: string };

const SOURCES_CONFIG_VERSION = 1;
export const DEFAULT_DISCORD_MAX_MESSAGES_PER_CHANNEL = 1000;
export const MAX_DISCORD_MAX_MESSAGES_PER_CHANNEL = 10_000;
export const DEFAULT_DISCORD_DESKTOP_CACHE_PATH = defaultDiscordDesktopCachePath();

export function getAgentsDir(): string {
	return process.env.SIGNET_PATH || `${homedir()}/.agents`;
}

export function getSourcesConfigPath(agentsDir = getAgentsDir()): string {
	return `${agentsDir.replace(/\/$/, "")}/sources.json`;
}

export function loadSourcesConfig(agentsDir = getAgentsDir()): SignetSourcesConfig {
	const path = getSourcesConfigPath(agentsDir);
	if (!existsSync(path)) return emptyConfig();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(parsed) || parsed.version !== SOURCES_CONFIG_VERSION || !Array.isArray(parsed.sources)) {
			return emptyConfig();
		}
		return {
			version: SOURCES_CONFIG_VERSION,
			sources: parsed.sources.filter(isSourceEntry),
		};
	} catch {
		return emptyConfig();
	}
}

export function saveSourcesConfig(config: SignetSourcesConfig, agentsDir = getAgentsDir()): void {
	const path = getSourcesConfigPath(agentsDir);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

function loadSourcesConfigForWrite(agentsDir = getAgentsDir()): SignetSourcesConfig {
	const path = getSourcesConfigPath(agentsDir);
	if (!existsSync(path)) return emptyConfig();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`Sources config is not readable JSON; refusing to overwrite ${path}: ${detail}`);
	}
	if (!isRecord(parsed) || parsed.version !== SOURCES_CONFIG_VERSION || !Array.isArray(parsed.sources)) {
		throw new Error(`Sources config is invalid; refusing to overwrite ${path}`);
	}
	if (!parsed.sources.every(isSourceEntry)) {
		throw new Error(`Sources config contains invalid source entries; refusing to overwrite ${path}`);
	}
	return { version: SOURCES_CONFIG_VERSION, sources: parsed.sources };
}

export function addObsidianSource(input: AddObsidianSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	return withSourcesConfigLock(agentsDir, () => addObsidianSourceUnlocked(input, agentsDir));
}

export function addDiscordSource(input: AddDiscordSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	return withSourcesConfigLock(agentsDir, () => addDiscordSourceUnlocked(input, agentsDir));
}

function addDiscordSourceUnlocked(input: AddDiscordSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	try {
		return addDiscordSourceChecked(input, agentsDir);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { ok: false, error: detail };
	}
}

function addDiscordSourceChecked(input: AddDiscordSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	const settings = buildDiscordSettings(input);
	if ("error" in settings) return { ok: false, error: settings.error };

	const now = input.now ?? new Date().toISOString();
	const cfg = loadSourcesConfigForWrite(agentsDir);
	const root =
		settings.syncMode === "desktop-cache"
			? (settings.desktopCachePath ?? DEFAULT_DISCORD_DESKTOP_CACHE_PATH)
			: `discord://guilds/${settings.guildIds.slice().sort().join(",")}`;
	const sourceId =
		settings.syncMode === "desktop-cache"
			? `discord-cache:${createHash("sha256").update(root).digest("hex").slice(0, 16)}`
			: `discord:${createHash("sha256").update(settings.guildIds.slice().sort().join(",")).digest("hex").slice(0, 16)}`;
	const existing = cfg.sources.find((source) => source.id === sourceId);
	if (existing) {
		const updated: SignetSourceEntry = {
			...existing,
			name: cleanName(input.name) ?? existing.name,
			root,
			enabled: true,
			providerSettings: discordSettingsProviderSettings(settings),
			updatedAt: now,
		};
		saveSourcesConfig(
			{
				version: SOURCES_CONFIG_VERSION,
				sources: cfg.sources.map((source) => (source.id === existing.id ? updated : source)),
			},
			agentsDir,
		);
		return { ok: true, source: updated, created: false };
	}

	const source: SignetSourceEntry = {
		id: sourceId,
		kind: "discord",
		name: cleanName(input.name) ?? "Discord Source",
		root,
		enabled: true,
		mode: "read-only",
		createdAt: now,
		updatedAt: now,
		providerSettings: discordSettingsProviderSettings(settings),
	};
	saveSourcesConfig({ version: SOURCES_CONFIG_VERSION, sources: [...cfg.sources, source] }, agentsDir);
	return { ok: true, source, created: true };
}

export function parseDiscordSettings(raw?: SignetSourceProviderSettings): DiscordSourceSettings {
	const guildIds = Array.isArray(raw?.guildIds) ? cleanDiscordIds(raw.guildIds) : [];
	const tokenRef = typeof raw?.tokenRef === "string" ? raw.tokenRef.trim() : "";
	const desktopCachePath = typeof raw?.desktopCachePath === "string" ? cleanLocalPath(raw.desktopCachePath) : undefined;
	const channelFilter = Array.isArray(raw?.channelFilter) ? cleanDiscordChannelFilter(raw.channelFilter) : undefined;
	const maxMessagesPerChannel =
		cleanPositiveInteger(raw?.maxMessagesPerChannel, MAX_DISCORD_MAX_MESSAGES_PER_CHANNEL) ??
		DEFAULT_DISCORD_MAX_MESSAGES_PER_CHANNEL;
	const since = typeof raw?.since === "string" ? cleanIsoDate(raw.since) : undefined;
	return {
		guildIds,
		tokenRef,
		...(desktopCachePath ? { desktopCachePath } : {}),
		desktopCacheFullScan: raw?.desktopCacheFullScan === true,
		...(channelFilter ? { channelFilter } : {}),
		maxMessagesPerChannel,
		includeThreads: raw?.includeThreads !== false,
		includeArchivedThreads: raw?.includeArchivedThreads !== false,
		includePrivateArchivedThreads: raw?.includePrivateArchivedThreads === true,
		includeMembers: raw?.includeMembers !== false,
		includeAttachments: raw?.includeAttachments !== false,
		includeEmbeds: raw?.includeEmbeds !== false,
		includePolls: raw?.includePolls !== false,
		includeThreadMembers: raw?.includeThreadMembers !== false,
		...(since ? { since } : {}),
		syncMode: isDiscordSyncMode(raw?.syncMode) ? raw.syncMode : "rest",
	};
}

function buildDiscordSettings(input: AddDiscordSourceInput): DiscordSourceSettings | { readonly error: string } {
	if (input.syncMode && !isDiscordSyncMode(input.syncMode))
		return { error: `Unsupported Discord sync mode: ${input.syncMode}` };
	const syncMode = input.syncMode ?? "rest";
	const guildIds = cleanDiscordIds(input.guildIds ?? []);
	if (syncMode !== "desktop-cache" && guildIds.length === 0)
		return { error: "At least one Discord guild ID is required" };
	for (const guildId of guildIds) {
		if (!isDiscordSnowflake(guildId)) return { error: `Invalid Discord guild ID: ${guildId}` };
	}
	const tokenRef = input.tokenRef?.trim() ?? "";
	if (syncMode !== "desktop-cache" && !tokenRef) return { error: "Discord tokenRef is required" };
	if (looksLikeRawDiscordToken(tokenRef))
		return { error: "Discord tokenRef must be a secret reference, not a raw token" };
	const desktopCachePath = cleanLocalPath(input.desktopCachePath) ?? DEFAULT_DISCORD_DESKTOP_CACHE_PATH;
	if (syncMode === "desktop-cache" && !looksLikeDiscordDesktopCacheRoot(desktopCachePath)) {
		return { error: "Discord desktopCachePath must point at a Discord Desktop data directory" };
	}
	const channelFilter = cleanDiscordChannelFilter(input.channelFilter ?? []);
	const maxMessagesPerChannel =
		cleanPositiveInteger(input.maxMessagesPerChannel, MAX_DISCORD_MAX_MESSAGES_PER_CHANNEL) ??
		DEFAULT_DISCORD_MAX_MESSAGES_PER_CHANNEL;
	if (input.maxMessagesPerChannel !== undefined && maxMessagesPerChannel !== input.maxMessagesPerChannel) {
		return {
			error: `Discord maxMessagesPerChannel must be an integer between 1 and ${MAX_DISCORD_MAX_MESSAGES_PER_CHANNEL}`,
		};
	}
	const since = cleanIsoDate(input.since);
	if (input.since !== undefined && since === undefined) return { error: "Discord since must be a valid ISO date" };

	return {
		guildIds,
		tokenRef,
		...(syncMode === "desktop-cache" ? { desktopCachePath } : {}),
		desktopCacheFullScan: input.desktopCacheFullScan === true,
		...(channelFilter.length > 0 ? { channelFilter } : {}),
		maxMessagesPerChannel,
		includeThreads: input.includeThreads ?? true,
		includeArchivedThreads: input.includeArchivedThreads ?? true,
		includePrivateArchivedThreads: input.includePrivateArchivedThreads ?? false,
		includeMembers: input.includeMembers ?? true,
		includeAttachments: input.includeAttachments ?? true,
		includeEmbeds: input.includeEmbeds ?? true,
		includePolls: input.includePolls ?? true,
		includeThreadMembers: input.includeThreadMembers ?? true,
		...(since ? { since } : {}),
		syncMode,
	};
}

function discordSettingsProviderSettings(settings: DiscordSourceSettings): SignetSourceProviderSettings {
	return {
		guildIds: settings.guildIds,
		tokenRef: settings.tokenRef,
		...(settings.desktopCachePath ? { desktopCachePath: settings.desktopCachePath } : {}),
		...(settings.syncMode === "desktop-cache" || settings.desktopCacheFullScan
			? { desktopCacheFullScan: settings.desktopCacheFullScan }
			: {}),
		...(settings.channelFilter ? { channelFilter: settings.channelFilter } : {}),
		maxMessagesPerChannel: settings.maxMessagesPerChannel,
		includeThreads: settings.includeThreads,
		includeArchivedThreads: settings.includeArchivedThreads,
		includePrivateArchivedThreads: settings.includePrivateArchivedThreads,
		includeMembers: settings.includeMembers,
		includeAttachments: settings.includeAttachments,
		includeEmbeds: settings.includeEmbeds,
		includePolls: settings.includePolls,
		includeThreadMembers: settings.includeThreadMembers,
		...(settings.since ? { since: settings.since } : {}),
		syncMode: settings.syncMode,
	};
}

function addObsidianSourceUnlocked(input: AddObsidianSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	try {
		return addObsidianSourceChecked(input, agentsDir);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { ok: false, error: detail };
	}
}

function addObsidianSourceChecked(input: AddObsidianSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	const trimmedRoot = input.root.trim();
	if (!trimmedRoot) return { ok: false, error: "Obsidian vault path is required" };
	const root = resolve(trimmedRoot);
	if (!existsSync(root)) return { ok: false, error: `Obsidian vault path does not exist: ${root}` };
	try {
		if (!statSync(root).isDirectory()) return { ok: false, error: `Obsidian vault path must be a directory: ${root}` };
	} catch {
		return { ok: false, error: `Obsidian vault path is not accessible: ${root}` };
	}

	const now = input.now ?? new Date().toISOString();
	const cfg = loadSourcesConfigForWrite(agentsDir);
	const existing = cfg.sources.find((source) => source.kind === "obsidian" && source.root === root);
	if (existing) {
		const updated = {
			...existing,
			name: cleanName(input.name) ?? existing.name,
			excludeGlobs: input.excludeGlobs
				? mergeDefaultObsidianExcludeGlobs(input.excludeGlobs)
				: (existing.excludeGlobs ?? [...DEFAULT_OBSIDIAN_EXCLUDE_GLOBS]),
			enabled: true,
			updatedAt: now,
		};
		saveSourcesConfig(
			{
				version: SOURCES_CONFIG_VERSION,
				sources: cfg.sources.map((source) => (source.id === existing.id ? updated : source)),
			},
			agentsDir,
		);
		return { ok: true, source: updated, created: false };
	}

	const source: SignetSourceEntry = {
		id: `obsidian:${createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
		kind: "obsidian",
		name: cleanName(input.name) ?? "Obsidian Vault",
		root,
		enabled: true,
		mode: "read-only",
		createdAt: now,
		updatedAt: now,
		excludeGlobs: mergeDefaultObsidianExcludeGlobs(input.excludeGlobs),
	};
	saveSourcesConfig({ version: SOURCES_CONFIG_VERSION, sources: [...cfg.sources, source] }, agentsDir);
	return { ok: true, source, created: true };
}

export function markSourceIndexed(
	sourceId: string,
	indexedAt = new Date().toISOString(),
	agentsDir = getAgentsDir(),
): void {
	withSourcesConfigLock(agentsDir, () => markSourceIndexedUnlocked(sourceId, indexedAt, agentsDir));
}

function markSourceIndexedUnlocked(
	sourceId: string,
	indexedAt = new Date().toISOString(),
	agentsDir = getAgentsDir(),
): void {
	const cfg = loadSourcesConfigForWrite(agentsDir);
	saveSourcesConfig(
		{
			version: SOURCES_CONFIG_VERSION,
			sources: cfg.sources.map((source) =>
				source.id === sourceId ? { ...source, lastIndexedAt: indexedAt, updatedAt: indexedAt } : source,
			),
		},
		agentsDir,
	);
}

export function removeSource(sourceId: string, agentsDir = getAgentsDir()): RemoveSourceResult {
	return withSourcesConfigLock(agentsDir, () => removeSourceUnlocked(sourceId, agentsDir));
}

function removeSourceUnlocked(sourceId: string, agentsDir = getAgentsDir()): RemoveSourceResult {
	try {
		return removeSourceChecked(sourceId, agentsDir);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { ok: false, error: detail };
	}
}

function removeSourceChecked(sourceId: string, agentsDir = getAgentsDir()): RemoveSourceResult {
	const id = sourceId.trim();
	if (!id) return { ok: false, error: "Source id is required" };
	const cfg = loadSourcesConfigForWrite(agentsDir);
	const source = cfg.sources.find((entry) => entry.id === id);
	if (!source) return { ok: false, error: `Source not found: ${id}` };
	saveSourcesConfig(
		{
			version: SOURCES_CONFIG_VERSION,
			sources: cfg.sources.filter((entry) => entry.id !== id),
		},
		agentsDir,
	);
	return { ok: true, source };
}

function emptyConfig(): SignetSourcesConfig {
	return { version: SOURCES_CONFIG_VERSION, sources: [] };
}

function withSourcesConfigLock<T>(agentsDir: string, fn: () => T): T {
	const configPath = getSourcesConfigPath(agentsDir);
	mkdirSync(dirname(configPath), { recursive: true });
	const lockDir = `${configPath}.lock`;
	let locked = false;
	for (let attempt = 0; attempt < 500; attempt++) {
		try {
			mkdirSync(lockDir);
			locked = true;
			break;
		} catch (err) {
			if (!isFileExistsError(err)) throw err;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	if (!locked) throw new Error(`Timed out waiting for Sources config lock: ${lockDir}`);
	try {
		return fn();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}

function isFileExistsError(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

function cleanName(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

function cleanExcludeGlobs(values: readonly string[] | undefined): readonly string[] | null {
	if (!values) return null;
	const cleaned = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
	return cleaned.length > 0 ? cleaned : [];
}

function cleanDiscordIds(values: readonly unknown[]): readonly string[] {
	return Array.from(
		new Set(
			values
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter(Boolean),
		),
	);
}

function cleanDiscordChannelFilter(values: readonly unknown[]): readonly string[] {
	return Array.from(
		new Set(
			values
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter(Boolean),
		),
	);
}

function cleanLocalPath(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? resolve(trimmed.replace(/^~(?=$|\/|\\)/, homedir())) : undefined;
}

function isDiscordSnowflake(value: string): boolean {
	return /^\d{17,20}$/.test(value);
}

function looksLikeRawDiscordToken(value: string): boolean {
	const trimmed = value.trim();
	const withoutHeaderPrefix = trimmed.replace(/^authorization:\s*/i, "").trim();
	const withoutAuthScheme = withoutHeaderPrefix.replace(/^(bot|bearer)\s+/i, "").trim();
	if (withoutAuthScheme !== trimmed) return true;
	return (
		/^mfa\.[A-Za-z0-9_-]{20,}$/.test(withoutAuthScheme) ||
		/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/.test(withoutAuthScheme)
	);
}

function cleanPositiveInteger(value: unknown, max: number): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) return undefined;
	return value;
}

function cleanIsoDate(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const ms = Date.parse(trimmed);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function isDiscordSyncMode(value: unknown): value is DiscordSourceSyncMode {
	return value === "rest" || value === "gateway-tail" || value === "desktop-cache";
}

function defaultDiscordDesktopCachePath(): string {
	switch (platform()) {
		case "darwin":
			return resolve(homedir(), "Library", "Application Support", "discord");
		case "win32":
			return resolve(process.env.APPDATA || resolve(homedir(), "AppData", "Roaming"), "discord");
		default:
			return resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "discord");
	}
}

function looksLikeDiscordDesktopCacheRoot(value: string): boolean {
	const base = basename(value)
		.toLowerCase()
		.replace(/[\s_-]+/g, "");
	return ["discord", "discordcanary", "discordptb", "discorddevelopment", "vesktop"].includes(base);
}

function mergeDefaultObsidianExcludeGlobs(values: readonly string[] | undefined): readonly string[] {
	return [...DEFAULT_OBSIDIAN_EXCLUDE_GLOBS, ...(cleanExcludeGlobs(values) ?? [])].filter(
		(value, index, all) => all.indexOf(value) === index,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourceEntry(value: unknown): value is SignetSourceEntry {
	return (
		isRecord(value) &&
		typeof value.kind === "string" &&
		value.kind.trim().length > 0 &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.root === "string" &&
		typeof value.enabled === "boolean" &&
		value.mode === "read-only" &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		(value.lastIndexedAt === undefined || typeof value.lastIndexedAt === "string") &&
		(value.excludeGlobs === undefined ||
			(Array.isArray(value.excludeGlobs) && value.excludeGlobs.every((entry) => typeof entry === "string"))) &&
		(value.providerSettings === undefined || isJsonRecord(value.providerSettings))
	);
}

function isJsonRecord(value: unknown): value is SignetSourceProviderSettings {
	if (!isRecord(value)) return false;
	return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
	if (value === null) return true;
	if (typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isJsonRecord(value);
}
