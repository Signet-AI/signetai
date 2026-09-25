import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
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
export type DirectoryFingerprint = {
	path: string;
	destinationPath: string;
	mode: number;
	mtimeMs: number;
};
export type Receipt = { component: string; phase: "accepted" | "verified"; fingerprint: Fingerprint };
export type DatabaseSnapshot = {
	sourceRoot: string;
	sourcePath: string;
	destinationPath: string;
	bytes: number;
	hash: string;
	walHash?: string | null;
};
export type ExternalDatabaseReference = { path: string; device: string; inode: string };
export type Journal = {
	version: 1;
	workspaceId: string;
	source: string;
	destination: string;
	sourceIdentity: string;
	destinationParentIdentity: string;
	destinationIdentity: string;
	destinationCreated?: boolean;
	phase: "preflight" | "drained" | "copying" | "snapshotting" | "verified" | "cutover-pending" | "completed" | "failed";
	destinationWrites: boolean;
	rollbackEligible: boolean;
	copied: string[];
	pendingCopy?: string;
	pendingCopyTemporaryPath?: string;
	receipts: Receipt[];
	fingerprints: Fingerprint[];
	directories?: DirectoryFingerprint[];
	requiredBytes: number;
	error?: string;
	databaseSnapshot?: DatabaseSnapshot | null;
	externalDatabase?: ExternalDatabaseReference | null;
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
	directories?: DirectoryFingerprint[];
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
		acquireFence?: () => Promise<{ release(): Promise<void>; externalDatabase?: ExternalDatabaseReference | null }>;
		externalReference?: () => Promise<ExternalDatabaseReference | undefined>;
		prepare(): Promise<{ sourceRoot: string; sourcePath: string; destinationPath: string; bytes: number } | undefined>;
		backupTo?: (sourceDatabase: string, stagingDatabase: string) => Promise<void>;
		verifySnapshot?: (sourceDatabase: string, destinationDatabase: string) => Promise<void>;
	};
	layoutBytes?: (layout: Layout) => Uint8Array;
	gitignoreBytes?: (existing: string) => Uint8Array;
	mapDestinationPath?: (sourcePath: string, type: "file" | "symlink" | "directory") => string | undefined;
	journalStateDir: string;
	hooks?: {
		afterDatabaseFence?: () => Promise<void>;
		afterCopy?: () => Promise<void>;
		afterEntryCopy?: () => Promise<void>;
		afterEntryPublish?: (component: string, temporaryPath: string) => Promise<void>;
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
		let state: DescriptorRoot | undefined;
		let source: DescriptorRoot | undefined;
		let journal: Journal | null | undefined;
		try {
			state = await openOrCreateRoot(this.deps.journalStateDir);
			source = await openDescriptorRoot(layout.root);
			journal = await readJournal(state, this.journalName);
		} catch (error) {
			try {
				await source?.close();
			} finally {
				try {
					await state?.close();
				} finally {
					await lease?.release();
				}
			}
			throw error;
		}
		let destination: AdmittedDestination | undefined;
		let databaseFence: { release(): Promise<void>; externalDatabase?: ExternalDatabaseReference | null } | undefined;
		const releaseDatabaseFence = async () => {
			const held = databaseFence;
			databaseFence = undefined;
			await held?.release();
		};
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
					await this.drainWriters();
					databaseFence = await this.deps.database.acquireFence?.();
					await this.verifyExternalDatabase(journal);
					await this.finishCutover(layout, journal, state, releaseDatabaseFence);
					return { status: "completed", destination: layout.destination, receipt: this.journalPath };
				}
			}
			await this.drainWriters();
			databaseFence = await this.deps.database.acquireFence?.();
			await this.deps.hooks?.afterDatabaseFence?.();
			const externalDatabase = (await this.deps.database.externalReference?.()) ?? null;
			if (databaseFence?.externalDatabase !== undefined) this.assertExternalDatabase(databaseFence, externalDatabase);
			if (journal) this.assertExternalDatabase(journal, externalDatabase);
			const plan = await inventory(layout, source, this.deps.journalStateDir, this.deps.mapDestinationPath);
			if (journal) await verifyJournalSources(source, journal);
			if (journal && !sameSourceInventory(plan.fingerprints ?? [], journal.fingerprints))
				throw new Error("source inventory changed during migration");
			if (journal && !sameDirectoryInventory(plan.directories ?? [], journal.directories ?? []))
				throw new Error("source directory inventory changed during migration");
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
				directories: plan.directories ?? [],
				requiredBytes: plan.bytes,
				externalDatabase,
			};
			journal.phase = "drained";
			await saveJournal(state, this.journalName, journal);
			destination = await admitDestination(layout.destination, journal.destinationIdentity, journal.destinationCreated);
			if (journal.destinationIdentity !== "missing" && journal.destinationIdentity !== destination.identity)
				throw new Error("destination identity mismatch");
			if (
				journal.destinationParentIdentity !== "missing" &&
				journal.destinationParentIdentity !== destination.parentIdentity
			)
				throw new Error("destination parent identity mismatch");
			journal.destinationIdentity = destination.identity;
			journal.destinationParentIdentity = destination.parentIdentity;
			journal.destinationCreated = true;
			journal.destinationWrites = true;
			await saveJournal(state, this.journalName, journal);
			await this.deps.hooks?.afterDestinationAdmitted?.();
			if (journal.pendingCopyTemporaryPath !== undefined) await removePendingCopyTemporary(destination.root, journal);

			const expected = new Map((plan.fingerprints ?? []).map((fingerprint) => [fingerprint.path, fingerprint]));
			const copied = new Set(journal.copied);
			for (const component of plan.components) {
				const fingerprint = expected.get(component);
				if (!fingerprint) throw new Error(`missing source fingerprint: ${component}`);
				if (!copied.has(component)) {
					const temporaryPath = fingerprint.type === "file" ? migrationTemporaryPath(fingerprint) : undefined;
					const afterEntryPublish = this.deps.hooks?.afterEntryPublish;
					journal.pendingCopy = component;
					journal.pendingCopyTemporaryPath = temporaryPath;
					journal.phase = "copying";
					await saveJournal(state, this.journalName, journal);
					await copyEntry(source, destination.root, fingerprint, {
						...(temporaryPath === undefined ? {} : { temporaryPath }),
						...(temporaryPath === undefined || afterEntryPublish === undefined
							? {}
							: {
									afterPublish: () => afterEntryPublish(component, temporaryPath),
								}),
					});
					await this.deps.hooks?.afterEntryCopy?.();
					journal.receipts.push({ component, phase: "accepted", fingerprint });
					journal.copied.push(component);
					journal.pendingCopy = undefined;
					journal.pendingCopyTemporaryPath = undefined;
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
							walHash: await optionalHashFile(sourceRoot, `${prepared.sourcePath}-wal`),
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
				let stagingDir: string | undefined;
				let stagingRoot: DescriptorRoot | undefined;
				try {
					const assertSourceUnchanged = async () => {
						if (
							(await snapshotSource.hashFile(snapshot.sourcePath)) !== snapshot.hash ||
							(snapshot.walHash !== undefined &&
								(await optionalHashFile(snapshotSource, `${snapshot.sourcePath}-wal`)) !== snapshot.walHash)
						)
							throw new Error("database snapshot source changed or disappeared");
					};
					await assertSourceUnchanged();
					if (this.deps.database.backupTo && snapshot.walHash === undefined)
						throw new Error("database snapshot journal lacks WAL evidence");
					let copyRoot = snapshotSource;
					let copyPath = snapshot.sourcePath;
					if (this.deps.database.backupTo) {
						stagingDir = mkdtempSync(join(tmpdir(), "signet-migration-db-"));
						stagingRoot = await openDescriptorRoot(stagingDir);
						await this.deps.database.backupTo(
							join(snapshot.sourceRoot, snapshot.sourcePath),
							join(stagingDir, "snapshot.sqlite"),
						);
						await assertSourceUnchanged();
						copyRoot = stagingRoot;
						copyPath = "snapshot.sqlite";
					}
					const copyHash = await copyRoot.hashFile(copyPath);
					const existing = (await destination.root.inventory()).find(
						(entry) => entry.path === snapshot.destinationPath,
					);
					if (existing) {
						if (existing.type !== "file" || (await destination.root.hashFile(snapshot.destinationPath)) !== copyHash)
							throw new Error("destination database snapshot conflicts with source");
					} else {
						await destination.root.copyFileFrom(copyRoot, copyPath, {}, snapshot.destinationPath);
					}
					if ((await destination.root.hashFile(snapshot.destinationPath)) !== copyHash)
						throw new Error("database integrity verification failed");
					if (!this.deps.database.verifySnapshot) throw new Error("semantic database verifier is not configured");
					await this.deps.database.verifySnapshot(
						join(snapshot.sourceRoot, snapshot.sourcePath),
						join(layout.destination, snapshot.destinationPath),
					);
					if ((await destination.root.hashFile(snapshot.destinationPath)) !== copyHash)
						throw new Error("destination database changed during semantic verification");
					await assertSourceUnchanged();
				} finally {
					try {
						await stagingRoot?.close();
					} finally {
						try {
							if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
						} finally {
							await snapshotSource.close();
						}
					}
				}
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
			}
			if (this.deps.layoutBytes) {
				await destination.root.replaceFileAtomic("workspace-layout.json", this.deps.layoutBytes(layout), {
					mode: 0o600,
				});
			}
			await finalizeDirectories(destination.root, journal.directories ?? []);
			journal.phase = "verified";
			await saveJournal(state, this.journalName, journal);
			await assertPathIdentity(layout.destination, journal.destinationIdentity);
			return await this.finishCutover(layout, journal, state, releaseDatabaseFence);
		} catch (error) {
			if (journal) {
				if (journal.phase !== "verified" && journal.phase !== "cutover-pending") journal.phase = "failed";
				journal.error = error instanceof Error ? error.message : String(error);
				await saveJournal(state, this.journalName, journal);
			}
			throw error;
		} finally {
			try {
				await destination?.root.close();
			} finally {
				try {
					await destination?.parent.close();
				} finally {
					try {
						await source.close();
					} finally {
						try {
							await state.close();
						} finally {
							try {
								await releaseDatabaseFence();
							} finally {
								await lease?.release();
							}
						}
					}
				}
			}
		}
	}

	private assertExternalDatabase(
		journal: Pick<Journal, "externalDatabase">,
		current: ExternalDatabaseReference | null,
	): void {
		if (journal.externalDatabase === undefined && current !== null)
			throw new Error("external database identity is missing from migration journal");
		const expected = journal.externalDatabase ?? null;
		if (
			(expected === null) !== (current === null) ||
			(expected !== null &&
				current !== null &&
				(resolve(expected.path) !== resolve(current.path) ||
					expected.device !== current.device ||
					expected.inode !== current.inode))
		)
			throw new Error("external database identity changed during migration");
	}

	private async verifyExternalDatabase(journal: Journal): Promise<void> {
		let current: ExternalDatabaseReference | null;
		try {
			current = (await this.deps.database.externalReference?.()) ?? null;
		} catch {
			throw new Error("external database identity unavailable during migration");
		}
		this.assertExternalDatabase(journal, current);
	}

	private async verifyPublishedDestination(layout: Layout, journal: Journal): Promise<void> {
		if (!journal.pointerPublished) throw new Error("completed migration journal has no published pointer");
		await assertPathIdentity(layout.destination, journal.destinationIdentity);
		await this.deps.resolver.verifyDestination?.({ ...layout, version: 2 });
		journal.destinationVerified = true;
	}

	private async finishCutover(
		layout: Layout,
		journal: Journal,
		state: DescriptorRoot,
		releaseBeforeVerify?: () => Promise<void>,
	): Promise<MigrationResult> {
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
		await releaseBeforeVerify?.();
		try {
			await this.verifyExternalDatabase(journal);
			await this.deps.resolver.verifyDestination?.({ ...layout, version: 2 });
			await this.verifyExternalDatabase(journal);
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
		let lease: { release(): Promise<void> } | undefined;
		try {
			lease = await this.deps.lease?.acquire();
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
			try {
				await state.close();
			} finally {
				await lease?.release();
			}
		}
	}

	async rollback(): Promise<void> {
		const state = await openExistingRoot(this.deps.journalStateDir);
		if (!state) return;
		let lease: { release(): Promise<void> } | undefined;
		try {
			lease = await this.deps.lease?.acquire();
			const journal = await readJournal(state, this.journalName);
			if (!journal) return;
			if (!journal.rollbackEligible || journal.phase === "completed")
				throw new Error("rollback is no longer safe after cutover begins");
			if (journal.destinationCreated !== true) throw new Error("migration destination ownership is unverified");
			const parent = await openDescriptorRoot(dirname(journal.destination));
			try {
				if ((await parent.identity()) !== journal.destinationParentIdentity)
					throw new Error("refusing to remove unsafe migration destination parent");
				const destination = await parent.openDirectory(basename(journal.destination));
				try {
					if ((await destination.identity()) !== journal.destinationIdentity)
						throw new Error("refusing to remove unsafe migration destination");
					if (journal.pendingCopyTemporaryPath !== undefined) await removePendingCopyTemporary(destination, journal);
					const entries = await verifyRollbackDestination(destination, journal);
					let rollbackInventoryRevalidated = false;
					const revalidateBeforeMutation = async () => {
						if (rollbackInventoryRevalidated) return;
						await verifyRollbackDestination(destination, journal);
						rollbackInventoryRevalidated = true;
					};
					for (const entry of entries.filter((entry) => entry.type !== "directory")) {
						const expected = journal.fingerprints.find(
							(fingerprint) =>
								(journal.copied.includes(fingerprint.path) || journal.pendingCopy === fingerprint.path) &&
								(fingerprint.destinationPath ?? fingerprint.path) === entry.path,
						);
						if (!expected) throw new Error(`unexpected migration destination entry: ${entry.path}`);
						await destination.remove(entry.path, {
							beforeMutation: async () => {
								await revalidateBeforeMutation();
								await verifyDestinationEntry(destination, expected);
							},
						});
					}
					for (const entry of entries
						.filter((entry) => entry.type === "directory")
						.sort((a, b) => b.path.split(sep).length - a.path.split(sep).length))
						await destination.remove(entry.path, {
							beforeMutation: revalidateBeforeMutation,
						});
				} finally {
					await destination.close();
				}
				await parent.remove(basename(journal.destination), {
					beforeMutation: async () => {
						const remaining = await parent.openDirectory(basename(journal.destination));
						try {
							if ((await remaining.identity()) !== journal.destinationIdentity)
								throw new Error("refusing to remove replaced migration destination");
							const entries = await remaining.inventory();
							if (entries.length > 0)
								throw new Error(`unexpected migration destination entry: ${entries[0]?.path ?? "unknown"}`);
						} finally {
							await remaining.close();
						}
					},
				});
			} finally {
				await parent.close();
			}
			await state.remove(this.journalName);
		} finally {
			try {
				await state.close();
			} finally {
				await lease?.release();
			}
		}
	}
}

async function optionalHashFile(root: DescriptorRoot, path: string): Promise<string | null> {
	try {
		return await root.hashFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
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

async function admitDestination(
	path: string,
	expectedIdentity: string,
	created?: boolean,
): Promise<AdmittedDestination> {
	const parent = await openDescriptorRoot(dirname(path));
	try {
		const parentIdentity = await parent.identity();
		if (expectedIdentity === "missing") await parent.createDirectoryExclusive(basename(path), 0o700);
		else if (created !== true) throw new Error("migration destination ownership is unverified");
		const root = await parent.openDirectory(basename(path));
		return { parent, root, parentIdentity, identity: await root.identity() };
	} catch (error) {
		await parent.close();
		throw error;
	}
}

async function verifyRollbackDestination(destination: DescriptorRoot, journal: Journal): Promise<DescriptorEntry[]> {
	const copied = new Set(journal.copied);
	if (journal.pendingCopy !== undefined) copied.add(journal.pendingCopy);
	const expected = new Map(
		journal.fingerprints
			.filter((fingerprint) => copied.has(fingerprint.path))
			.map((fingerprint) => [fingerprint.destinationPath ?? fingerprint.path, fingerprint]),
	);
	const directories = new Set((journal.directories ?? []).map((directory) => directory.destinationPath));
	for (const path of [
		...journal.fingerprints.map((fingerprint) => fingerprint.destinationPath ?? fingerprint.path),
		...directories,
	]) {
		let parent = dirname(path);
		while (parent !== ".") {
			directories.add(parent);
			parent = dirname(parent);
		}
	}
	const entries = await destination.inventory();
	for (const entry of entries) {
		if (entry.type === "directory") {
			if (!directories.has(entry.path)) throw new Error(`unexpected migration destination entry: ${entry.path}`);
			continue;
		}
		const fingerprint = expected.get(entry.path);
		if (!fingerprint) throw new Error(`unexpected migration destination entry: ${entry.path}`);
		await verifyDestinationEntry(destination, fingerprint);
	}
	return entries;
}

function relativeParent(path: string): string {
	const separator = path.lastIndexOf("/");
	return separator === -1 ? "" : path.slice(0, separator);
}

function relativeName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function migrationTemporaryPath(fingerprint: Fingerprint): string {
	const destinationPath = fingerprint.destinationPath ?? fingerprint.path;
	const parent = relativeParent(destinationPath);
	const name = `.signet-migration-${randomUUID()}.tmp`;
	return parent ? `${parent}/${name}` : name;
}

async function removePendingCopyTemporary(destination: DescriptorRoot, journal: Journal): Promise<void> {
	const temporaryPath = journal.pendingCopyTemporaryPath;
	if (temporaryPath === undefined) return;
	const fingerprint = journal.fingerprints.find((entry) => entry.path === journal.pendingCopy);
	if (!journal.pendingCopy || !fingerprint || fingerprint.type !== "file")
		throw new Error("invalid migration temporary journal entry");
	const destinationPath = fingerprint.destinationPath ?? fingerprint.path;
	if (
		relativeParent(temporaryPath) !== relativeParent(destinationPath) ||
		!/^\.signet-migration-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(
			relativeName(temporaryPath),
		)
	)
		throw new Error("unsafe migration temporary path");
	const entry = (await destination.inventory()).find((candidate) => candidate.path === temporaryPath);
	if (!entry) return;
	if (entry.type !== "file") throw new Error(`unsafe migration staging entry: ${temporaryPath}`);
	try {
		await destination.remove(temporaryPath, {
			beforeMutation: async () => {
				const current = (await destination.inventory()).find((candidate) => candidate.path === temporaryPath);
				if (current && (current.type !== "file" || current.dev !== entry.dev || current.ino !== entry.ino))
					throw new Error(`migration staging entry changed: ${temporaryPath}`);
			},
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function inventory(
	layout: Layout,
	source: DescriptorRoot,
	journalStateDir: string,
	mapDestinationPath?: (sourcePath: string, type: "file" | "symlink" | "directory") => string | undefined,
): Promise<MigrationPlan> {
	const stateRelative = contained(layout.root, journalStateDir)
		? relative(resolve(layout.root), resolve(journalStateDir))
		: undefined;
	const entries = (await source.inventory()).filter(
		(entry) => !stateRelative || (entry.path !== stateRelative && !entry.path.startsWith(`${stateRelative}${sep}`)),
	);
	const fingerprints: Fingerprint[] = [];
	const directories: DirectoryFingerprint[] = [];
	const destinations = new Map<string, DirectoryFingerprint>();
	const hardlinkPaths = new Map<string, string[]>();
	let bytes = 0;
	for (const entry of entries) {
		const mappedPath = mapDestinationPath?.(entry.path, entry.type);
		if (mapDestinationPath && mappedPath === undefined) continue;
		const destinationPath = mappedPath ?? entry.path;
		if (entry.type === "directory") {
			const directory = { path: entry.path, destinationPath, mode: entry.mode, mtimeMs: entry.mtimeMs };
			const prior = destinations.get(destinationPath);
			if (prior && (prior.mode !== directory.mode || prior.path !== directory.path))
				throw new Error(`conflicting destination directory: ${destinationPath}`);
			destinations.set(destinationPath, directory);
			directories.push(directory);
			continue;
		}
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
		directories,
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

function sameDirectoryInventory(actual: DirectoryFingerprint[], expected: DirectoryFingerprint[]): boolean {
	if (actual.length !== expected.length) return false;
	const byPath = new Map(expected.map((directory) => [directory.path, directory]));
	return actual.every((directory) => {
		const prior = byPath.get(directory.path);
		return prior !== undefined && prior.destinationPath === directory.destinationPath && prior.mode === directory.mode;
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

async function finalizeDirectories(destination: DescriptorRoot, directories: DirectoryFingerprint[]): Promise<void> {
	const ordered = [...directories].sort(
		(a, b) => b.destinationPath.split("/").length - a.destinationPath.split("/").length,
	);
	for (const directory of ordered) {
		await destination.createDirectory(directory.destinationPath, directory.mode, directory.mtimeMs);
	}
	const actual = new Map(
		(await destination.inventory()).filter((entry) => entry.type === "directory").map((entry) => [entry.path, entry]),
	);
	for (const directory of directories) {
		const entry = actual.get(directory.destinationPath);
		if (!entry || entry.mode !== directory.mode || Math.abs(entry.mtimeMs - directory.mtimeMs) > 1)
			throw new Error(`destination directory metadata mismatch: ${directory.destinationPath}`);
	}
}

async function copyEntry(
	source: DescriptorRoot,
	destination: DescriptorRoot,
	fingerprint: Fingerprint,
	options: { temporaryPath?: string; afterPublish?: () => Promise<void> } = {},
): Promise<void> {
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
				...(options.temporaryPath === undefined ? {} : { temporaryName: relativeName(options.temporaryPath) }),
				...(options.afterPublish === undefined ? {} : { afterPublish: options.afterPublish }),
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
	if (
		journal.version !== 1 ||
		!Array.isArray(journal.copied) ||
		!Array.isArray(journal.receipts) ||
		(journal.pendingCopyTemporaryPath !== undefined && typeof journal.pendingCopyTemporaryPath !== "string")
	)
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
