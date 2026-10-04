import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	type WorkspaceLayout,
	WORKSPACE_LAYOUT_V1,
	WORKSPACE_LAYOUT_V2,
	persistWorkspaceLayout,
	readWorkspaceLayoutOverrides,
	resolveWorkspaceLayout,
	resolveWorkspaceLayoutAs,
} from "@signet/core";

export const WORKSPACE_LAYOUT_UPGRADE_FILE = ".workspace-layout-upgrade.json";

const ARTIFACT_FILE = /^[^/\\]+--(?:summary|transcript|compaction|manifest)\.md$/;
const DATABASE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

export type LayoutMove = { readonly from: string; readonly to: string };

type InProgressRecord = {
	readonly version: 1;
	readonly state: "in-progress";
	readonly startedAt: string;
	readonly moves: readonly LayoutMove[];
	readonly createdDirectories: readonly string[];
	readonly emptiedDirectories: readonly string[];
};

export type BlockedRecord = {
	readonly version: 1;
	readonly state: "blocked";
	readonly reason: string;
	readonly at: string;
};

type UpgradeRecord = InProgressRecord | BlockedRecord;

export type WorkspaceLayoutUpgradeResult =
	| { readonly status: "current" }
	| { readonly status: "upgraded"; readonly moved: number; readonly resumed: boolean }
	| { readonly status: "blocked"; readonly reason: string }
	| { readonly status: "skipped"; readonly reason: string };

export type WorkspaceLayoutUpgradeDeps = {
	readonly rename?: (from: string, to: string) => void;
	readonly now?: () => Date;
};

class UpgradeBlocked extends Error {}

export function readWorkspaceLayoutUpgradeRecord(root: string): UpgradeRecord | null {
	const path = join(root, WORKSPACE_LAYOUT_UPGRADE_FILE);
	if (!existsSync(path)) return null;
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object" || Reflect.get(value, "version") !== 1)
		throw new Error(`invalid workspace layout upgrade record at ${path}`);
	const state = Reflect.get(value, "state");
	if (state === "blocked") {
		const reason = Reflect.get(value, "reason");
		const at = Reflect.get(value, "at");
		if (typeof reason !== "string" || typeof at !== "string")
			throw new Error(`invalid workspace layout upgrade record at ${path}`);
		return { version: 1, state, reason, at };
	}
	if (state !== "in-progress") throw new Error(`invalid workspace layout upgrade record at ${path}`);
	const moves = Reflect.get(value, "moves");
	const created = Reflect.get(value, "createdDirectories");
	const emptied = Reflect.get(value, "emptiedDirectories");
	const startedAt = Reflect.get(value, "startedAt");
	if (
		typeof startedAt !== "string" ||
		!Array.isArray(moves) ||
		!moves.every(isMove) ||
		!isPathList(created) ||
		!isPathList(emptied)
	)
		throw new Error(`invalid workspace layout upgrade record at ${path}`);
	return { version: 1, state, startedAt, moves, createdDirectories: created, emptiedDirectories: emptied };
}

function isRelativeWithin(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!isAbsolute(value) &&
		value !== ".." &&
		!value.startsWith(`..${sep}`) &&
		!value.startsWith("../")
	);
}

function isMove(value: unknown): value is LayoutMove {
	return (
		!!value &&
		typeof value === "object" &&
		isRelativeWithin(Reflect.get(value, "from")) &&
		isRelativeWithin(Reflect.get(value, "to"))
	);
}

function isPathList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isRelativeWithin);
}

function writeRecord(root: string, record: UpgradeRecord): void {
	const path = join(root, WORKSPACE_LAYOUT_UPGRADE_FILE);
	const temp = `${path}.tmp-${process.pid}`;
	const fd = openSync(temp, "w", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, path);
	syncDirectory(root);
}

function removeRecord(root: string): void {
	try {
		unlinkSync(join(root, WORKSPACE_LAYOUT_UPGRADE_FILE));
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	syncDirectory(root);
}

function syncDirectory(path: string): void {
	if (process.platform === "win32") return;
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const code = Reflect.get(error, "code");
	return typeof code === "string" ? code : undefined;
}

function entry(path: string): ReturnType<typeof lstatSync> | null {
	try {
		return lstatSync(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
		throw error;
	}
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function containsOrEquals(parent: string, path: string): boolean {
	return parent === path || inside(parent, path);
}

function plan(root: string): { moves: LayoutMove[]; created: string[]; emptied: string[] } {
	const v1 = resolveWorkspaceLayoutAs(root, WORKSPACE_LAYOUT_V1);
	const v2 = resolveWorkspaceLayoutAs(root, WORKSPACE_LAYOUT_V2);
	const moves: { from: string; to: string }[] = [];
	const emptied: string[] = [];
	const add = (from: string, to: string): void => {
		if (from === to || !entry(from)) return;
		moves.push({ from, to });
	};

	if (v1.database !== v2.database)
		for (const suffix of DATABASE_SUFFIXES) add(v1.database + suffix, v2.database + suffix);
	if (v1.cache !== v2.cache) add(v1.cache, v2.cache);
	if (v1.imports !== v2.imports) add(v1.imports, v2.imports);
	if (v1.runtime !== v2.runtime) add(v1.runtime, v2.runtime);

	if (entry(v1.transcripts)?.isDirectory()) {
		for (const harness of readdirSync(v1.transcripts)) {
			const nested = join(v1.transcripts, harness, "transcripts");
			if (!entry(join(v1.transcripts, harness))?.isDirectory() || !entry(nested)?.isDirectory()) continue;
			for (const name of readdirSync(nested)) add(join(nested, name), join(v2.transcripts, harness, name));
			emptied.push(nested);
		}
		if (v1.transcripts !== v2.transcripts)
			for (const name of readdirSync(v1.transcripts))
				if (ARTIFACT_FILE.test(name) && entry(join(v1.transcripts, name))?.isFile())
					add(join(v1.transcripts, name), join(v2.transcripts, name));
	}

	if (v1.data !== v2.data && inside(root, v1.data) && entry(v1.data)?.isDirectory()) {
		const legacy = join(v2.data, "legacy-memory");
		const claimed = new Set(moves.map((move) => move.from));
		const retained = [v2.database, v2.transcripts, v2.cache, v2.imports, v2.runtime, v2.files, v2.secrets, v2.skills];
		for (const name of readdirSync(v1.data)) {
			const from = join(v1.data, name);
			if (claimed.has(from) || retained.some((path) => containsOrEquals(from, path))) continue;
			if (emptied.some((path) => inside(from, path))) {
				emptied.push(join(legacy, name, "transcripts"), join(legacy, name));
			}
			add(from, join(legacy, name));
		}
		emptied.push(legacy, v1.data);
	}

	for (const move of moves) {
		if (!inside(root, move.from) || !inside(root, move.to))
			throw new UpgradeBlocked(`refusing to move a path outside the workspace: ${move.from}`);
	}

	const created = new Set<string>();
	const rootDevice = lstatSync(root).dev;
	for (const move of moves) {
		const source = lstatSync(move.from);
		if (source.dev !== rootDevice)
			throw new UpgradeBlocked(`${relative(root, move.from)} is on a different filesystem than the workspace`);
		if (source.isSymbolicLink() && !isAbsolute(readlinkSync(move.from)))
			throw new UpgradeBlocked(`${relative(root, move.from)} is a relative symlink that would break if moved`);
		assertNoSymlinkAncestors(root, move.from);
		if (entry(move.to)) throw new UpgradeBlocked(`${relative(root, move.to)} already exists`);
		let parent = dirname(move.to);
		while (parent !== root && inside(root, parent)) {
			const existing = entry(parent);
			if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
				throw new UpgradeBlocked(`${relative(root, parent)} exists and is not a directory`);
			if (!existing) created.add(parent);
			parent = dirname(parent);
		}
	}
	for (const path of new Set([v2.data, v2.transcripts, v2.cache, v2.runtime])) {
		if (!inside(root, path) || [v1.data, v1.transcripts, v1.cache, v1.runtime].includes(path)) continue;
		const existing = entry(path);
		if (existing && (!existing.isDirectory() || readdirSync(path).length > 0))
			throw new UpgradeBlocked(`${relative(root, path)} already exists and is not empty`);
	}

	const destinations = new Set<string>();
	for (const move of moves) {
		if (destinations.has(move.to)) throw new UpgradeBlocked(`two paths map to ${relative(root, move.to)}`);
		destinations.add(move.to);
	}

	const rel = (path: string): string => relative(root, path);
	return {
		moves: moves.map((move) => ({ from: rel(move.from), to: rel(move.to) })),
		created: [...created].map(rel),
		emptied: emptied.filter((path) => inside(root, path)).map(rel),
	};
}

function assertNoSymlinkAncestors(root: string, path: string): void {
	let parent = dirname(path);
	while (parent !== root && inside(root, parent)) {
		if (lstatSync(parent).isSymbolicLink())
			throw new UpgradeBlocked(`${relative(root, parent)} is a symlink; Signet will not move files through it`);
		parent = dirname(parent);
	}
}

function apply(root: string, record: InProgressRecord, rename: (from: string, to: string) => void): number {
	let moved = 0;
	for (const move of record.moves) {
		const from = join(root, move.from);
		const to = join(root, move.to);
		const source = entry(from);
		const target = entry(to);
		if (!source && target) continue;
		if (!source) continue;
		if (target) throw new UpgradeBlocked(`${move.to} already exists`);
		assertNoSymlinkAncestors(root, from);
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
		rename(from, to);
		moved += 1;
	}
	for (const directory of record.emptiedDirectories) removeIfEmpty(join(root, directory));
	return moved;
}

function rollback(root: string, record: InProgressRecord, rename: (from: string, to: string) => void): string[] {
	const stranded: string[] = [];
	for (const move of [...record.moves].reverse()) {
		const from = join(root, move.from);
		const to = join(root, move.to);
		if (!entry(to) || entry(from)) continue;
		try {
			mkdirSync(dirname(from), { recursive: true, mode: 0o700 });
			rename(to, from);
		} catch {
			stranded.push(move.to);
		}
	}
	const created = [...record.createdDirectories].sort((a, b) => b.length - a.length);
	for (const directory of created) removeIfEmpty(join(root, directory));
	return stranded;
}

function removeIfEmpty(path: string): void {
	try {
		rmdirSync(path);
	} catch {}
}

export function upgradeWorkspaceLayout(
	rootPath: string,
	deps: WorkspaceLayoutUpgradeDeps = {},
): WorkspaceLayoutUpgradeResult {
	const root = resolve(rootPath);
	const rename = deps.rename ?? renameSync;
	const now = deps.now ?? (() => new Date());
	const existing = readWorkspaceLayoutUpgradeRecord(root);
	const layout: WorkspaceLayout = resolveWorkspaceLayout(root);
	if (layout.version === WORKSPACE_LAYOUT_V2 && existing?.state !== "in-progress") {
		if (existing) removeRecord(root);
		return { status: "current" };
	}

	let record: InProgressRecord;
	const resumed = existing?.state === "in-progress";
	if (existing?.state === "in-progress") {
		record = existing;
	} else {
		try {
			const planned = plan(root);
			record = {
				version: 1,
				state: "in-progress",
				startedAt: now().toISOString(),
				moves: planned.moves,
				createdDirectories: planned.created,
				emptiedDirectories: planned.emptied,
			};
		} catch (error) {
			if (!(error instanceof UpgradeBlocked)) throw error;
			writeRecord(root, { version: 1, state: "blocked", reason: error.message, at: now().toISOString() });
			return { status: "blocked", reason: error.message };
		}
		writeRecord(root, record);
	}

	try {
		const moved = apply(root, record, rename);
		if (layout.version !== WORKSPACE_LAYOUT_V2) {
			persistWorkspaceLayout(root, { version: WORKSPACE_LAYOUT_V2, overrides: readWorkspaceLayoutOverrides(root) });
			syncDirectory(root);
		}
		removeRecord(root);
		return { status: "upgraded", moved, resumed };
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		const stranded = layout.version === WORKSPACE_LAYOUT_V2 ? [] : rollback(root, record, rename);
		const reason =
			stranded.length > 0
				? `${cause}; could not restore ${stranded.join(", ")}`
				: layout.version === WORKSPACE_LAYOUT_V2
					? `${cause}; the workspace is already on layout v2`
					: cause;
		if (stranded.length > 0 || layout.version === WORKSPACE_LAYOUT_V2) {
			throw new Error(`workspace layout upgrade could not finish: ${reason}`, { cause: error });
		}
		writeRecord(root, { version: 1, state: "blocked", reason, at: now().toISOString() });
		return { status: "blocked", reason };
	}
}

export function readWorkspaceLayoutStatus(
	root: string,
	version: number,
): {
	readonly version: number;
	readonly upgrade: Omit<BlockedRecord, "version"> | { readonly state: "unreadable" } | null;
} {
	try {
		const record = readWorkspaceLayoutUpgradeRecord(root);
		return {
			version,
			upgrade: record?.state === "blocked" ? { state: record.state, reason: record.reason, at: record.at } : null,
		};
	} catch {
		return { version, upgrade: { state: "unreadable" } };
	}
}
