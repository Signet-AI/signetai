import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { resolveDefaultBasePath } from "./constants";
import {
	DEFAULT_DISCORD_DESKTOP_CACHE_PATH,
	buildDiscordSettings,
	buildGitHubSettings,
	discordSettingsProviderSettings,
	githubSettingsProviderSettings,
	normalizePublicWebUrl,
	parseGitHubSettings,
} from "./source-provider-config";
import type {
	AddDiscordSourceInput,
	AddGitHubSourceInput,
	AddWebSourceInput,
	SignetSourceProviderSettings,
} from "./source-provider-config";
export {
	DEFAULT_DISCORD_MAX_MESSAGES_PER_CHANNEL,
	MAX_DISCORD_MAX_MESSAGES_PER_CHANNEL,
	DEFAULT_DISCORD_MAX_ATTACHMENT_TEXT_BYTES,
	MAX_DISCORD_MAX_ATTACHMENT_TEXT_BYTES,
	DEFAULT_DISCORD_DESKTOP_CACHE_PATH,
	DEFAULT_GITHUB_RESOURCE_TYPES,
	DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN,
	DEFAULT_GITHUB_DOC_PATHS,
	DEFAULT_GITHUB_MAX_ITEMS_PER_REPO,
	MAX_GITHUB_MAX_ITEMS_PER_REPO,
	normalizePublicWebUrl,
	parseDiscordSettings,
	parseGitHubSettings,
	parseWebSettings,
} from "./source-provider-config";
export type * from "./source-provider-config";

export type SignetSourceKind = "obsidian" | "web" | (string & {});
export type SignetSourceMode = "read-only";
export interface SignetSourceEntry {
	readonly id: string;
	readonly generation?: string;
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

export type ImportedSourceDuplicateMode = "skip" | "replace" | "reimport";

export interface AddImportedSourceInput {
	readonly importKey?: string;
	readonly fileName: string;
	readonly contentHash: string;
	readonly format: string;
	readonly agentId?: string;
	readonly duplicateMode?: ImportedSourceDuplicateMode;
	readonly sourceId?: string;
	readonly now?: string;
}

export type AddImportedSourceResult =
	| { readonly ok: true; readonly source: SignetSourceEntry; readonly created: boolean; readonly duplicate: boolean }
	| { readonly ok: false; readonly error: string };

export type AddSourceResult =
	| { readonly ok: true; readonly source: SignetSourceEntry; readonly created: boolean }
	| { readonly ok: false; readonly error: string };

export type RemoveSourceResult =
	| { readonly ok: true; readonly source: SignetSourceEntry }
	| { readonly ok: false; readonly error: string };

export type RemoveSourceIfGenerationResult =
	| { readonly ok: true; readonly removed: true; readonly source: SignetSourceEntry }
	| { readonly ok: true; readonly removed: false; readonly source: SignetSourceEntry | undefined }
	| { readonly ok: false; readonly error: string };

const SOURCES_CONFIG_VERSION = 1;
export function getAgentsDir(): string {
	return resolveDefaultBasePath();
}

export function getSourcesConfigPath(agentsDir = getAgentsDir()): string {
	return `${agentsDir.replace(/\/$/, "")}/sources.json`;
}

export function loadSourcesConfig(agentsDir = getAgentsDir()): SignetSourcesConfig {
	return loadSourcesConfigForWrite(agentsDir);
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
	return { version: SOURCES_CONFIG_VERSION, sources: parsed.sources.map(normalizeSourceEntry) };
}

function newSourceGeneration(): string {
	return randomUUID();
}

function normalizeSourceEntry(source: SignetSourceEntry): SignetSourceEntry {
	return source.generation
		? source
		: { ...source, generation: `legacy:${source.id}:${source.createdAt}:${source.updatedAt}` };
}

export function addObsidianSource(input: AddObsidianSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	return addSource(input, agentsDir, addObsidianSourceChecked);
}

export function addWebSource(input: AddWebSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	return addSource(input, agentsDir, addWebSourceChecked);
}

export function addDiscordSource(input: AddDiscordSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	return addSource(input, agentsDir, addDiscordSourceChecked);
}

export function addGitHubSource(input: AddGitHubSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	return addSource(input, agentsDir, addGitHubSourceChecked);
}

function addSource<TInput>(
	input: TInput,
	agentsDir: string,
	add: (input: TInput, agentsDir: string) => AddSourceResult,
): AddSourceResult {
	return withSourcesConfigLock(agentsDir, () => {
		try {
			return add(input, agentsDir);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			return { ok: false, error: detail };
		}
	});
}

function addWebSourceChecked(input: AddWebSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	const url = normalizePublicWebUrl(input.url);
	if (!url) return { ok: false, error: "Web page URL must be a public http(s) URL" };
	const now = input.now ?? new Date().toISOString();
	const config = loadSourcesConfigForWrite(agentsDir);
	const sourceId = `web:${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
	const existing = config.sources.find((source) => source.id === sourceId);
	const source: SignetSourceEntry = {
		id: sourceId,
		generation: existing?.generation ?? newSourceGeneration(),
		kind: "web",
		name: cleanName(input.name) ?? existing?.name ?? new URL(url).hostname,
		root: url,
		enabled: true,
		mode: "read-only",
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		providerSettings: { url },
	};
	const created = persistSourceUpsert(config, source, existing, agentsDir);
	return { ok: true, source, created };
}

export function addImportedSource(input: AddImportedSourceInput, agentsDir = getAgentsDir()): AddImportedSourceResult {
	return withSourcesConfigLock(agentsDir, () => {
		const fileName = input.fileName.trim();
		const contentHash = input.contentHash.trim().toLowerCase();
		const format = input.format.trim().toLowerCase();
		const agentId = input.agentId?.trim() || undefined;
		if (!fileName) return { ok: false, error: "Imported file name is required" };
		if (!/^[a-f0-9]{64}$/.test(contentHash)) return { ok: false, error: "Imported content hash is invalid" };
		if (!format) return { ok: false, error: "Imported file format is required" };

		const now = input.now ?? new Date().toISOString();
		const config = loadSourcesConfigForWrite(agentsDir);
		const mode = input.duplicateMode ?? "skip";
		const replay =
			input.importKey === undefined
				? undefined
				: config.sources.find(
						(source) =>
							source.kind === "import" &&
							source.providerSettings?.agentId === agentId &&
							source.providerSettings?.importKey === input.importKey,
					);
		if (replay) {
			if (replay.providerSettings?.contentHash !== contentHash)
				return { ok: false, error: "Import identity content mismatch" };
			return { ok: true, source: replay, created: false, duplicate: true };
		}
		const duplicate = config.sources.find(
			(source) =>
				source.kind === "import" &&
				source.providerSettings?.contentHash === contentHash &&
				(agentId === undefined || source.providerSettings?.agentId === agentId),
		);
		if (duplicate && mode === "skip") {
			return { ok: true, source: duplicate, created: false, duplicate: true };
		}

		const sourceId =
			duplicate && mode === "replace"
				? duplicate.id
				: input.sourceId?.trim() ||
					(mode === "reimport"
						? `import:${contentHash.slice(0, 16)}:${randomUUID().slice(0, 8)}`
						: deterministicImportedSourceId(contentHash, agentId));
		const source: SignetSourceEntry = {
			id: sourceId,
			generation: newSourceGeneration(),
			kind: "import",
			name: basename(fileName),
			root: basename(fileName),
			enabled: true,
			mode: "read-only",
			createdAt: duplicate?.createdAt ?? now,
			updatedAt: now,
			providerSettings: {
				fileName: basename(fileName),
				contentHash,
				format,
				...(input.importKey === undefined ? {} : { importKey: input.importKey }),
				...(agentId === undefined ? {} : { agentId }),
			},
		};
		const existing = duplicate && mode === "replace" ? duplicate : undefined;
		const created = persistSourceUpsert(config, source, existing, agentsDir);
		return { ok: true, source, created, duplicate: Boolean(duplicate) };
	});
}

export function deterministicImportedSourceId(contentHash: string, agentId?: string): string {
	const normalizedAgentId = agentId?.trim() || undefined;
	const ownerSuffix = normalizedAgentId
		? `:${createHash("sha256").update(normalizedAgentId).digest("hex").slice(0, 8)}`
		: "";
	return `import:${contentHash.trim().toLowerCase().slice(0, 16)}${ownerSuffix}`;
}

function addDiscordSourceChecked(input: AddDiscordSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	const settings = buildDiscordSettings(input);
	if ("error" in settings) return { ok: false, error: settings.error };

	const now = input.now ?? new Date().toISOString();
	const config = loadSourcesConfigForWrite(agentsDir);
	const guildIds = settings.guildIds.slice().sort();
	const root =
		settings.syncMode === "desktop-cache"
			? (settings.desktopCachePath ?? DEFAULT_DISCORD_DESKTOP_CACHE_PATH)
			: `discord://guilds/${guildIds.join(",")}`;
	const sourceId = `discord${settings.syncMode === "desktop-cache" ? "-cache" : ""}:${createHash("sha256")
		.update(settings.syncMode === "desktop-cache" ? root : guildIds.join(","))
		.digest("hex")
		.slice(0, 16)}`;
	const existing = config.sources.find((source) => source.id === sourceId);
	return upsertProviderSource(
		config,
		agentsDir,
		{
			sourceId,
			kind: "discord",
			name: input.name,
			createdName: "Discord Source",
			root,
			now,
			providerSettings: discordSettingsProviderSettings(settings),
		},
		existing,
	);
}

function addGitHubSourceChecked(input: AddGitHubSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	const initialSettings = buildGitHubSettings(input);
	if ("error" in initialSettings) return { ok: false, error: initialSettings.error };

	const config = loadSourcesConfigForWrite(agentsDir);
	const repos = initialSettings.repos.slice().sort();
	const sourceId = `github:${createHash("sha256").update(repos.join(",")).digest("hex").slice(0, 16)}`;
	const existing = config.sources.find((source) => source.id === sourceId);
	const settings = existing
		? buildGitHubSettings(input, parseGitHubSettings(existing.providerSettings))
		: initialSettings;
	if ("error" in settings) return { ok: false, error: settings.error };

	return upsertProviderSource(
		config,
		agentsDir,
		{
			sourceId,
			kind: "github",
			name: input.name,
			createdName: settings.repos[0] ?? "GitHub Source",
			root: `github://repos/${repos.join(",")}`,
			now: input.now ?? new Date().toISOString(),
			providerSettings: githubSettingsProviderSettings(settings),
		},
		existing,
	);
}

interface ProviderSourceUpsert {
	readonly sourceId: string;
	readonly kind: "discord" | "github";
	readonly name?: string;
	readonly createdName: string;
	readonly root: string;
	readonly now: string;
	readonly providerSettings: SignetSourceProviderSettings;
}

function mapProviderSource(input: ProviderSourceUpsert, existing?: SignetSourceEntry): SignetSourceEntry {
	const defaults: Pick<SignetSourceEntry, "kind" | "name" | "mode" | "createdAt"> = existing ?? {
		kind: input.kind,
		name: input.createdName,
		mode: "read-only",
		createdAt: input.now,
	};
	return {
		...existing,
		id: input.sourceId,
		generation: newSourceGeneration(),
		kind: defaults.kind,
		name: cleanName(input.name) ?? defaults.name,
		root: input.root,
		enabled: true,
		mode: defaults.mode,
		createdAt: defaults.createdAt,
		updatedAt: input.now,
		providerSettings: input.providerSettings,
	};
}

function upsertProviderSource(
	config: SignetSourcesConfig,
	agentsDir: string,
	input: ProviderSourceUpsert,
	existing: SignetSourceEntry | undefined,
): AddSourceResult {
	const source = mapProviderSource(input, existing);
	const created = persistSourceUpsert(config, source, existing, agentsDir);
	return { ok: true, source, created };
}

function persistSourceUpsert(
	config: SignetSourcesConfig,
	source: SignetSourceEntry,
	existing: SignetSourceEntry | undefined,
	agentsDir: string,
): boolean {
	const sources = existing
		? config.sources.map((entry) => (entry.id === existing.id ? source : entry))
		: [...config.sources, source];
	saveSourcesConfig({ version: SOURCES_CONFIG_VERSION, sources }, agentsDir);
	return existing === undefined;
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
		const created = persistSourceUpsert(cfg, updated, existing, agentsDir);
		return { ok: true, source: updated, created };
	}

	const source: SignetSourceEntry = {
		id: `obsidian:${createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
		generation: newSourceGeneration(),
		kind: "obsidian",
		name: cleanName(input.name) ?? "Obsidian Vault",
		root,
		enabled: true,
		mode: "read-only",
		createdAt: now,
		updatedAt: now,
		excludeGlobs: mergeDefaultObsidianExcludeGlobs(input.excludeGlobs),
	};
	const created = persistSourceUpsert(cfg, source, undefined, agentsDir);
	return { ok: true, source, created };
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
export function removeSourceIfGeneration(
	sourceId: string,
	generation: string | undefined,
	agentsDir = getAgentsDir(),
): RemoveSourceIfGenerationResult {
	return withSourcesConfigLock(agentsDir, () => {
		try {
			const id = sourceId.trim();
			if (!id) return { ok: false, error: "Source id is required" };
			const cfg = loadSourcesConfigForWrite(agentsDir);
			const source = cfg.sources.find((entry) => entry.id === id);
			if (!source || source.generation !== generation) return { ok: true, removed: false, source };
			saveSourcesConfig(
				{ version: SOURCES_CONFIG_VERSION, sources: cfg.sources.filter((entry) => entry !== source) },
				agentsDir,
			);
			return { ok: true, removed: true, source };
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			return { ok: false, error: detail };
		}
	});
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
