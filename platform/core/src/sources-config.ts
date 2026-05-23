import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type SignetSourceKind = "obsidian" | "discord";
export type SignetSourceMode = "read-only";

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
	readonly settings?: Readonly<Record<string, unknown>>;
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

export interface DiscordSourceSettings {
	readonly guildIds: readonly string[];
	readonly tokenRef: string;
	readonly channelFilter?: readonly string[];
	readonly maxMessagesPerChannel: number;
	readonly includeThreads?: boolean;
	readonly since?: string;
}

export const DEFAULT_DISCORD_MAX_MESSAGES = 1000;
export const MAX_DISCORD_MESSAGES_PER_CHANNEL = 10_000;

function looksLikeRawDiscordToken(value: string): boolean {
	return /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/.test(value);
}

export interface AddDiscordSourceInput {
	readonly guildIds: readonly string[];
	readonly tokenRef: string;
	readonly name?: string;
	readonly channelFilter?: readonly string[];
	readonly maxMessagesPerChannel?: number;
	readonly includeThreads?: boolean;
	readonly since?: string;
	readonly now?: string;
}

export type AddSourceResult =
	| { readonly ok: true; readonly source: SignetSourceEntry; readonly created: boolean }
	| { readonly ok: false; readonly error: string };

export type RemoveSourceResult =
	| { readonly ok: true; readonly source: SignetSourceEntry }
	| { readonly ok: false; readonly error: string };

const SOURCES_CONFIG_VERSION = 1;

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
	if (!input.guildIds || input.guildIds.length === 0) {
		return { ok: false, error: "At least one Discord guild ID is required" };
	}
	const trimmedTokenRef = input.tokenRef?.trim();
	if (!trimmedTokenRef) return { ok: false, error: "Discord bot token reference (tokenRef) is required" };
	if (looksLikeRawDiscordToken(trimmedTokenRef)) {
		return { ok: false, error: "Discord tokenRef must be a secret reference, not a raw bot token" };
	}
	const guildIds = cleanDiscordIds(input.guildIds);
	if (guildIds.length === 0) return { ok: false, error: "At least one Discord guild ID is required" };
	for (const id of guildIds) {
		if (!/^\d{17,20}$/.test(id)) return { ok: false, error: `Invalid Discord guild ID: ${id}` };
	}
	const maxMessages = cleanDiscordMaxMessages(input.maxMessagesPerChannel);
	if (maxMessages === null) {
		return {
			ok: false,
			error: `Discord maxMessagesPerChannel must be an integer between 1 and ${MAX_DISCORD_MESSAGES_PER_CHANNEL}`,
		};
	}
	const since = cleanDiscordSince(input.since);
	if (since === null) {
		return { ok: false, error: "Discord since must be a valid ISO date" };
	}

	const key = guildIds.slice().sort().join(",");
	const now = input.now ?? new Date().toISOString();
	const cfg = loadSourcesConfigForWrite(agentsDir);
	const sourceId = `discord:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
	const existing = cfg.sources.find((source) => source.id === sourceId);

	if (existing) {
		const updated = {
			...existing,
			name: cleanName(input.name) ?? existing.name,
			enabled: true,
			settings: buildDiscordSettings(input),
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
		name: cleanName(input.name) ?? "Discord Server",
		root: "",
		enabled: true,
		mode: "read-only",
		createdAt: now,
		updatedAt: now,
		settings: buildDiscordSettings(input),
	};
	saveSourcesConfig({ version: SOURCES_CONFIG_VERSION, sources: [...cfg.sources, source] }, agentsDir);
	return { ok: true, source, created: true };
}

function buildDiscordSettings(input: AddDiscordSourceInput): Record<string, unknown> {
	const maxMessages = cleanDiscordMaxMessages(input.maxMessagesPerChannel) ?? DEFAULT_DISCORD_MAX_MESSAGES;
	const since = cleanDiscordSince(input.since);
	return {
		guildIds: cleanDiscordIds(input.guildIds),
		tokenRef: input.tokenRef.trim(),
		...(input.channelFilter && input.channelFilter.length > 0
			? { channelFilter: cleanDiscordChannelFilter(input.channelFilter) }
			: {}),
		maxMessagesPerChannel: maxMessages,
		includeThreads: input.includeThreads ?? true,
		...(since ? { since } : {}),
	};
}

export function parseDiscordSettings(raw?: Readonly<Record<string, unknown>>): DiscordSourceSettings {
	if (!raw) {
		return { guildIds: [], tokenRef: "", maxMessagesPerChannel: DEFAULT_DISCORD_MAX_MESSAGES, includeThreads: true };
	}
	const guildIds = Array.isArray(raw.guildIds)
		? raw.guildIds
				.filter((id): id is string => typeof id === "string")
				.map((id) => id.trim())
				.filter(Boolean)
		: [];
	const tokenRef = typeof raw.tokenRef === "string" ? raw.tokenRef : "";
	const channelFilter = Array.isArray(raw.channelFilter)
		? cleanDiscordChannelFilter(raw.channelFilter.filter((id): id is string => typeof id === "string"))
		: undefined;
	const maxMessagesPerChannel =
		cleanDiscordMaxMessages(typeof raw.maxMessagesPerChannel === "number" ? raw.maxMessagesPerChannel : undefined) ??
		DEFAULT_DISCORD_MAX_MESSAGES;
	const includeThreads = typeof raw.includeThreads === "boolean" ? raw.includeThreads : true;
	const since = cleanDiscordSince(typeof raw.since === "string" ? raw.since : undefined) ?? undefined;
	return { guildIds, tokenRef, channelFilter, maxMessagesPerChannel, includeThreads, since };
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

function cleanDiscordIds(values: readonly string[]): readonly string[] {
	return Array.from(new Set(values.map((id) => id.trim()).filter(Boolean)));
}

function cleanDiscordChannelFilter(values: readonly string[]): readonly string[] {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function cleanDiscordMaxMessages(value: number | undefined): number | null {
	if (value === undefined) return DEFAULT_DISCORD_MAX_MESSAGES;
	if (!Number.isInteger(value) || value < 1 || value > MAX_DISCORD_MESSAGES_PER_CHANNEL) return null;
	return value;
}

function cleanDiscordSince(value: string | undefined): string | null | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const time = Date.parse(trimmed);
	if (!Number.isFinite(time)) return null;
	return new Date(time).toISOString();
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
		(value.kind === "obsidian" || value.kind === "discord") &&
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
		(value.settings === undefined || isRecord(value.settings))
	);
}
