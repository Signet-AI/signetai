import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

export const WORKSPACE_LAYOUT_V1 = 1 as const;
export const WORKSPACE_LAYOUT_V2 = 2 as const;
export type WorkspaceLayoutVersion = typeof WORKSPACE_LAYOUT_V1 | typeof WORKSPACE_LAYOUT_V2;
const PRIVATE_SEGMENTS: ReadonlySet<string> = new Set([".daemon", ".secrets", "memory"]);
const PRIVATE_ROOT_DIRS: ReadonlySet<string> = new Set(["runtime", "data", "transcripts", "cache"]);

export function isWorkspacePrivatePath(relativePath: string): boolean {
	const parts = relativePath
		.split(/[\\/]/)
		.filter((part) => part.length > 0)
		.map((part) => part.toLowerCase());
	return parts.some((part) => PRIVATE_SEGMENTS.has(part)) || PRIVATE_ROOT_DIRS.has(parts[0] ?? "");
}

const LEGACY_ARTIFACT_PATH = /^memory\/[^/]+--(?:summary|transcript|compaction|manifest)\.md$/;

export function currentArtifactRelativePath(version: WorkspaceLayoutVersion, path: string): string {
	return version === WORKSPACE_LAYOUT_V2 && LEGACY_ARTIFACT_PATH.test(path)
		? `transcripts/${path.slice("memory/".length)}`
		: path;
}

export interface WorkspaceLayoutOverrides {
	database?: string;
	transcripts?: string;
	runtime?: string;
	cache?: string;
	files?: string;
	imports?: string;
	secrets?: string;
	skills?: string;
	data?: string;
}

export interface WorkspaceLayout {
	readonly root: string;
	readonly version: WorkspaceLayoutVersion;
	readonly database: string;
	readonly transcripts: string;
	readonly runtime: string;
	readonly cache: string;
	readonly files: string;
	readonly imports: string;
	readonly secrets: string;
	readonly skills: string;
	readonly data: string;
	readonly layoutFile: string;
}

interface PersistedLayout {
	version: number;
	overrides?: WorkspaceLayoutOverrides;
}

export function serializeWorkspaceLayout(input: {
	version: WorkspaceLayoutVersion;
	overrides?: WorkspaceLayoutOverrides;
}): Uint8Array {
	return new TextEncoder().encode(
		`${JSON.stringify({ version: input.version, ...(input.overrides ? { overrides: input.overrides } : {}) }, null, 2)}\n`,
	);
}

const layoutFile = (root: string) => join(root, "workspace-layout.json");
const absolute = (root: string, value: string) => resolve(root, value);

function readPersisted(root: string): PersistedLayout {
	const file = layoutFile(root);
	if (!existsSync(file)) return { version: WORKSPACE_LAYOUT_V1 };
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(
			`Invalid workspace layout state at ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof value !== "object" || value === null || typeof (value as PersistedLayout).version !== "number") {
		throw new Error(`Invalid workspace layout state at ${file}: missing version`);
	}
	const state = value as PersistedLayout;
	if (state.version !== 1 && state.version !== 2)
		throw new Error(`unsupported workspace layout version: ${state.version}`);
	return state;
}

export function persistWorkspaceLayout(
	rootPath: string,
	input: { version: WorkspaceLayoutVersion; overrides?: WorkspaceLayoutOverrides; env?: NodeJS.ProcessEnv },
): string {
	const root = resolve(rootPath);
	mkdirSync(root, { recursive: true });
	const file = layoutFile(root);
	const temp = `${file}.tmp-${process.pid}`;
	const fd = openSync(temp, "w", 0o600);
	try {
		writeSync(fd, serializeWorkspaceLayout(input));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, file);
	return file;
}

export function resolveWorkspaceLayout(rootPath: string, _options: { env?: NodeJS.ProcessEnv } = {}): WorkspaceLayout {
	const root = resolve(rootPath);
	const state = readPersisted(root);
	return layoutFor(root, state.version as WorkspaceLayoutVersion, state.overrides ?? {});
}

export function readWorkspaceLayoutOverrides(rootPath: string): WorkspaceLayoutOverrides {
	return { ...readPersisted(resolve(rootPath)).overrides };
}

export function resolveWorkspaceLayoutAs(rootPath: string, version: WorkspaceLayoutVersion): WorkspaceLayout {
	const root = resolve(rootPath);
	return layoutFor(root, version, readPersisted(root).overrides ?? {});
}

function layoutFor(root: string, version: WorkspaceLayoutVersion, custom: WorkspaceLayoutOverrides): WorkspaceLayout {
	const v2 = version === WORKSPACE_LAYOUT_V2;
	const data = custom.data ? absolute(root, custom.data) : join(root, v2 ? "data" : "memory");
	return {
		root,
		version,
		database: custom.database ? absolute(root, custom.database) : join(data, v2 ? "signet.db" : "memories.db"),
		transcripts: custom.transcripts ? absolute(root, custom.transcripts) : join(root, v2 ? "transcripts" : "memory"),
		runtime: custom.runtime ? absolute(root, custom.runtime) : join(root, v2 ? "runtime" : ".daemon"),
		cache: custom.cache ? absolute(root, custom.cache) : v2 ? join(root, "cache") : join(root, "memory", "cache"),
		files: custom.files ? absolute(root, custom.files) : join(root, "files"),
		imports: custom.imports ? absolute(root, custom.imports) : join(data, "imports"),
		secrets: custom.secrets ? absolute(root, custom.secrets) : join(root, ".secrets"),
		skills: custom.skills ? absolute(root, custom.skills) : join(root, "skills"),
		data,
		layoutFile: layoutFile(root),
	};
}
export function findExistingWorkspaceDatabase(rootPath: string): string | null {
	const layout = resolveWorkspaceLayout(rootPath);
	const candidates = [
		layout.database,
		join(layout.data, "signet.db"),
		join(layout.root, "data", "signet.db"),
		join(layout.root, "memory", "memories.db"),
	];
	return candidates.find((database) => existsSync(database)) ?? null;
}
export function hasExistingWorkspaceState(rootPath: string): boolean {
	if (findExistingWorkspaceDatabase(rootPath) !== null) return true;
	const layout = resolveWorkspaceLayout(rootPath);
	return layout.version === WORKSPACE_LAYOUT_V1 && existsSync(layout.runtime);
}

export function createFreshWorkspaceV2(
	rootPath: string,
	options: { env?: NodeJS.ProcessEnv; overrides?: WorkspaceLayoutOverrides } = {},
): WorkspaceLayout {
	const root = resolve(rootPath);
	const existing = existsSync(layoutFile(root)) ? readPersisted(root) : undefined;
	const overrides = { ...existing?.overrides, ...options.overrides };
	const file = persistWorkspaceLayout(root, { version: WORKSPACE_LAYOUT_V2, overrides });
	const layout = resolveWorkspaceLayout(root, options);
	for (const directory of [
		layout.files,
		layout.data,
		layout.transcripts,
		layout.runtime,
		layout.cache,
		layout.secrets,
		layout.skills,
		layout.imports,
	])
		mkdirSync(directory, { recursive: true });
	return { ...layout, layoutFile: file };
}
