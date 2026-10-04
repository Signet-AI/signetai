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
	statSync,
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
const TRANSCRIPT_FILE = /^transcript\.jsonl(?:\.lock)?$/;
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

function isRecordPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		(isAbsolute(value) || (value !== ".." && !value.startsWith(`..${sep}`) && !value.startsWith("../")))
	);
}

function isMove(value: unknown): value is LayoutMove {
	return (
		!!value &&
		typeof value === "object" &&
		isRecordPath(Reflect.get(value, "from")) &&
		isRecordPath(Reflect.get(value, "to"))
	);
}

function isPathList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isRecordPath);
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

function isEmptyDirectory(path: string): boolean {
	const existing = entry(path);
	return !!existing && existing.isDirectory() && !existing.isSymbolicLink() && readdirSync(path).length === 0;
}

function upgradeBases(root: string): string[] {
	const v1 = resolveWorkspaceLayoutAs(root, WORKSPACE_LAYOUT_V1);
	const v2 = resolveWorkspaceLayoutAs(root, WORKSPACE_LAYOUT_V2);
	return [
		root,
		...[v2.transcripts, v2.data].filter(
			(path, index) => !inside(root, path) && path === [v1.transcripts, v1.data][index],
		),
	];
}

function baseFor(bases: readonly string[], move: LayoutMove): string | undefined {
	return bases.find((candidate) => inside(candidate, move.from) && inside(candidate, move.to));
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
	const bases = upgradeBases(root);

	if (v1.database !== v2.database)
		for (const suffix of DATABASE_SUFFIXES) add(v1.database + suffix, v2.database + suffix);
	if (v1.cache !== v2.cache) add(v1.cache, v2.cache);
	if (v1.imports !== v2.imports) add(v1.imports, v2.imports);

	if (entry(v1.transcripts)?.isDirectory()) {
		for (const harness of readdirSync(v1.transcripts)) {
			const nested = join(v1.transcripts, harness, "transcripts");
			if (!entry(join(v1.transcripts, harness))?.isDirectory() || !entry(nested)?.isDirectory()) continue;
			for (const name of readdirSync(nested))
				if (inside(root, nested) || TRANSCRIPT_FILE.test(name))
					add(join(nested, name), join(v2.transcripts, harness, name));
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
		const retained = [
			...DATABASE_SUFFIXES.map((suffix) => v2.database + suffix),
			v2.transcripts,
			v2.cache,
			v2.imports,
			v2.runtime,
			v2.files,
			v2.secrets,
			v2.skills,
		];
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

	if (v1.runtime !== v2.runtime) add(v1.runtime, v2.runtime);

	const created = new Set<string>();
	for (const move of moves) {
		const base = baseFor(bases, move);
		if (!base) throw new UpgradeBlocked(`refusing to move ${move.from} outside its configured root`);
		const label = (path: string): string => (base === root ? relative(root, path) : path);
		const source = lstatSync(move.from);
		if (source.dev !== statSync(base).dev)
			throw new UpgradeBlocked(
				`${label(move.from)} is on a different filesystem than ${label(base) || "the workspace"}`,
			);
		if (source.isSymbolicLink() && !isAbsolute(readlinkSync(move.from)))
			throw new UpgradeBlocked(`${label(move.from)} is a relative symlink that would break if moved`);
		assertNoSymlinkAncestors(base, move.from);
		if (entry(move.to) && !(source.isDirectory() && isEmptyDirectory(move.to)))
			throw new UpgradeBlocked(`${label(move.to)} already exists`);
		let parent = dirname(move.to);
		while (parent !== base && inside(base, parent)) {
			const existing = entry(parent);
			if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
				throw new UpgradeBlocked(`${label(parent)} exists and is not a directory`);
			if (!existing) created.add(parent);
			parent = dirname(parent);
		}
	}
	const targets = new Set(moves.map((move) => move.to));
	for (const path of new Set([v2.data, v2.transcripts, v2.cache, v2.runtime])) {
		if (!inside(root, path) || [v1.data, v1.transcripts, v1.cache, v1.runtime].includes(path) || targets.has(path))
			continue;
		const existing = entry(path);
		if (existing && (!existing.isDirectory() || readdirSync(path).length > 0))
			throw new UpgradeBlocked(`${relative(root, path)} already exists and is not empty`);
	}

	const destinations = new Set<string>();
	for (const move of moves) {
		if (destinations.has(move.to)) throw new UpgradeBlocked(`two paths map to ${move.to}`);
		destinations.add(move.to);
	}

	const stored = (path: string): string => (inside(root, path) ? relative(root, path) : path);
	return {
		moves: moves.map((move) => ({ from: stored(move.from), to: stored(move.to) })),
		created: [...created].map(stored),
		emptied: emptied.map(stored),
	};
}

function assertNoSymlinkAncestors(base: string, path: string): void {
	let parent = dirname(path);
	while (parent !== base && inside(base, parent)) {
		if (lstatSync(parent).isSymbolicLink())
			throw new UpgradeBlocked(`${parent} is a symlink; Signet will not move files through it`);
		parent = dirname(parent);
	}
}

const LAUNCHER_ARTIFACTS = new Set(["daemon.lock", "logs"]);

function launcherOnly(directory: string): boolean {
	const names = readdirSync(directory);
	if (!names.every((name) => LAUNCHER_ARTIFACTS.has(name))) return false;
	const logs = join(directory, "logs");
	if (!names.includes("logs")) return true;
	const stat = entry(logs);
	return (
		!!stat &&
		stat.isDirectory() &&
		!stat.isSymbolicLink() &&
		readdirSync(logs).every((name) => entry(join(logs, name))?.isFile() === true)
	);
}

function absorbLauncherArtifacts(from: string, to: string, now: Date): void {
	const logs = join(from, "logs");
	if (entry(logs)) {
		mkdirSync(join(to, "logs"), { recursive: true, mode: 0o700 });
		for (const name of readdirSync(logs)) {
			let target = join(to, "logs", name);
			if (entry(target)) target = join(to, "logs", `${name}.${now.getTime()}`);
			if (entry(target)) throw new UpgradeBlocked(`${target} already exists`);
			renameSync(join(logs, name), target);
		}
		rmdirSync(logs);
	}
	if (entry(join(from, "daemon.lock"))) unlinkSync(join(from, "daemon.lock"));
	rmdirSync(from);
}

function apply(
	root: string,
	record: InProgressRecord,
	rename: (from: string, to: string) => void,
	performed: LayoutMove[],
	resumed: boolean,
	now: Date,
): void {
	const runtime = resolveWorkspaceLayoutAs(root, WORKSPACE_LAYOUT_V1).runtime;
	for (const move of record.moves) {
		const from = resolve(root, move.from);
		const to = resolve(root, move.to);
		const source = entry(from);
		if (!source) continue;
		if (entry(to)) {
			if (resumed && from === runtime && source.isDirectory() && launcherOnly(from)) {
				absorbLauncherArtifacts(from, to, now);
				continue;
			}
			if (!source.isDirectory() || !isEmptyDirectory(to)) throw new UpgradeBlocked(`${move.to} already exists`);
			rmdirSync(to);
		}
		if (inside(root, from)) assertNoSymlinkAncestors(root, from);
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
		rename(from, to);
		performed.push(move);
	}
	for (const directory of record.emptiedDirectories) removeIfEmpty(resolve(root, directory));
}

function rollback(
	root: string,
	performed: readonly LayoutMove[],
	record: InProgressRecord,
	rename: (from: string, to: string) => void,
): string[] {
	const stranded: string[] = [];
	for (const move of [...performed].reverse()) {
		const from = resolve(root, move.from);
		const to = resolve(root, move.to);
		if (!entry(to) || entry(from)) {
			stranded.push(move.to);
			continue;
		}
		const created = mkdirSync(dirname(from), { recursive: true, mode: 0o700 });
		try {
			rename(to, from);
		} catch {
			stranded.push(move.to);
			if (created) removeEmptyChain(dirname(from), created);
		}
	}
	const created = [...record.createdDirectories].sort((a, b) => b.length - a.length);
	for (const directory of created) removeIfEmpty(resolve(root, directory));
	return stranded;
}

function removeEmptyChain(path: string, top: string): void {
	let current = path;
	while (containsOrEquals(top, current)) {
		removeIfEmpty(current);
		if (current === top) return;
		current = dirname(current);
	}
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
		const bases = upgradeBases(root);
		const outside = existing.moves.find(
			(move) => !baseFor(bases, { from: resolve(root, move.from), to: resolve(root, move.to) }),
		);
		if (outside)
			throw new Error(
				`workspace layout upgrade record names a path outside the workspace and its configured roots: ${outside.from}`,
			);
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

	const performed: LayoutMove[] = [];
	try {
		apply(root, record, rename, performed, resumed, now());
		if (layout.version !== WORKSPACE_LAYOUT_V2) {
			persistWorkspaceLayout(root, { version: WORKSPACE_LAYOUT_V2, overrides: readWorkspaceLayoutOverrides(root) });
			syncDirectory(root);
		}
		removeRecord(root);
		return { status: "upgraded", moved: performed.length, resumed };
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		if (resumed)
			throw new Error(
				`workspace layout upgrade could not finish an interrupted run: ${cause}; ${WORKSPACE_LAYOUT_UPGRADE_FILE} lists the planned renames`,
				{ cause: error },
			);
		const stranded = rollback(root, performed, record, rename);
		if (stranded.length > 0)
			throw new Error(`workspace layout upgrade could not finish: ${cause}; could not restore ${stranded.join(", ")}`, {
				cause: error,
			});
		writeRecord(root, { version: 1, state: "blocked", reason: cause, at: now().toISOString() });
		return { status: "blocked", reason: cause };
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
