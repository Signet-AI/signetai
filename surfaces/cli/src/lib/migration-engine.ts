import { createHash } from "node:crypto";
import {
	closeSync,
	cpSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readlinkSync,
	readdirSync,
	renameSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type Layout = { version: number; root: string; destination: string };
export type Journal = {
	version: 1;
	workspaceId: string;
	phase: string;
	destinationWrites: boolean;
	rollbackEligible: boolean;
	error?: string;
	copied: string[];
};
export type MigrationPlan = {
	readOnly: true;
	bytes: number;
	components: string[];
	source: string;
	destination: string;
};
export type MigrationResult = { status: "completed"; destination: string; receipt: string };
export interface MigrationDeps {
	resolver: { resolve(): Layout; cutover?: (layout: Layout) => Promise<void> };
	writers: { drain(): Promise<{ owners: string[] }> };
	database: {
		snapshot(destination: string): Promise<{ path: string; bytes: number }>;
		verify(path: string): Promise<boolean>;
	};
	journalStateDir: string;
	hooks?: { afterCopy?: () => Promise<void>; afterCutover?: () => Promise<void> };
	lease?: { acquire(): Promise<{ release(): Promise<void> }> };
}

export class MigrationEngine {
	private readonly deps: MigrationDeps;
	private readonly journalPath: string;
	constructor(deps: MigrationDeps) {
		this.deps = deps;
		const layout = deps.resolver.resolve();
		this.journalPath = join(deps.journalStateDir, `${workspaceId(layout.root)}.json`);
	}

	async preflight(): Promise<MigrationPlan> {
		const layout = this.deps.resolver.resolve();
		if (layout.version !== 1) throw new Error(`unsupported layout version: ${layout.version}`);
		const listing = scanInventory(layout.root, layout.root);
		return {
			readOnly: true,
			bytes: listing.bytes,
			components: listing.components,
			source: layout.root,
			destination: layout.destination,
		};
	}

	async run(): Promise<MigrationResult> {
		const existing = readJournal(this.journalPath);
		const layout = this.deps.resolver.resolve();
		await this.preflight();
		if (existing?.phase === "completed")
			return { status: "completed", destination: layout.destination, receipt: this.journalPath };
		const lease = this.deps.lease ? await this.deps.lease.acquire() : undefined;
		try {
			const drained =
				existing?.phase && existing.phase !== "preflight" ? { owners: [] } : await this.deps.writers.drain();
			if (drained.owners.length) throw new Error(`migration drain blocked by: ${drained.owners.join(", ")}`);
			const journal: Journal = existing ?? {
				version: 1,
				workspaceId: workspaceId(layout.root),
				phase: "drained",
				destinationWrites: false,
				rollbackEligible: true,
				copied: [],
			};
			journal.phase = "drained";
			saveJournal(this.journalPath, journal);
			mkdirSync(layout.destination, { recursive: true });
			const copied = new Set(journal.copied);
			for (const rel of scanInventory(layout.root, layout.root, layout.destination).components) {
				if (copied.has(rel)) continue;
				copyEntry(layout.root, layout.destination, rel);
				copied.add(rel);
				journal.copied = [...copied];
				journal.phase = "copying";
				saveJournal(this.journalPath, journal);
			}
			await this.deps.hooks?.afterCopy?.();
			journal.phase = "snapshotting";
			saveJournal(this.journalPath, journal);
			const snapshot = await this.deps.database.snapshot(layout.destination);
			if (!(await this.deps.database.verify(snapshot.path))) throw new Error("database integrity verification failed");
			journal.phase = "verified";
			saveJournal(this.journalPath, journal);
			// Once the destination is verified, rollback is permanently fenced before publication.
			journal.destinationWrites = true;
			journal.rollbackEligible = false;
			journal.phase = "cutover-pending";
			saveJournal(this.journalPath, journal);
			if (this.deps.resolver.cutover) await this.deps.resolver.cutover({ ...layout, version: 2 });
			await this.deps.hooks?.afterCutover?.();
			journal.phase = "completed";
			saveJournal(this.journalPath, journal);
			return { status: "completed", destination: layout.destination, receipt: this.journalPath };
		} finally {
			await lease?.release();
		}
	}

	async resume(): Promise<MigrationResult> {
		return this.run();
	}
	async rollback(): Promise<void> {
		const journal = readJournal(this.journalPath);
		if (!journal?.rollbackEligible || journal.destinationWrites)
			throw new Error("rollback is no longer safe after destination writes");
		if (journal.phase === "completed") throw new Error("rollback is no longer safe");
		unlinkSync(this.journalPath);
	}
}

function workspaceId(root: string): string {
	return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 32);
}
function saveJournal(path: string, journal: Journal): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
	const fd = openSync(tmp, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
	const dirfd = openSync(dirname(path), "r");
	try {
		fsyncSync(dirfd);
	} finally {
		closeSync(dirfd);
	}
}
function readJournal(path: string): Journal | undefined {
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Journal) : undefined;
}
function scanInventory(root: string, base: string, destination?: string): { bytes: number; components: string[] } {
	let bytes = 0;
	const components: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const abs = join(root, entry.name);
		const rel = relative(base, abs);
		if (destination && resolve(abs) === resolve(destination)) continue;
		if (entry.name === ".git") continue;
		if (entry.isSymbolicLink()) {
			const target = resolve(root, entry.name, readlinkSync(abs));
			if (!target.startsWith(`${resolve(base)}/`)) throw new Error(`escaping symlink: ${rel}`);
			components.push(rel);
			continue;
		}
		if (entry.isDirectory()) {
			const nested = scanInventory(abs, base, destination);
			bytes += nested.bytes;
			components.push(...nested.components);
			continue;
		}
		if (!entry.isFile()) throw new Error(`unsupported special file: ${rel}`);
		bytes += lstatSync(abs).size;
		components.push(rel);
	}
	return { bytes, components };
}
function copyEntry(source: string, destination: string, rel: string): void {
	const src = join(source, rel);
	const dst = join(destination, rel);
	mkdirSync(dirname(dst), { recursive: true });
	const stat = lstatSync(src);
	if (stat.isSymbolicLink()) {
		symlinkSync(readlinkSync(src), dst);
		return;
	}
	if (!stat.isFile()) throw new Error(`unsupported special file: ${rel}`);
	cpSync(src, dst, { preserveTimestamps: true });
	if (hash(src) !== hash(dst)) throw new Error(`concurrent mutation during copy: ${rel}`);
}
function hash(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
