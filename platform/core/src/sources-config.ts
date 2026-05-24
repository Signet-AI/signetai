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
export type GitHubSourceResourceType = "issues" | "pulls" | "discussions" | "docs";
export type GitHubSourceState = "open" | "closed" | "all";

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

export interface GitHubSourceSettings {
	readonly repos: readonly string[];
	readonly tokenRef?: string;
	readonly resourceTypes: readonly GitHubSourceResourceType[];
	readonly state: GitHubSourceState;
	readonly includeComments: boolean;
	readonly labels?: readonly string[];
	readonly docPaths: readonly string[];
	readonly maxItemsPerRepo: number;
}

export interface AddGitHubSourceInput {
	readonly repos: readonly string[];
	readonly tokenRef?: string;
	readonly name?: string;
	readonly resourceTypes?: readonly GitHubSourceResourceType[];
	readonly state?: GitHubSourceState;
	readonly includeComments?: boolean;
	readonly labels?: readonly string[];
	readonly docPaths?: readonly string[];
	readonly maxItemsPerRepo?: number;
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
export const DEFAULT_GITHUB_RESOURCE_TYPES = ["issues", "pulls", "discussions", "docs"] as const;
export const DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN = ["issues", "pulls", "docs"] as const;
export const DEFAULT_GITHUB_DOC_PATHS = ["README.md", "CHANGELOG.md"] as const;
export const DEFAULT_GITHUB_MAX_ITEMS_PER_REPO = 500;
export const MAX_GITHUB_MAX_ITEMS_PER_REPO = 10_000;
const VALID_GITHUB_RESOURCE_TYPES = new Set<string>(DEFAULT_GITHUB_RESOURCE_TYPES);

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

export function addGitHubSource(input: AddGitHubSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	return withSourcesConfigLock(agentsDir, () => addGitHubSourceUnlocked(input, agentsDir));
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

function addGitHubSourceUnlocked(input: AddGitHubSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	try {
		return addGitHubSourceChecked(input, agentsDir);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { ok: false, error: detail };
	}
}

function addGitHubSourceChecked(input: AddGitHubSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	const settings = buildGitHubSettings(input);
	if ("error" in settings) return { ok: false, error: settings.error };

	const now = input.now ?? new Date().toISOString();
	const cfg = loadSourcesConfigForWrite(agentsDir);
	const settingsKey = settings.repos.slice().sort().join(",");
	const sourceId = `github:${createHash("sha256").update(settingsKey).digest("hex").slice(0, 16)}`;
	const root = `github://repos/${settings.repos.slice().sort().join(",")}`;
	const existing = cfg.sources.find((source) => source.id === sourceId);
	if (existing) {
		const existingSettings = parseGitHubSettings(existing.providerSettings);
		const updatedSettings = buildGitHubSettings(input, existingSettings);
		if ("error" in updatedSettings) return { ok: false, error: updatedSettings.error };
		const updated: SignetSourceEntry = {
			...existing,
			name: cleanName(input.name) ?? existing.name,
			root,
			enabled: true,
			providerSettings: githubSettingsProviderSettings(updatedSettings),
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
		kind: "github",
		name: cleanName(input.name) ?? settings.repos[0] ?? "GitHub Source",
		root,
		enabled: true,
		mode: "read-only",
		createdAt: now,
		updatedAt: now,
		providerSettings: githubSettingsProviderSettings(settings),
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

export function parseGitHubSettings(raw?: SignetSourceProviderSettings): GitHubSourceSettings {
	const repos = Array.isArray(raw?.repos) ? cleanGitHubRepos(raw.repos) : [];
	const tokenRef = typeof raw?.tokenRef === "string" ? raw.tokenRef.trim() || undefined : undefined;
	const resourceTypes =
		Array.isArray(raw?.resourceTypes) && raw.resourceTypes.every((type) => typeof type === "string")
			? raw.resourceTypes.filter((type): type is GitHubSourceResourceType => isGitHubResourceType(type))
			: tokenRef
				? [...DEFAULT_GITHUB_RESOURCE_TYPES]
				: [...DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN];
	const labels = Array.isArray(raw?.labels) ? cleanStringArray(raw.labels) : undefined;
	const docPaths = Array.isArray(raw?.docPaths)
		? cleanStringArray(raw.docPaths).filter(isSafeGitHubDocPath)
		: [...DEFAULT_GITHUB_DOC_PATHS];
	return {
		repos,
		...(tokenRef ? { tokenRef } : {}),
		resourceTypes: resourceTypes.length > 0 ? resourceTypes : [...DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN],
		state: isGitHubState(raw?.state) ? raw.state : "all",
		includeComments: raw?.includeComments !== false,
		...(labels && labels.length > 0 ? { labels } : {}),
		docPaths: docPaths.length > 0 ? docPaths : [...DEFAULT_GITHUB_DOC_PATHS],
		maxItemsPerRepo:
			cleanPositiveInteger(raw?.maxItemsPerRepo, MAX_GITHUB_MAX_ITEMS_PER_REPO) ?? DEFAULT_GITHUB_MAX_ITEMS_PER_REPO,
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

function buildGitHubSettings(
	input: AddGitHubSourceInput,
	existing?: GitHubSourceSettings,
): GitHubSourceSettings | { readonly error: string } {
	const repos = input.repos !== undefined ? cleanGitHubRepos(input.repos) : (existing?.repos ?? []);
	if (repos.length === 0) return { error: "At least one GitHub repo pattern is required" };
	for (const repo of repos) {
		if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_*.-]+$/.test(repo)) {
			return { error: `Invalid GitHub repo pattern: ${repo}. Expected owner/repo or owner/*` };
		}
	}
	const tokenRef = input.tokenRef !== undefined ? input.tokenRef.trim() || undefined : existing?.tokenRef;
	if (tokenRef && looksLikeRawGitHubToken(tokenRef)) {
		return { error: "GitHub tokenRef must be a secret reference, not a raw token" };
	}
	const resourceTypes = input.resourceTypes
		? [...input.resourceTypes]
		: existing?.resourceTypes?.length
			? [...existing.resourceTypes]
			: tokenRef
				? [...DEFAULT_GITHUB_RESOURCE_TYPES]
				: [...DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN];
	if (resourceTypes.length === 0) return { error: "GitHub resourceTypes must include at least one resource type" };
	const invalidTypes = resourceTypes.filter((type) => !isGitHubResourceType(type));
	if (invalidTypes.length > 0) {
		return {
			error: `Invalid GitHub resource types: ${invalidTypes.join(", ")}. Must be one of: ${[...DEFAULT_GITHUB_RESOURCE_TYPES].join(", ")}`,
		};
	}
	if (!tokenRef && resourceTypes.includes("discussions")) {
		return { error: "GitHub discussions require tokenRef because they use the GitHub GraphQL API" };
	}
	if (input.state !== undefined && !isGitHubState(input.state)) {
		return { error: "GitHub state must be one of: open, closed, all" };
	}
	if (input.includeComments !== undefined && typeof input.includeComments !== "boolean") {
		return { error: "GitHub includeComments must be a boolean" };
	}
	if (input.labels !== undefined && !isStringArray(input.labels)) {
		return { error: "GitHub labels must be an array of strings" };
	}
	if (input.docPaths !== undefined) {
		if (!isStringArray(input.docPaths)) return { error: "GitHub docPaths must be an array of strings" };
		const invalid = cleanStringArray(input.docPaths).filter((path) => !isSafeGitHubDocPath(path));
		if (invalid.length > 0) return { error: `Invalid GitHub docPaths: ${invalid.join(", ")}` };
	}
	if (input.maxItemsPerRepo !== undefined) {
		const maxItemsPerRepo = cleanPositiveInteger(input.maxItemsPerRepo, MAX_GITHUB_MAX_ITEMS_PER_REPO);
		if (maxItemsPerRepo !== input.maxItemsPerRepo) {
			return {
				error: `GitHub maxItemsPerRepo must be an integer between 1 and ${MAX_GITHUB_MAX_ITEMS_PER_REPO}`,
			};
		}
	}
	const labels = input.labels !== undefined ? cleanStringArray(input.labels) : existing?.labels;
	const docPaths =
		input.docPaths !== undefined
			? cleanStringArray(input.docPaths)
			: (existing?.docPaths ?? [...DEFAULT_GITHUB_DOC_PATHS]);
	return {
		repos,
		...(tokenRef ? { tokenRef } : {}),
		resourceTypes,
		state: input.state ?? existing?.state ?? "all",
		includeComments: input.includeComments ?? existing?.includeComments ?? true,
		...(labels && labels.length > 0 ? { labels } : {}),
		docPaths,
		maxItemsPerRepo: input.maxItemsPerRepo ?? existing?.maxItemsPerRepo ?? DEFAULT_GITHUB_MAX_ITEMS_PER_REPO,
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

function githubSettingsProviderSettings(settings: GitHubSourceSettings): SignetSourceProviderSettings {
	return {
		repos: settings.repos,
		...(settings.tokenRef ? { tokenRef: settings.tokenRef } : {}),
		resourceTypes: settings.resourceTypes,
		state: settings.state,
		includeComments: settings.includeComments,
		...(settings.labels ? { labels: settings.labels } : {}),
		docPaths: settings.docPaths,
		maxItemsPerRepo: settings.maxItemsPerRepo,
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

function cleanGitHubRepos(values: readonly unknown[]): readonly string[] {
	return Array.from(
		new Set(
			values
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter(Boolean),
		),
	);
}

function cleanStringArray(values: readonly unknown[]): readonly string[] {
	return Array.from(
		new Set(
			values
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter(Boolean),
		),
	);
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
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

function looksLikeRawGitHubToken(value: string): boolean {
	const trimmed = value.trim();
	const withoutHeaderPrefix = trimmed.replace(/^authorization:\s*/i, "").trim();
	const withoutAuthScheme = withoutHeaderPrefix.replace(/^(bearer|token)\s+/i, "").trim();
	if (withoutAuthScheme !== trimmed) return true;
	return (
		/^github_pat_[A-Za-z0-9_]{20,}$/.test(withoutAuthScheme) || /^gh[opsru]_[A-Za-z0-9_]{20,}$/.test(withoutAuthScheme)
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

function isGitHubResourceType(value: unknown): value is GitHubSourceResourceType {
	return typeof value === "string" && VALID_GITHUB_RESOURCE_TYPES.has(value);
}

function isGitHubState(value: unknown): value is GitHubSourceState {
	return value === "open" || value === "closed" || value === "all";
}

function isMarkdownDocPath(path: string): boolean {
	return path.toLowerCase().endsWith(".md");
}

function isMarkdownDocGlob(path: string): boolean {
	const lowered = path.toLowerCase();
	return lowered.endsWith("/*.md") || lowered.endsWith("/**/*.md");
}

function isSafeGitHubDocPath(value: string): boolean {
	const path = value.trim();
	if (!path) return false;
	if (path.startsWith("/") || path.includes("\\") || path.includes("?") || path.includes("#")) return false;
	if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return false;
	return isMarkdownDocPath(path) || isMarkdownDocGlob(path);
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
