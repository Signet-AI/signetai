import { createHash } from "node:crypto";
import { lstatSync, statfsSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { type DescriptorEntry, type DescriptorRoot, openDescriptorRoot, UnsafeDescriptorPathError } from "@signet/core";

export type Layout = { version: number; root: string; destination: string };
export type Fingerprint = {
	path: string;
	destinationPath?: string;
	type: "file" | "symlink";
	size: number;
	mtimeMs: number;
	mode: number;
	hash: string;
};
export type Receipt = { component: string; phase: "accepted" | "verified"; fingerprint: Fingerprint };
export type DatabaseSnapshot = {
	sourceRoot: string;
	sourcePath: string;
	destinationPath: string;
	bytes: number;
	hash: string;
};
export type Journal = {
	version: 1;
	workspaceId: string;
	source: string;
	destination: string;
	sourceIdentity: string;
	destinationParentIdentity: string;
	destinationIdentity: string;
	phase: "preflight" | "drained" | "copying" | "snapshotting" | "verified" | "cutover-pending" | "completed" | "failed";
	destinationWrites: boolean;
	rollbackEligible: boolean;
	copied: string[];
	receipts: Receipt[];
	fingerprints: Fingerprint[];
	requiredBytes: number;
	error?: string;
	databaseSnapshot?: DatabaseSnapshot | null;
	cutoverPreimage?: string | null;
	pointerPublished?: boolean;
	destinationVerified?: boolean;
};
export type MigrationPlan = {
	readOnly: true;
	bytes: number;
	components: string[];
	source: string;
	destination: string;
	fingerprints?: Fingerprint[];
	hardlinks?: string[][];
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
	resolver: {
		resolve(): Layout;
		capture?: () => Promise<string | undefined>;
		current?: () => Promise<string | undefined>;
		cutover?: (layout: Layout) => Promise<void>;
		verifyDestination?: (layout: Layout) => Promise<void>;
	};
	writers: { drain(): Promise<{ owners: string[] }> };
	database: {
		inspect?: () => Promise<void>;
		prepare(): Promise<{ sourceRoot: string; sourcePath: string; destinationPath: string; bytes: number } | undefined>;
		verifySnapshot?: (sourceDatabase: string, destinationDatabase: string) => Promise<void>;
	};
	layoutBytes?: (layout: Layout) => Uint8Array;
	gitignoreBytes?: (existing: string) => Uint8Array;
	mapDestinationPath?: (sourcePath: string, type: "file" | "symlink") => string | undefined;
	journalStateDir: string;
	hooks?: {
		afterCopy?: () => Promise<void>;
		afterEntryCopy?: () => Promise<void>;
		afterCutover?: () => Promise<void>;
		afterPointerPublished?: () => Promise<void>;
		afterDestinationAdmitted?: () => Promise<void>;
		verifyComponent?: (receipt: Receipt) => Promise<boolean>;
	};
	lease?: { acquire(): Promise<{ release(): Promise<void> }> };
}

type AdmittedDestination = {
	readonly parent: DescriptorRoot;
	readonly root: DescriptorRoot;
	readonly parentIdentity: string;
	readonly identity: string;
};

export class MigrationEngine {
	private readonly deps: MigrationDeps;
	private readonly journalName: string;
	private readonly journalPath: string;

	constructor(deps: MigrationDeps) {
		this.deps = deps;
		const layout = deps.resolver.resolve();
		this.journalName = `${workspaceId(layout.root)}.json`;
		this.journalPath = join(deps.journalStateDir, this.journalName);
	}

	async preflight(): Promise<MigrationPlan> {
		const layout = this.deps.resolver.resolve();
		validateLayout(layout);
		await this.deps.database.inspect?.();
		const source = await openDescriptorRoot(layout.root);
		try {
			return await inventory(layout, source, this.deps.journalStateDir, this.deps.mapDestinationPath);
		} finally {
			await source.close();
		}
	}

	private async drainWriters(): Promise<void> {
		const drained = await this.deps.writers.drain();
		if (drained.owners.length) throw new Error(`migration drain blocked by: ${drained.owners.join(", ")}`);
	}

	async run(): Promise<MigrationResult> {
		const layout = this.deps.resolver.resolve();
		validateLayout(layout);
		const lease = this.deps.lease ? await this.deps.lease.acquire() : undefined;
		const state = await openOrCreateRoot(this.deps.journalStateDir);
		const source = await openDescriptorRoot(layout.root);
		let destination: AdmittedDestination | undefined;
		let journal = await readJournal(state, this.journalName);
		try {
			validateJournalIdentity(journal, layout);
			const sourceIdentity = await source.identity();
			if (journal && journal.phase !== "completed" && journal.sourceIdentity !== sourceIdentity)
				throw new Error("source identity mismatch");
			if (journal?.phase === "completed") {
				await this.verifyPublishedDestination(layout, journal);
				return { status: "completed", destination: layout.destination, receipt: this.journalPath };
			}
			if (journal?.phase === "cutover-pending") {
				const current = await this.deps.resolver.current?.();
				if (journal.pointerPublished || current === layout.destination) {
					await this.finishCutover(layout, journal, state);
					return { status: "completed", destination: layout.destination, receipt: this.journalPath };
				}
			}
			await this.drainWriters();
			const plan = await inventory(layout, source, this.deps.journalStateDir, this.deps.mapDestinationPath);
			if (journal) await verifyJournalSources(source, journal);
			if (journal && !sameSourceInventory(plan.fingerprints ?? [], journal.fingerprints))
				throw new Error("source inventory changed during migration");
			journal ??= {
				version: 1,
				workspaceId: workspaceId(layout.root),
				source: resolve(layout.root),
				destination: resolve(layout.destination),
				sourceIdentity,
				destinationParentIdentity: "missing",
				destinationIdentity: "missing",
				phase: "preflight",
				destinationWrites: false,
				rollbackEligible: true,
				copied: [],
				receipts: [],
				fingerprints: plan.fingerprints ?? [],
				requiredBytes: plan.bytes,
			};
			journal.phase = "drained";
			await saveJournal(state, this.journalName, journal);
			destination = await admitDestination(layout.destination);
			if (journal.destinationIdentity !== "missing" && journal.destinationIdentity !== destination.identity)
				throw new Error("destination identity mismatch");
			if (
				journal.destinationParentIdentity !== "missing" &&
				journal.destinationParentIdentity !== destination.parentIdentity
			)
				throw new Error("destination parent identity mismatch");
			journal.destinationIdentity = destination.identity;
			journal.destinationParentIdentity = destination.parentIdentity;
			await saveJournal(state, this.journalName, journal);
			await this.deps.hooks?.afterDestinationAdmitted?.();

			const expected = new Map((plan.fingerprints ?? []).map((fingerprint) => [fingerprint.path, fingerprint]));
			const copied = new Set(journal.copied);
			for (const component of plan.components) {
				const fingerprint = expected.get(component);
				if (!fingerprint) throw new Error(`missing source fingerprint: ${component}`);
				if (!copied.has(component)) {
					await copyEntry(source, destination.root, fingerprint);
					await this.deps.hooks?.afterEntryCopy?.();
					journal.receipts.push({ component, phase: "accepted", fingerprint });
					journal.copied.push(component);
					journal.phase = "copying";
					journal.destinationWrites = true;
					await saveJournal(state, this.journalName, journal);
				} else await verifyDestinationEntry(destination.root, fingerprint);
			}
			await verifyJournalSources(source, journal);
			for (const receipt of journal.receipts) {
				if (!((await this.deps.hooks?.verifyComponent?.(receipt)) ?? true))
					throw new Error(`semantic verification failed: ${receipt.component}`);
				receipt.phase = "verified";
			}
			await this.deps.hooks?.afterCopy?.();
			journal.phase = "snapshotting";
			await saveJournal(state, this.journalName, journal);
			const prepared = await this.deps.database.prepare();
			if (journal.databaseSnapshot === undefined) {
				if (!prepared) {
					journal.databaseSnapshot = null;
				} else {
					const sourceRoot = await openDescriptorRoot(prepared.sourceRoot);
					try {
						journal.databaseSnapshot = {
							...prepared,
							hash: await sourceRoot.hashFile(prepared.sourcePath),
						};
					} finally {
						await sourceRoot.close();
					}
				}
				await saveJournal(state, this.journalName, journal);
			}
			const snapshot = journal.databaseSnapshot;
			if (snapshot && !prepared) throw new Error("database snapshot source changed or disappeared");
			if (!snapshot && prepared) throw new Error("database source appeared during migration");
			if (snapshot && prepared) {
				if (
					resolve(snapshot.sourceRoot) !== resolve(prepared.sourceRoot) ||
					snapshot.sourcePath !== prepared.sourcePath ||
					snapshot.destinationPath !== prepared.destinationPath
				)
					throw new Error("database snapshot source changed or disappeared");
				const snapshotSource = await openDescriptorRoot(snapshot.sourceRoot);
				try {
					const sourceHash = await snapshotSource.hashFile(snapshot.sourcePath);
					if (sourceHash !== snapshot.hash) throw new Error("database snapshot source changed or disappeared");
					const existing = (await destination.root.inventory()).find(
						(entry) => entry.path === snapshot.destinationPath,
					);
					if (existing) {
						if (existing.type !== "file" || (await destination.root.hashFile(snapshot.destinationPath)) !== sourceHash)
							throw new Error("destination database snapshot conflicts with source");
					} else {
						await destination.root.copyFileFrom(snapshotSource, snapshot.sourcePath, {}, snapshot.destinationPath);
					}
					if ((await destination.root.hashFile(snapshot.destinationPath)) !== sourceHash)
						throw new Error("database integrity verification failed");
					if (!this.deps.database.verifySnapshot) throw new Error("semantic database verifier is not configured");
					await this.deps.database.verifySnapshot(
						join(snapshot.sourceRoot, snapshot.sourcePath),
						join(layout.destination, snapshot.destinationPath),
					);
					if ((await destination.root.hashFile(snapshot.destinationPath)) !== sourceHash)
						throw new Error("destination database changed during semantic verification");
				} finally {
					await snapshotSource.close();
				}
				journal.destinationWrites = true;
				await saveJournal(state, this.journalName, journal);
			}
			if (this.deps.gitignoreBytes) {
				let existing = "";
				try {
					existing = new TextDecoder().decode(await destination.root.readFile(".gitignore"));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				const merged = this.deps.gitignoreBytes(existing);
				if (new TextDecoder().decode(merged) !== existing)
					await destination.root.replaceFileAtomic(".gitignore", merged, { mode: 0o644 });
				journal.destinationWrites = true;
				await saveJournal(state, this.journalName, journal);
			}
			if (this.deps.layoutBytes) {
				await destination.root.replaceFileAtomic("workspace-layout.json", this.deps.layoutBytes(layout), {
					mode: 0o600,
				});
				journal.destinationWrites = true;
				await saveJournal(state, this.journalName, journal);
			}
			journal.phase = "verified";
			await saveJournal(state, this.journalName, journal);
			await assertPathIdentity(layout.destination, journal.destinationIdentity);
			return await this.finishCutover(layout, journal, state);
		} catch (error) {
			if (journal) {
				if (journal.phase !== "verified" && journal.phase !== "cutover-pending") journal.phase = "failed";
				journal.error = error instanceof Error ? error.message : String(error);
				await saveJournal(state, this.journalName, journal);
			}
			throw error;
		} finally {
			await destination?.root.close();
			await destination?.parent.close();
			await source.close();
			await state.close();
			await lease?.release();
		}
	}

	private async verifyPublishedDestination(layout: Layout, journal: Journal): Promise<void> {
		if (!journal.pointerPublished) throw new Error("completed migration journal has no published pointer");
		await assertPathIdentity(layout.destination, journal.destinationIdentity);
		await this.deps.resolver.verifyDestination?.({ ...layout, version: 2 });
		journal.destinationVerified = true;
	}

	private async finishCutover(layout: Layout, journal: Journal, state: DescriptorRoot): Promise<MigrationResult> {
		await assertPathIdentity(layout.destination, journal.destinationIdentity);
		if (journal.cutoverPreimage === undefined) journal.cutoverPreimage = (await this.deps.resolver.capture?.()) ?? null;
		journal.phase = "cutover-pending";
		journal.rollbackEligible = false;
		await saveJournal(state, this.journalName, journal);
		const current = await this.deps.resolver.current?.();
		const expectedPreimage = journal.cutoverPreimage ?? layout.root;
		if (current !== undefined && current !== layout.destination && current !== expectedPreimage)
			throw new Error("workspace pointer changed during migration cutover");
		if (current !== layout.destination) {
			if (this.deps.resolver.cutover) await this.deps.resolver.cutover({ ...layout, version: 2 });
			journal.pointerPublished = true;
			await saveJournal(state, this.journalName, journal);
			await this.deps.hooks?.afterPointerPublished?.();
		} else if (!journal.pointerPublished) {
			journal.pointerPublished = true;
			await saveJournal(state, this.journalName, journal);
		}
		try {
			await this.deps.resolver.verifyDestination?.({ ...layout, version: 2 });
			journal.destinationVerified = true;
		} catch (error) {
			journal.destinationVerified = false;
			journal.phase = "cutover-pending";
			journal.error = error instanceof Error ? error.message : String(error);
			await saveJournal(state, this.journalName, journal);
			throw error;
		}
		await this.deps.hooks?.afterCutover?.();
		journal.phase = "completed";
		journal.error = undefined;
		await saveJournal(state, this.journalName, journal);
		return { status: "completed", destination: layout.destination, receipt: this.journalPath };
	}

	async resume(): Promise<MigrationResult> {
		return this.run();
	}

	async status(): Promise<MigrationStatus> {
		const state = await openExistingRoot(this.deps.journalStateDir);
		if (!state)
			return {
				phase: "not-started",
				rollbackEligible: false,
				destinationWrites: false,
				copied: 0,
				blocked: [],
				journal: this.journalPath,
			};
		try {
			const journal = await readJournal(state, this.journalName);
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
		} finally {
			await state.close();
		}
	}

	async cleanup(accepted: boolean): Promise<void> {
		if (!accepted) throw new Error("cleanup requires explicit acceptance (--accept)");
		const state = await openDescriptorRoot(this.deps.journalStateDir);
		try {
			const journal = await readJournal(state, this.journalName);
			if (journal?.phase !== "completed") throw new Error("cleanup requires a completed migration");
			await assertPathIdentity(journal.destination, journal.destinationIdentity);
			const destination = await openDescriptorRoot(journal.destination);
			try {
				await destination.writeFileAtomic(
					".signet-migration-receipt.json",
					Buffer.from(
						`${JSON.stringify(
							{
								version: 1,
								workspaceId: journal.workspaceId,
								phase: journal.phase,
								sourceVersion: 1,
								destinationVersion: 2,
								rollbackBoundary: "cutover-published",
								components: journal.receipts.map((receipt) => ({
									component: receipt.component,
									verified: receipt.phase === "verified",
								})),
							},
							null,
							2,
						)}\n`,
					),
					{ mode: 0o600 },
				);
			} finally {
				await destination.close();
			}
			await state.remove(this.journalName);
		} finally {
			await state.close();
		}
	}

	async rollback(): Promise<void> {
		const state = await openExistingRoot(this.deps.journalStateDir);
		if (!state) return;
		try {
			const journal = await readJournal(state, this.journalName);
			if (!journal) return;
			if (!journal.rollbackEligible || journal.phase === "completed")
				throw new Error("rollback is no longer safe after cutover begins");
			const parent = await openDescriptorRoot(dirname(journal.destination));
			try {
				if ((await parent.identity()) !== journal.destinationParentIdentity)
					throw new Error("refusing to remove unsafe migration destination parent");
				const destination = await parent.openDirectory(basename(journal.destination));
				try {
					if ((await destination.identity()) !== journal.destinationIdentity)
						throw new Error("refusing to remove unsafe migration destination");
				} finally {
					await destination.close();
				}
				await parent.remove(basename(journal.destination), { recursive: true });
			} finally {
				await parent.close();
			}
			await state.remove(this.journalName);
		} finally {
			await state.close();
		}
	}
}

async function openOrCreateRoot(path: string): Promise<DescriptorRoot> {
	const parent = await openDescriptorRoot(dirname(path));
	try {
		await parent.createDirectory(basename(path), 0o700);
		return await parent.openDirectory(basename(path));
	} finally {
		await parent.close();
	}
}

async function openExistingRoot(path: string): Promise<DescriptorRoot | undefined> {
	try {
		return await openDescriptorRoot(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

async function admitDestination(path: string): Promise<AdmittedDestination> {
	const parent = await openDescriptorRoot(dirname(path));
	try {
		const parentIdentity = await parent.identity();
		await parent.createDirectory(basename(path), 0o700);
		const root = await parent.openDirectory(basename(path));
		return { parent, root, parentIdentity, identity: await root.identity() };
	} catch (error) {
		await parent.close();
		throw error;
	}
}

async function inventory(
	layout: Layout,
	source: DescriptorRoot,
	journalStateDir: string,
	mapDestinationPath?: (sourcePath: string, type: "file" | "symlink") => string | undefined,
): Promise<MigrationPlan> {
	const stateRelative = contained(layout.root, journalStateDir)
		? relative(resolve(layout.root), resolve(journalStateDir))
		: undefined;
	const entries = (await source.inventory()).filter(
		(entry) => !stateRelative || (entry.path !== stateRelative && !entry.path.startsWith(`${stateRelative}${sep}`)),
	);
	const fingerprints: Fingerprint[] = [];
	const hardlinkPaths = new Map<string, string[]>();
	let bytes = 0;
	for (const entry of entries) {
		if (entry.type === "directory") continue;
		const mappedPath = mapDestinationPath?.(entry.path, entry.type);
		if (mapDestinationPath && mappedPath === undefined) continue;
		const destinationPath = mappedPath ?? entry.path;
		if (entry.type === "file" && entry.nlink > 1) {
			const key = `${entry.dev}:${entry.ino}`;
			const paths = hardlinkPaths.get(key) ?? [];
			paths.push(entry.path);
			hardlinkPaths.set(key, paths);
		}
		if (entry.type === "symlink") validateSymlink(layout.root, entry);
		const fingerprint = { ...(await fingerprintEntry(source, entry)), destinationPath };
		fingerprints.push(fingerprint);
		bytes += entry.type === "file" ? entry.size : 0;
	}
	ensureSpace(layout.destination, bytes);
	return {
		readOnly: true,
		bytes,
		components: fingerprints.map((fingerprint) => fingerprint.path),
		source: layout.root,
		destination: layout.destination,
		fingerprints,
		hardlinks: [...hardlinkPaths.values()].filter((paths) => paths.length > 1).map((paths) => paths.sort()),
	};
}

function validateSymlink(root: string, entry: DescriptorEntry): void {
	const target = entry.target ?? "";
	const resolved = resolve(root, dirname(entry.path), target);
	if (!contained(root, resolved)) throw new Error(`escaping symlink: ${entry.path}`);
}

async function fingerprintEntry(root: DescriptorRoot, entry: DescriptorEntry): Promise<Fingerprint> {
	if (entry.type === "directory") throw new Error(`cannot fingerprint directory: ${entry.path}`);
	const bytes = entry.type === "symlink" ? Buffer.from(entry.target ?? "") : await root.readFile(entry.path);
	return {
		path: entry.path,
		type: entry.type,
		size: entry.size,
		mtimeMs: entry.mtimeMs,
		mode: entry.mode,
		hash: createHash("sha256").update(bytes).digest("hex"),
	};
}

async function readFingerprint(root: DescriptorRoot, expected: Fingerprint): Promise<Fingerprint> {
	const entry = (await root.inventory()).find((candidate) => candidate.path === expected.path);
	if (!entry || entry.type === "directory") throw new Error(`missing migration entry: ${expected.path}`);
	return fingerprintEntry(root, entry);
}

function sameSourceInventory(actual: Fingerprint[], expected: Fingerprint[]): boolean {
	if (actual.length !== expected.length) return false;
	const byPath = new Map(expected.map((fingerprint) => [fingerprint.path, fingerprint]));
	return actual.every((fingerprint) => {
		const prior = byPath.get(fingerprint.path);
		return (
			prior !== undefined &&
			prior.type === fingerprint.type &&
			prior.hash === fingerprint.hash &&
			prior.size === fingerprint.size &&
			prior.mode === fingerprint.mode
		);
	});
}

async function verifyJournalSources(source: DescriptorRoot, journal: Journal): Promise<void> {
	for (const expected of journal.fingerprints) {
		const actual = await readFingerprint(source, expected);
		if (
			actual.type !== expected.type ||
			actual.hash !== expected.hash ||
			actual.size !== expected.size ||
			actual.mode !== expected.mode
		)
			throw new Error(`source changed during migration: ${expected.path}`);
	}
}

async function copyEntry(source: DescriptorRoot, destination: DescriptorRoot, fingerprint: Fingerprint): Promise<void> {
	try {
		await verifyDestinationEntry(destination, fingerprint);
		return;
	} catch (error) {
		if (!String((error as Error).message).startsWith("missing migration entry")) throw error;
	}
	if (fingerprint.type === "symlink") {
		await destination.createSymlink(
			fingerprint.destinationPath ?? fingerprint.path,
			await source.readSymlink(fingerprint.path),
		);
	} else {
		await destination.copyFileFrom(
			source,
			fingerprint.path,
			{
				mode: fingerprint.mode,
				mtimeMs: fingerprint.mtimeMs,
			},
			fingerprint.destinationPath ?? fingerprint.path,
		);
	}
	await verifyDestinationEntry(destination, fingerprint);
}

async function verifyDestinationEntry(destination: DescriptorRoot, expected: Fingerprint): Promise<void> {
	const destinationPath = expected.destinationPath ?? expected.path;
	const actual = await readFingerprint(destination, { ...expected, path: destinationPath });
	if (
		actual.type !== expected.type ||
		actual.hash !== expected.hash ||
		actual.size !== expected.size ||
		actual.mode !== expected.mode
	)
		throw new Error(`destination conflict during resume: ${destinationPath}`);
}

async function saveJournal(state: DescriptorRoot, name: string, journal: Journal): Promise<void> {
	await state.replaceFileAtomic(name, Buffer.from(`${JSON.stringify(journal)}\n`), { mode: 0o600 });
}

async function readJournal(state: DescriptorRoot, name: string): Promise<Journal | undefined> {
	let bytes: Uint8Array;
	try {
		bytes = await state.readFile(name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const journal = JSON.parse(new TextDecoder().decode(bytes)) as Journal;
	if (journal.version !== 1 || !Array.isArray(journal.copied) || !Array.isArray(journal.receipts))
		throw new Error("invalid migration journal");
	return journal;
}

function validateJournalIdentity(journal: Journal | undefined, layout: Layout): void {
	if (
		journal &&
		(journal.workspaceId !== workspaceId(layout.root) ||
			journal.source !== resolve(layout.root) ||
			journal.destination !== resolve(layout.destination))
	)
		throw new Error("journal identity mismatch");
}

async function assertPathIdentity(path: string, expected: string): Promise<void> {
	let root: DescriptorRoot;
	try {
		root = await openDescriptorRoot(path);
	} catch (error) {
		if (error instanceof UnsafeDescriptorPathError || (error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error("destination identity changed");
		throw error;
	}
	try {
		if ((await root.identity()) !== expected) throw new Error("destination identity changed");
	} finally {
		await root.close();
	}
}

function contained(base: string, candidate: string): boolean {
	const value = relative(resolve(base), resolve(candidate));
	return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

function validateLayout(layout: Layout): void {
	if (layout.version !== 1) throw new Error(`unsupported layout version: ${layout.version}`);
	const source = resolve(layout.root);
	const destination = resolve(layout.destination);
	if (source === destination) throw new Error("destination must differ from source");
	if (contained(source, destination)) throw new Error("destination must not be nested inside source");
	try {
		const stat = lstatSync(layout.destination);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("destination must be a real directory");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

function ensureSpace(destination: string, bytes: number): void {
	try {
		const stat = statfsSync(dirname(destination));
		const available = stat.bavail * stat.bsize;
		if (available < bytes) throw new Error(`insufficient disk space: need ${bytes} bytes`);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("insufficient")) throw error;
	}
}
