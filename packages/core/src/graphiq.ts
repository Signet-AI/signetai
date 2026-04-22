import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SIGNET_GRAPHIQ_PLUGIN_ID } from "./plugins";

export const SIGNET_GRAPHIQ_STATE_FILE = ".daemon/graphiq/state.json";

export interface GraphiqIndexedProject {
	readonly path: string;
	readonly dbPath: string;
	readonly lastIndexedAt: string;
	readonly files?: number;
	readonly symbols?: number;
	readonly edges?: number;
}

export interface GraphiqPluginState {
	readonly pluginId: typeof SIGNET_GRAPHIQ_PLUGIN_ID;
	readonly enabled: boolean;
	readonly managedBy: "signet";
	readonly installSource?: "homebrew" | "source" | "existing";
	readonly activeProject?: string;
	readonly indexedProjects: readonly GraphiqIndexedProject[];
	readonly updatedAt: string;
}

export interface UpdateGraphiqActiveProjectInput {
	readonly projectPath: string;
	readonly indexedAt?: Date;
	readonly installSource?: GraphiqPluginState["installSource"];
	readonly files?: number;
	readonly symbols?: number;
	readonly edges?: number;
}

export function getGraphiqStatePath(basePath: string): string {
	return join(basePath, SIGNET_GRAPHIQ_STATE_FILE);
}

export function getGraphiqProjectDbPath(projectPath: string): string {
	return join(resolve(projectPath), ".graphiq", "graphiq.db");
}

export function emptyGraphiqState(now: Date = new Date()): GraphiqPluginState {
	return {
		pluginId: SIGNET_GRAPHIQ_PLUGIN_ID,
		enabled: false,
		managedBy: "signet",
		indexedProjects: [],
		updatedAt: now.toISOString(),
	};
}

export function readGraphiqState(basePath: string): GraphiqPluginState {
	const path = getGraphiqStatePath(basePath);
	if (!existsSync(path)) return emptyGraphiqState();
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return parseGraphiqState(parsed);
	} catch {
		return emptyGraphiqState();
	}
}

export function writeGraphiqState(basePath: string, state: GraphiqPluginState): void {
	const path = getGraphiqStatePath(basePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function updateGraphiqActiveProject(
	basePath: string,
	input: UpdateGraphiqActiveProjectInput,
): GraphiqPluginState {
	const current = readGraphiqState(basePath);
	const indexedAt = input.indexedAt ?? new Date();
	const projectPath = resolve(input.projectPath);
	const project: GraphiqIndexedProject = {
		path: projectPath,
		dbPath: getGraphiqProjectDbPath(projectPath),
		lastIndexedAt: indexedAt.toISOString(),
		...(typeof input.files === "number" ? { files: input.files } : {}),
		...(typeof input.symbols === "number" ? { symbols: input.symbols } : {}),
		...(typeof input.edges === "number" ? { edges: input.edges } : {}),
	};
	const otherProjects = current.indexedProjects.filter((entry) => entry.path !== projectPath);
	const next: GraphiqPluginState = {
		...current,
		pluginId: SIGNET_GRAPHIQ_PLUGIN_ID,
		enabled: true,
		managedBy: "signet",
		...(input.installSource ? { installSource: input.installSource } : {}),
		activeProject: projectPath,
		indexedProjects: [project, ...otherProjects],
		updatedAt: indexedAt.toISOString(),
	};
	writeGraphiqState(basePath, next);
	return next;
}

export function enableGraphiqState(
	basePath: string,
	input: { readonly installSource?: GraphiqPluginState["installSource"]; readonly now?: Date } = {},
): GraphiqPluginState {
	const current = readGraphiqState(basePath);
	const now = input.now ?? new Date();
	const next: GraphiqPluginState = {
		...current,
		pluginId: SIGNET_GRAPHIQ_PLUGIN_ID,
		enabled: true,
		managedBy: "signet",
		...(input.installSource ? { installSource: input.installSource } : {}),
		updatedAt: now.toISOString(),
	};
	writeGraphiqState(basePath, next);
	return next;
}

export function disableGraphiqState(basePath: string, now: Date = new Date()): GraphiqPluginState {
	const current = readGraphiqState(basePath);
	const next: GraphiqPluginState = {
		...current,
		pluginId: SIGNET_GRAPHIQ_PLUGIN_ID,
		enabled: false,
		managedBy: "signet",
		updatedAt: now.toISOString(),
	};
	writeGraphiqState(basePath, next);
	return next;
}

function parseGraphiqState(value: unknown): GraphiqPluginState {
	if (!isRecord(value)) return emptyGraphiqState();
	const indexedProjects = Array.isArray(value.indexedProjects)
		? value.indexedProjects.map(parseIndexedProject).filter((entry): entry is GraphiqIndexedProject => entry !== null)
		: [];
	const activeProject = typeof value.activeProject === "string" ? value.activeProject : undefined;
	const installSource = parseInstallSource(value.installSource);
	return {
		pluginId: SIGNET_GRAPHIQ_PLUGIN_ID,
		enabled: value.enabled === true,
		managedBy: "signet",
		...(installSource ? { installSource } : {}),
		...(activeProject ? { activeProject } : {}),
		indexedProjects,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
	};
}

function parseIndexedProject(value: unknown): GraphiqIndexedProject | null {
	if (!isRecord(value)) return null;
	if (typeof value.path !== "string" || typeof value.dbPath !== "string" || typeof value.lastIndexedAt !== "string") {
		return null;
	}
	return {
		path: value.path,
		dbPath: value.dbPath,
		lastIndexedAt: value.lastIndexedAt,
		...(typeof value.files === "number" ? { files: value.files } : {}),
		...(typeof value.symbols === "number" ? { symbols: value.symbols } : {}),
		...(typeof value.edges === "number" ? { edges: value.edges } : {}),
	};
}

function parseInstallSource(value: unknown): GraphiqPluginState["installSource"] | undefined {
	return value === "homebrew" || value === "source" || value === "existing" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
