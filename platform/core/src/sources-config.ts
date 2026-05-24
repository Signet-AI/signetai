import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type SignetSourceKind = "obsidian" | "github";
export type SignetSourceMode = "read-only";

export interface GitHubSourceSettings {
	readonly repos: readonly string[];
	readonly tokenRef?: string;
	readonly resourceTypes: readonly ("issues" | "pulls" | "discussions" | "docs")[];
	readonly state?: "open" | "closed" | "all";
	readonly includeComments?: boolean;
	readonly labels?: readonly string[];
	readonly docPaths?: readonly string[];
	readonly maxItemsPerRepo?: number;
}

export const DEFAULT_GITHUB_RESOURCE_TYPES = ["issues", "pulls", "discussions", "docs"] as const;
export const DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN = ["issues", "pulls", "docs"] as const;
const VALID_GITHUB_RESOURCE_TYPES = new Set<string>(DEFAULT_GITHUB_RESOURCE_TYPES);
export const DEFAULT_GITHUB_DOC_PATHS = ["README.md", "CHANGELOG.md"] as const;

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
	readonly agentId?: string;
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

export interface AddGitHubSourceInput {
	readonly repos: readonly string[];
	readonly name?: string;
	readonly tokenRef?: string;
	readonly resourceTypes?: readonly ("issues" | "pulls" | "discussions" | "docs")[];
	readonly state?: "open" | "closed" | "all";
	readonly includeComments?: boolean;
	readonly labels?: readonly string[];
	readonly docPaths?: readonly string[];
	readonly maxItemsPerRepo?: number;
	readonly now?: string;
	readonly agentId?: string;
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

export function addGitHubSource(input: AddGitHubSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
	return withSourcesConfigLock(agentsDir, () => addGitHubSourceUnlocked(input, agentsDir));
}

function resolveSourceAgentId(agentId?: string): string {
	return cleanName(agentId) ?? cleanName(process.env.SIGNET_AGENT_ID) ?? "default";
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
	const repos = input.repos.map((r) => r.trim()).filter(Boolean);
	if (repos.length === 0) return { ok: false, error: "At least one repo (owner/repo or owner/*) is required" };
	for (const repo of repos) {
		if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_*.-]+$/.test(repo)) {
			return { ok: false, error: `Invalid repo pattern: ${repo}. Expected owner/repo or owner/*` };
		}
	}

	if (input.maxItemsPerRepo !== undefined) {
		if (!Number.isInteger(input.maxItemsPerRepo) || input.maxItemsPerRepo < 1 || input.maxItemsPerRepo > 10000) {
			return { ok: false, error: "maxItemsPerRepo must be an integer between 1 and 10000" };
		}
	}

	if (input.resourceTypes) {
		if (!Array.isArray(input.resourceTypes)) {
			return { ok: false, error: "resourceTypes must be an array" };
		}
		if (input.resourceTypes.length === 0) {
			return { ok: false, error: "resourceTypes must include at least one resource type" };
		}
		const invalid = input.resourceTypes.filter((t) => !VALID_GITHUB_RESOURCE_TYPES.has(t));
		if (invalid.length > 0) {
			return {
				ok: false,
				error: `Invalid resource types: ${invalid.join(", ")}. Must be one of: ${[...DEFAULT_GITHUB_RESOURCE_TYPES].join(", ")}`,
			};
		}
	}
	if (input.tokenRef !== undefined && typeof input.tokenRef !== "string") {
		return { ok: false, error: "tokenRef must be a string" };
	}
	if (input.state !== undefined && input.state !== "open" && input.state !== "closed" && input.state !== "all") {
		return { ok: false, error: "state must be one of: open, closed, all" };
	}
	if (input.includeComments !== undefined && typeof input.includeComments !== "boolean") {
		return { ok: false, error: "includeComments must be a boolean" };
	}
	if (input.labels !== undefined && !isStringArray(input.labels)) {
		return { ok: false, error: "labels must be an array of strings" };
	}
	if (input.docPaths !== undefined) {
		if (!isStringArray(input.docPaths)) return { ok: false, error: "docPaths must be an array of strings" };
		const invalid = input.docPaths.filter((path) => !isSafeGitHubDocPath(path));
		if (invalid.length > 0) {
			return { ok: false, error: `Invalid docPaths: ${invalid.join(", ")}` };
		}
	}

	const now = input.now ?? new Date().toISOString();
	const cfg = loadSourcesConfigForWrite(agentsDir);
	const agentId = resolveSourceAgentId(input.agentId);
	const settingsKey = [...repos].sort().join(",");
	const existing = cfg.sources.find(
		(source) =>
			source.kind === "github" &&
			(source.agentId ?? "default") === agentId &&
			Array.isArray(source.settings?.repos) &&
			[...(source.settings.repos as string[])].sort().join(",") === settingsKey,
	);

	if (existing) {
		const existingSettings = parseGitHubSettings(existing.settings);
		const updated: SignetSourceEntry = {
			...existing,
			name: cleanName(input.name) ?? existing.name,
			enabled: true,
			updatedAt: now,
			settings: buildGitHubSettings(input, repos, existingSettings),
			agentId,
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
		id: `github:${createHash("sha256").update(`${agentId}\0${settingsKey}`).digest("hex").slice(0, 16)}`,
		kind: "github",
		name: cleanName(input.name) ?? repos[0],
		root: "",
		enabled: true,
		mode: "read-only",
		createdAt: now,
		updatedAt: now,
		settings: buildGitHubSettings(input, repos),
		agentId,
	};
	saveSourcesConfig({ version: SOURCES_CONFIG_VERSION, sources: [...cfg.sources, source] }, agentsDir);
	return { ok: true, source, created: true };
}

function buildGitHubSettings(
	input: AddGitHubSourceInput,
	repos: readonly string[],
	existing?: GitHubSourceSettings,
): Readonly<Record<string, unknown>> {
	const tokenRef = input.tokenRef !== undefined ? input.tokenRef.trim() || undefined : existing?.tokenRef;
	const resourceTypes = input.resourceTypes
		? [...input.resourceTypes]
		: existing?.resourceTypes?.length
			? [...existing.resourceTypes]
			: tokenRef
				? [...DEFAULT_GITHUB_RESOURCE_TYPES]
				: [...DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN];
	return {
		repos: repos,
		tokenRef,
		resourceTypes,
		state: input.state ?? existing?.state ?? "all",
		includeComments: input.includeComments ?? existing?.includeComments ?? true,
		labels: input.labels !== undefined ? cleanStringArray(input.labels) : existing?.labels,
		docPaths: input.docPaths !== undefined ? cleanStringArray(input.docPaths) : (existing?.docPaths ?? [...DEFAULT_GITHUB_DOC_PATHS]),
		maxItemsPerRepo: input.maxItemsPerRepo ?? existing?.maxItemsPerRepo ?? 500,
	};
}

export function parseGitHubSettings(raw: Readonly<Record<string, unknown>> | undefined): GitHubSourceSettings {
	if (!raw) {
		return { repos: [], resourceTypes: [...DEFAULT_GITHUB_RESOURCE_TYPES] };
	}
	const repos =
		Array.isArray(raw.repos) && raw.repos.every((r) => typeof r === "string") ? (raw.repos as string[]) : [];
	let resourceTypes =
		Array.isArray(raw.resourceTypes) && raw.resourceTypes.every((t) => typeof t === "string")
			? (raw.resourceTypes as string[]).filter((t): t is "issues" | "pulls" | "discussions" | "docs" =>
					["issues", "pulls", "discussions", "docs"].includes(t),
				)
			: [...DEFAULT_GITHUB_RESOURCE_TYPES];
	if (resourceTypes.length === 0) resourceTypes = [...DEFAULT_GITHUB_RESOURCE_TYPES];
	return {
		repos,
		tokenRef: typeof raw.tokenRef === "string" ? raw.tokenRef : undefined,
		resourceTypes,
		state: raw.state === "open" || raw.state === "closed" || raw.state === "all" ? raw.state : "all",
		includeComments: typeof raw.includeComments === "boolean" ? raw.includeComments : true,
		labels:
			Array.isArray(raw.labels) && raw.labels.every((l) => typeof l === "string")
				? (raw.labels as string[])
				: undefined,
		docPaths:
			Array.isArray(raw.docPaths) && raw.docPaths.every((p) => typeof p === "string")
				? (raw.docPaths as string[])
				: [...DEFAULT_GITHUB_DOC_PATHS],
		maxItemsPerRepo: typeof raw.maxItemsPerRepo === "number" && raw.maxItemsPerRepo > 0 ? raw.maxItemsPerRepo : 500,
	};
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

function cleanStringArray(values: readonly string[]): readonly string[] {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
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
	if (
		!(
			isRecord(value) &&
			(value.kind === "obsidian" || value.kind === "github") &&
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
			(value.settings === undefined || isRecord(value.settings)) &&
			(value.agentId === undefined || typeof value.agentId === "string")
		)
	) {
		return false;
	}
	if (value.kind === "github") {
		return typeof value.agentId === "string" && isValidGitHubSettingsRecord(value.settings);
	}
	return true;
}

function isValidGitHubSettingsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (!isRecord(value)) return false;
	if (
		!Array.isArray(value.repos) ||
		value.repos.length === 0 ||
		!value.repos.every((repo) => typeof repo === "string")
	) {
		return false;
	}
	if (value.tokenRef !== undefined && typeof value.tokenRef !== "string") return false;
	if (value.includeComments !== undefined && typeof value.includeComments !== "boolean") return false;
	if (value.state !== undefined && value.state !== "open" && value.state !== "closed" && value.state !== "all") {
		return false;
	}
	if (value.resourceTypes !== undefined) {
		if (
			!Array.isArray(value.resourceTypes) ||
			value.resourceTypes.length === 0 ||
			!value.resourceTypes.every((type) => typeof type === "string" && VALID_GITHUB_RESOURCE_TYPES.has(type))
		) {
			return false;
		}
	}
	if (value.labels !== undefined) {
		if (!Array.isArray(value.labels) || !value.labels.every((label) => typeof label === "string")) return false;
	}
	if (value.docPaths !== undefined) {
		if (
			!Array.isArray(value.docPaths) ||
			!value.docPaths.every((path) => typeof path === "string" && isSafeGitHubDocPath(path))
		) {
			return false;
		}
	}
	if (value.maxItemsPerRepo !== undefined) {
		const maxItemsPerRepo = value.maxItemsPerRepo;
		if (
			typeof maxItemsPerRepo !== "number" ||
			!Number.isInteger(maxItemsPerRepo) ||
			maxItemsPerRepo < 1 ||
			maxItemsPerRepo > 10000
		) {
			return false;
		}
	}
	return true;
}
