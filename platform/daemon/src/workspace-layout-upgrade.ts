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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
const TRANSCRIPT_FILE = /^transcript\.jsonl(?:\.(?:lock|snapshot-tmp|rewrite-tmp))?$/;
const DATABASE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const LEGACY_DIRECTORIES: ReadonlySet<string> = new Set(["backups", "cache", "imports"]);
const LEGACY_TEMPLATE_FILES: ReadonlySet<string> = new Set(["requirements.txt", "requirements-base.txt"]);
const LEGACY_TEMPLATE_DIRECTORIES: Readonly<Record<string, readonly string[]>> = {
	scripts: ["memory.py"],
	tests: ["test_cli_like_escaping.py", "test_signetai_like_escaping.py"],
};

type MoveIdentity = {
	readonly device: string;
	readonly inode: string;
	readonly birthtimeNs?: string;
	readonly kind: "directory" | "file" | "other" | "symlink";
};

export type LayoutMove = { readonly from: string; readonly to: string; readonly identity?: MoveIdentity };

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
	| {
			readonly status: "upgraded";
			readonly moved: number;
			readonly resumed: boolean;
			readonly cleanup?: string;
	  }
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
	const record = {
		version: 1 as const,
		state,
		startedAt,
		moves,
		createdDirectories: created,
		emptiedDirectories: emptied,
	};
	validateRecordPaths(root, record);
	return record;
}

function isRecordPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		(isAbsolute(value) || (value !== ".." && !value.startsWith(`..${sep}`) && !value.startsWith("../")))
	);
}

function isMove(value: unknown): value is LayoutMove {
	const identity = value && typeof value === "object" ? Reflect.get(value, "identity") : undefined;
	return (
		!!value &&
		typeof value === "object" &&
		isRecordPath(Reflect.get(value, "from")) &&
		isRecordPath(Reflect.get(value, "to")) &&
		(identity === undefined || isMoveIdentity(identity))
	);
}

function isMoveIdentity(value: unknown): value is MoveIdentity {
	if (!value || typeof value !== "object") return false;
	const device = Reflect.get(value, "device");
	const inode = Reflect.get(value, "inode");
	const birthtimeNs = Reflect.get(value, "birthtimeNs");
	const kind = Reflect.get(value, "kind");
	return (
		typeof device === "string" &&
		typeof inode === "string" &&
		(birthtimeNs === undefined || typeof birthtimeNs === "string") &&
		(kind === "directory" || kind === "file" || kind === "other" || kind === "symlink")
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

function moveIdentity(path: string): MoveIdentity {
	const stat = lstatSync(path, { bigint: true });
	const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other";
	return { device: stat.dev.toString(), inode: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString(), kind };
}

function hasDurableMoveIdentity(
	identity: MoveIdentity | undefined,
): identity is MoveIdentity & { readonly birthtimeNs: string } {
	return (
		identity !== undefined &&
		identity.inode !== "0" &&
		identity.birthtimeNs !== undefined &&
		identity.birthtimeNs !== "0"
	);
}

function matchesMoveIdentity(path: string, expected: MoveIdentity & { readonly birthtimeNs: string }): boolean {
	const actual = moveIdentity(path);
	return (
		actual.inode === expected.inode && actual.birthtimeNs === expected.birthtimeNs && actual.kind === expected.kind
	);
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

function isSignetLegacyData(database: string, path: string): boolean {
	const name = basename(path);
	const databaseName = basename(database);
	if (
		dirname(database) === dirname(path) &&
		(DATABASE_SUFFIXES.some((suffix) => name === databaseName + suffix) || name.startsWith(`${databaseName}.bak`))
	)
		return true;
	if (name.startsWith(".canonical-transcript-backfill-")) return true;
	const existing = entry(path);
	if (!existing || existing.isSymbolicLink()) return false;
	if (LEGACY_TEMPLATE_FILES.has(name)) return existing.isFile();
	if (LEGACY_DIRECTORIES.has(name)) return existing.isDirectory();
	const markers = LEGACY_TEMPLATE_DIRECTORIES[name] ?? [];
	return existing.isDirectory() && markers.some((marker) => entry(join(path, marker))?.isFile() === true);
}

function remainingLegacySources(root: string, includeRuntime: boolean): string[] {
	const v1 = resolveWorkspaceLayoutAs(root, WORKSPACE_LAYOUT_V1);
	const v2 = resolveWorkspaceLayoutAs(root, WORKSPACE_LAYOUT_V2);
	const pairs: [string, string][] = [
		...DATABASE_SUFFIXES.map((suffix): [string, string] => [v1.database + suffix, v2.database + suffix]),
		[v1.cache, v2.cache],
		[v1.imports, v2.imports],
		...(includeRuntime && !holdsOnlyInstanceLock(v1.runtime) ? [[v1.runtime, v2.runtime] as [string, string]] : []),
	];
	return pairs
		.filter(([from, to]) => from !== to && entry(from) !== null)
		.map(([from]) => (inside(root, from) ? relative(root, from) : from));
}

function holdsOnlyInstanceLock(path: string): boolean {
	const existing = entry(path);
	return (
		!!existing?.isDirectory() && !existing.isSymbolicLink() && readdirSync(path).every((name) => name === "daemon.lock")
	);
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

function validateRecordPaths(root: string, record: InProgressRecord): void {
	const bases = upgradeBases(root);
	const outside = record.moves.find(
		(move) => !baseFor(bases, { from: resolve(root, move.from), to: resolve(root, move.to) }),
	);
	const outsideDirectory = [...record.createdDirectories, ...record.emptiedDirectories].find(
		(path) => !bases.some((base) => inside(base, resolve(root, path))),
	);
	if (outside || outsideDirectory)
		throw new Error(
			`workspace layout upgrade record names a path outside the workspace and its configured roots: ${outside?.from ?? outsideDirectory}`,
		);
	const v1 = resolveWorkspaceLayoutAs(root, WORKSPACE_LAYOUT_V1);
	const v2 = resolveWorkspaceLayoutAs(root, WORKSPACE_LAYOUT_V2);
	const storage = (layout: WorkspaceLayout): string[] => [
		layout.data,
		layout.transcripts,
		layout.runtime,
		layout.cache,
		layout.imports,
		...DATABASE_SUFFIXES.map((suffix) => layout.database + suffix),
	];
	const owned = (roots: readonly string[], path: string): boolean =>
		roots.some((candidate) => containsOrEquals(candidate, resolve(root, path)));
	const unplanned = record.moves.find((move) => !owned(storage(v1), move.from) || !owned(storage(v2), move.to));
	if (unplanned)
		throw new Error(
			`workspace layout upgrade record moves ${unplanned.from} to ${unplanned.to}, outside Signet's v1 and v2 storage`,
		);
}

function plan(root: string): { moves: LayoutMove[]; created: string[]; emptied: string[] } {
	const v1 = resolveWorkspaceLayoutAs(root, WORKSPACE_LAYOUT_V1);
	const v2 = resolveWorkspaceLayoutAs(root, WORKSPACE_LAYOUT_V2);
	const moves: LayoutMove[] = [];
	const emptied: string[] = [];
	const add = (from: string, to: string): void => {
		if (from === to || !entry(from)) return;
		moves.push({ from, to, identity: moveIdentity(from) });
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
				if (TRANSCRIPT_FILE.test(name)) add(join(nested, name), join(v2.transcripts, harness, name));
			emptied.push(nested, join(v1.transcripts, harness));
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
			if (claimed.has(from) || retained.some((path) => containsOrEquals(from, path) || containsOrEquals(path, from)))
				continue;
			if (isSignetLegacyData(v1.database, from)) add(from, join(legacy, name));
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
		moves: moves.map((move) => ({ ...move, from: stored(move.from), to: stored(move.to) })),
		created: [...created].map(stored),
		emptied: emptied.map(stored),
	};
}

function assertNoSymlinkAncestors(base: string, path: string): void {
	let parent = dirname(path);
	while (parent !== base && inside(base, parent)) {
		if (entry(parent)?.isSymbolicLink())
			throw new UpgradeBlocked(`${parent} is a symlink; Signet will not move files through it`);
		parent = dirname(parent);
	}
}

function mergeRecreatedRuntime(from: string, to: string, now: Date, rename: (from: string, to: string) => void): void {
	for (const name of readdirSync(from)) {
		const source = join(from, name);
		const target = join(to, name);
		const sourceEntry = lstatSync(source);
		const targetEntry = entry(target);
		if (name === "daemon.lock" && sourceEntry.isFile()) {
			unlinkSync(source);
			continue;
		}
		if (targetEntry?.isDirectory() && !targetEntry.isSymbolicLink() && sourceEntry.isDirectory()) {
			mergeRecreatedRuntime(source, target, now, rename);
			continue;
		}
		if (targetEntry) {
			const aside = `${target}.before-${now.getTime()}`;
			if (entry(aside)) throw new UpgradeBlocked(`${aside} already exists`);
			rename(target, aside);
		}
		rename(source, target);
	}
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
		if (!source) {
			const target = entry(to);
			if (resumed && target) {
				const identity = move.identity;
				if (!hasDurableMoveIdentity(identity))
					throw new UpgradeBlocked(`cannot verify moved item at ${move.to}: upgrade record lacks a durable identity`);
				if (matchesMoveIdentity(to, identity)) continue;
				throw new UpgradeBlocked(`moved item at ${move.to} does not match its recorded identity`);
			}
			throw new UpgradeBlocked(`neither ${move.from} nor ${move.to} exists`);
		}
		const target = entry(to);
		if (target) {
			if (resumed && from === runtime && source.isDirectory() && target.isDirectory() && !target.isSymbolicLink()) {
				const identity = move.identity;
				if (!hasDurableMoveIdentity(identity))
					throw new UpgradeBlocked(`cannot verify moved item at ${move.to}: upgrade record lacks a durable identity`);
				if (!matchesMoveIdentity(to, identity))
					throw new UpgradeBlocked(`moved item at ${move.to} does not match its recorded identity`);
				mergeRecreatedRuntime(from, to, now, rename);
				continue;
			}
			if (!source.isDirectory() || !isEmptyDirectory(to)) throw new UpgradeBlocked(`${move.to} already exists`);
			rmdirSync(to);
		}
		if (inside(root, from)) assertNoSymlinkAncestors(root, from);
		if (inside(root, to)) assertNoSymlinkAncestors(root, to);
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
		rename(from, to);
		performed.push(move);
	}
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

function committed(root: string): boolean {
	try {
		return resolveWorkspaceLayout(root).version === WORKSPACE_LAYOUT_V2;
	} catch {
		return false;
	}
}

export function upgradeWorkspaceLayout(
	rootPath: string,
	deps: WorkspaceLayoutUpgradeDeps = {},
): WorkspaceLayoutUpgradeResult {
	const root = resolve(rootPath);
	const rename = deps.rename ?? ((from: string, to: string) => renameSync(from, to));
	const now = deps.now ?? (() => new Date());
	const existing = readWorkspaceLayoutUpgradeRecord(root);
	const layout: WorkspaceLayout = resolveWorkspaceLayout(root);
	if (layout.version === WORKSPACE_LAYOUT_V2) {
		if (existing?.state !== "in-progress") {
			if (existing) removeRecord(root);
			return { status: "current" };
		}
		const remaining = remainingLegacySources(root, false);
		if (remaining.length > 0)
			throw new Error(
				`workspace layout v2 is recorded, but an interrupted upgrade left v1 paths behind: ${remaining.join(", ")}; ${WORKSPACE_LAYOUT_UPGRADE_FILE} lists the planned renames`,
			);
		return finish(root, existing, 0, true);
	}

	let record: InProgressRecord;
	const resumed = existing?.state === "in-progress";
	if (existing?.state === "in-progress") {
		record = existing;
	} else {
		try {
			const planned = planOrBlock(root);
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
	const fail = (error: unknown): WorkspaceLayoutUpgradeResult => {
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
	};
	try {
		apply(root, record, rename, performed, resumed, now());
		const remaining = remainingLegacySources(root, true);
		if (remaining.length > 0)
			throw new UpgradeBlocked(`v1 paths remain after the planned renames: ${remaining.join(", ")}`);
	} catch (error) {
		return fail(error);
	}
	try {
		persistWorkspaceLayout(root, { version: WORKSPACE_LAYOUT_V2, overrides: readWorkspaceLayoutOverrides(root) });
	} catch (error) {
		if (!committed(root)) return fail(error);
	}
	return finish(root, record, performed.length, resumed);
}

function planOrBlock(root: string): ReturnType<typeof plan> {
	try {
		return plan(root);
	} catch (error) {
		if (error instanceof UpgradeBlocked) throw error;
		throw new UpgradeBlocked(
			`could not inspect the v1 workspace: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function finish(root: string, record: InProgressRecord, moved: number, resumed: boolean): WorkspaceLayoutUpgradeResult {
	for (const directory of record.emptiedDirectories) removeIfEmpty(resolve(root, directory));
	try {
		syncDirectory(root);
		removeRecord(root);
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		return {
			status: "upgraded",
			moved,
			resumed,
			cleanup: `could not remove ${WORKSPACE_LAYOUT_UPGRADE_FILE}: ${cause}; the next start finishes it`,
		};
	}
	return { status: "upgraded", moved, resumed };
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
