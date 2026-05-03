import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type SignetSourceKind = "obsidian";
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
}

export interface SignetSourcesConfig {
	readonly version: 1;
	readonly sources: readonly SignetSourceEntry[];
}

export interface AddObsidianSourceInput {
	readonly root: string;
	readonly name?: string;
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
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

export function addObsidianSource(input: AddObsidianSourceInput, agentsDir = getAgentsDir()): AddSourceResult {
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
	const cfg = loadSourcesConfig(agentsDir);
	const existing = cfg.sources.find((source) => source.kind === "obsidian" && source.root === root);
	if (existing) {
		const updated = { ...existing, name: cleanName(input.name) ?? existing.name, enabled: true, updatedAt: now };
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
	};
	saveSourcesConfig({ version: SOURCES_CONFIG_VERSION, sources: [...cfg.sources, source] }, agentsDir);
	return { ok: true, source, created: true };
}

export function markSourceIndexed(
	sourceId: string,
	indexedAt = new Date().toISOString(),
	agentsDir = getAgentsDir(),
): void {
	const cfg = loadSourcesConfig(agentsDir);
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
	const id = sourceId.trim();
	if (!id) return { ok: false, error: "Source id is required" };
	const cfg = loadSourcesConfig(agentsDir);
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

function cleanName(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourceEntry(value: unknown): value is SignetSourceEntry {
	return (
		isRecord(value) &&
		value.kind === "obsidian" &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.root === "string" &&
		typeof value.enabled === "boolean" &&
		value.mode === "read-only" &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		(value.lastIndexedAt === undefined || typeof value.lastIndexedAt === "string")
	);
}
