import { createHash } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	constants,
	fsyncSync,
	existsSync,
	fchmodSync,
	futimesSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readlinkSync,
	rmSync,
	readdirSync,
	renameSync,
	statfsSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export type Layout = { version: number; root: string; destination: string };
export type Fingerprint = {
	path: string;
	type: "file" | "symlink";
	size: number;
	mtimeMs: number;
	mode: number;
	hash: string;
};
export type Receipt = { component: string; phase: "accepted" | "verified"; fingerprint: Fingerprint };
export type Journal = {
	version: 1;
	workspaceId: string;
	source: string;
	destination: string;
	sourceIdentity: string;
	destinationIdentity: string;
	phase: "preflight" | "drained" | "copying" | "snapshotting" | "verified" | "cutover-pending" | "completed" | "failed";
	destinationWrites: boolean;
	rollbackEligible: boolean;
	copied: string[];
	receipts: Receipt[];
	fingerprints: Fingerprint[];
	requiredBytes: number;
	error?: string;
};
export type MigrationPlan = {
	readOnly: true;
	bytes: number;
	components: string[];
	source: string;
	destination: string;
	fingerprints?: Fingerprint[];
};
export type MigrationResult = { status: "completed"; destination: string; receipt: string };
export type MigrationStatus = {
	phase: string;
	rollbackEligible: boolean;
	destinationWrites: boolean;
	copied: number;
	blocked: string[];
	journal?: string;
};
export interface MigrationDeps {
	resolver: { resolve(): Layout; cutover?: (layout: Layout) => Promise<void> };
	writers: { drain(): Promise<{ owners: string[] }> };
	database: {
		snapshot(destination: string): Promise<{ path: string; bytes: number }>;
		verify(path: string): Promise<boolean>;
	};
	journalStateDir: string;
	hooks?: {
		afterCopy?: () => Promise<void>;
		afterCutover?: () => Promise<void>;
		verifyComponent?: (receipt: Receipt) => Promise<boolean>;
	};
	lease?: { acquire(): Promise<{ release(): Promise<void> }> };
}

export class MigrationEngine {
	private readonly deps: MigrationDeps;
	private readonly journalPath: string;
	constructor(deps: MigrationDeps) {
		this.deps = deps;
		const l = deps.resolver.resolve();
		this.journalPath = join(deps.journalStateDir, `${workspaceId(l.root)}.json`);
	}
	async preflight(): Promise<MigrationPlan> {
		const lease = this.deps.lease ? await this.deps.lease.acquire() : undefined;
		try {
			await this.drainWriters();
			return this.inventory(this.deps.resolver.resolve());
		} finally {
			await lease?.release();
		}
	}
	private async drainWriters(): Promise<void> {
		const d = await this.deps.writers.drain();
		if (d.owners.length) throw new Error(`migration drain blocked by: ${d.owners.join(", ")}`);
	}
	private inventory(l: Layout): MigrationPlan {
		validateLayout(l);
		const i = scanInventory(l.root, l.root, l.destination);
		ensureSpace(l.destination, i.bytes);
		return {
			readOnly: true,
			bytes: i.bytes,
			components: i.components,
			source: l.root,
			destination: l.destination,
			fingerprints: i.fingerprints,
		};
	}
	async run(): Promise<MigrationResult> {
		const l = this.deps.resolver.resolve();
		validateLayout(l);
		let j = readJournal(this.journalPath);
		if (
			j &&
			(j.workspaceId !== workspaceId(l.root) ||
				j.source !== resolve(l.root) ||
				j.destination !== resolve(l.destination))
		)
			throw new Error("journal identity mismatch");
		if (j && j.phase !== "completed" && j.sourceIdentity !== identity(l.root))
			throw new Error("source identity mismatch");
		if (j?.phase === "completed") return { status: "completed", destination: l.destination, receipt: this.journalPath };
		const lease = this.deps.lease ? await this.deps.lease.acquire() : undefined;
		try {
			await this.drainWriters();
			if (j?.phase === "cutover-pending") return this.finishCutover(l, j);
			const plan = this.inventory(l);
			j ??= {
				version: 1,
				workspaceId: workspaceId(l.root),
				source: resolve(l.root),
				destination: resolve(l.destination),
				sourceIdentity: identity(l.root),
				destinationIdentity: identity(l.destination),
				phase: "preflight",
				destinationWrites: false,
				rollbackEligible: true,
				copied: [],
				receipts: [],
				fingerprints: plan.fingerprints ?? [],
				requiredBytes: plan.bytes,
			};
			j.phase = "drained";
			saveJournal(this.journalPath, j);
			mkdirSync(l.destination, { recursive: true, mode: 0o700 });
			j.destinationIdentity = identity(l.destination);
			saveJournal(this.journalPath, j);
			const done = new Set(j.copied);
			for (const rel of plan.components) {
				if (done.has(rel)) continue;
				const r = copyEntry(l.root, l.destination, rel);
				j.receipts.push({ component: rel, phase: "accepted", fingerprint: r });
				j.copied.push(rel);
				j.phase = "copying";
				saveJournal(this.journalPath, j);
			}
			for (const r of j.receipts) {
				if (!((await this.deps.hooks?.verifyComponent?.(r)) ?? true))
					throw new Error(`semantic verification failed: ${r.component}`);
				r.phase = "verified";
			}
			await this.deps.hooks?.afterCopy?.();
			j.phase = "snapshotting";
			saveJournal(this.journalPath, j);
			const snap = await this.deps.database.snapshot(l.destination);
			if (!(await this.deps.database.verify(snap.path))) throw new Error("database integrity verification failed");
			j.phase = "verified";
			saveJournal(this.journalPath, j);
			return this.finishCutover(l, j);
		} catch (e) {
			if (j) {
				j.phase = "failed";
				j.error = e instanceof Error ? e.message : String(e);
				saveJournal(this.journalPath, j);
			}
			throw e;
		} finally {
			await lease?.release();
		}
	}

	private async finishCutover(l: Layout, j: Journal): Promise<MigrationResult> {
		if (!j.destinationWrites) {
			j.phase = "cutover-pending";
			saveJournal(this.journalPath, j);
		}
		if (this.deps.resolver.cutover) await this.deps.resolver.cutover({ ...l, version: 2 });
		j.destinationWrites = true;
		j.rollbackEligible = false;
		await this.deps.hooks?.afterCutover?.();
		j.phase = "completed";
		saveJournal(this.journalPath, j);
		return { status: "completed", destination: l.destination, receipt: this.journalPath };
	}
	async resume(): Promise<MigrationResult> {
		return this.run();
	}
	async status(): Promise<MigrationStatus> {
		const journal = readJournal(this.journalPath);
		if (!journal)
			return {
				phase: "not-started",
				rollbackEligible: false,
				destinationWrites: false,
				copied: 0,
				blocked: [],
				journal: this.journalPath,
			};
		return {
			phase: journal.phase,
			rollbackEligible: journal.rollbackEligible,
			destinationWrites: journal.destinationWrites,
			copied: journal.copied.length,
			blocked: journal.error ? [redactBlocker(journal.error)] : [],
			journal: this.journalPath,
		};
	}
	async cleanup(accepted: boolean): Promise<void> {
		if (!accepted) throw new Error("cleanup requires explicit acceptance (--accept)");
		const journal = readJournal(this.journalPath);
		if (journal?.phase !== "completed") throw new Error("cleanup requires a completed migration");
		unlinkSync(this.journalPath);
	}
	async rollback(): Promise<void> {
		const j = readJournal(this.journalPath);
		if (!j?.rollbackEligible || j.destinationWrites || j.phase === "completed")
			throw new Error("rollback is no longer safe after destination writes");
		if (existsSync(j.destination)) {
			const s = lstatSync(j.destination);
			if (
				!s.isDirectory() ||
				s.isSymbolicLink() ||
				j.destinationIdentity === "missing" ||
				identity(j.destination) !== j.destinationIdentity
			)
				throw new Error("refusing to remove unsafe migration destination");
			rmSync(j.destination, { recursive: true, force: true });
		}
		if (existsSync(this.journalPath)) unlinkSync(this.journalPath);
	}
}

function validateLayout(l: Layout) {
	if (l.version !== 1) throw new Error(`unsupported layout version: ${l.version}`);
	const source = resolve(l.root),
		destination = resolve(l.destination);
	if (source === destination) throw new Error("destination must differ from source");
	if (destination.startsWith(`${source}${sep}`)) throw new Error("destination must not be nested inside source");
	try {
		const s = lstatSync(l.destination);
		if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("destination must be a real directory");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
}

function redactBlocker(message: string): string {
	if (message.startsWith("migration drain blocked by:")) return "migration is blocked by active writers";
	if (message.includes("escaping symlink")) return "migration is blocked by an unsafe symlink";
	if (message.includes("integrity verification")) return "migration is blocked by database verification";
	return "migration failed; run status details are intentionally redacted";
}

function workspaceId(root: string): string {
	return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 32);
}
function identity(p: string) {
	if (!existsSync(p)) return "missing";
	const s = lstatSync(p);
	return `${s.dev}:${s.ino}:${s.mode}`;
}
function ensureSpace(destination: string, bytes: number) {
	try {
		const b = statfsSync(dirname(destination)).bavail * statfsSync(dirname(destination)).bsize;
		if (b < bytes) throw new Error(`insufficient disk space: need ${bytes} bytes`);
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("insufficient")) throw e;
	}
}
function saveJournal(path: string, j: Journal) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(j)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
	const d = openSync(dirname(path), "r");
	try {
		fsyncSync(d);
	} finally {
		closeSync(d);
	}
}
function readJournal(path: string): Journal | undefined {
	if (!existsSync(path)) return;
	const j = JSON.parse(readFileSync(path, "utf8")) as Journal;
	if (j.version !== 1 || !Array.isArray(j.copied) || !Array.isArray(j.receipts))
		throw new Error("invalid migration journal");
	return j;
}
function scanInventory(
	root: string,
	base: string,
	destination?: string,
): { bytes: number; components: string[]; fingerprints: Fingerprint[] } {
	let bytes = 0;
	const components: string[] = [],
		fingerprints: Fingerprint[] = [];
	for (const e of readdirSync(root, { withFileTypes: true })) {
		if (e.name === ".git") continue;
		const abs = join(root, e.name),
			rel = relative(base, abs);
		if (destination && resolve(abs) === resolve(destination)) continue;
		const s = lstatSync(abs);
		if (e.isSymbolicLink()) {
			const target = readlinkSync(abs);
			const resolved = resolve(root, target);
			if (!(resolved === resolve(base) || resolved.startsWith(`${resolve(base)}${sep}`)))
				throw new Error(`escaping symlink: ${rel}`);
			const f = fingerprint(abs, "symlink");
			components.push(rel);
			fingerprints.push({ ...f, path: rel });
			continue;
		}
		if (e.isDirectory()) {
			const n = scanInventory(abs, base, destination);
			bytes += n.bytes;
			components.push(...n.components);
			fingerprints.push(...n.fingerprints);
			continue;
		}
		if (!e.isFile()) throw new Error(`unsupported special file: ${rel}`);
		bytes += s.size;
		components.push(rel);
		fingerprints.push({ ...fingerprint(abs, "file"), path: rel });
	}
	return { bytes, components, fingerprints };
}
function fingerprint(p: string, type: "file" | "symlink"): Fingerprint {
	const s = lstatSync(p);
	if (type === "file" && s.nlink > 1) throw new Error(`unsupported hardlink: ${p}`);
	const h = type === "symlink" ? readlinkSync(p) : readFileSync(p);
	return {
		path: p,
		type,
		size: s.size,
		mtimeMs: s.mtimeMs,
		mode: s.mode,
		hash: createHash("sha256").update(h).digest("hex"),
	};
}
function assertSafeParent(root: string, rel: string): void {
	let current = resolve(root);
	for (const part of relative(resolve(root), resolve(root, dirname(rel)))
		.split(sep)
		.filter(Boolean)) {
		current = join(current, part);
		const s = lstatSync(current);
		if (!s.isDirectory() || s.isSymbolicLink()) throw new Error(`unsafe destination parent: ${rel}`);
	}
}
function copyEntry(source: string, destination: string, rel: string): Fingerprint {
	const src = join(source, rel),
		dst = join(destination, rel);
	assertSafeParent(destination, rel);
	const before = lstatSync(src);
	const f = fingerprint(src, before.isSymbolicLink() ? "symlink" : "file");
	const destinationExists = (() => {
		try {
			lstatSync(dst);
			return true;
		} catch {
			return false;
		}
	})();
	if (destinationExists) throw new Error(`destination already exists: ${rel}`);
	if (f.type === "symlink") {
		const target = readlinkSync(src);
		const targetPath = resolve(dirname(src), target);
		if (!(targetPath === resolve(source) || targetPath.startsWith(`${resolve(source)}${sep}`)))
			throw new Error(`escaping symlink: ${rel}`);
		symlinkSync(target, dst);
		if (readlinkSync(src) !== target || readlinkSync(dst) !== target)
			throw new Error(`concurrent mutation during copy: ${rel}`);
		return { ...f, path: rel };
	}
	const fd = openSync(
		dst,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
		f.mode & 0o777,
	);
	try {
		copyFileSync(src, dst);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const out = lstatSync(dst);
	const modeFd = openSync(dst, constants.O_WRONLY | constants.O_NOFOLLOW);
	try {
		fchmodSync(modeFd, f.mode & 0o777);
		futimesSync(modeFd, f.mtimeMs / 1000, f.mtimeMs / 1000);
	} finally {
		closeSync(modeFd);
	}
	const after = lstatSync(src);
	if (
		!after.isFile() ||
		after.size !== f.size ||
		after.mtimeMs !== f.mtimeMs ||
		fingerprint(src, "file").hash !== fingerprint(dst, "file").hash ||
		out.size !== f.size
	)
		throw new Error(`concurrent mutation during copy: ${rel}`);
	return { ...f, path: rel };
}
