import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, rm, stat, writeFile, readdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TRANSCRIPT_IMPORT_LIMITS, signetExportV1Adapter } from "./transcript-import-adapter";
import { resolveDefaultBasePath } from "@signet/core";
import {
	buildCompletedTranscriptCommit,
	canonicalTranscriptLine,
	splitTranscriptCommitBatches,
	transcriptCommitBatchBytes,
	type CompletedTranscriptCommit,
} from "./transcript-import-commit";
import { inventoryTranscriptFile, type InventoryRecord } from "./transcript-import-inventory";
import type { ImportJobState, ImportStore, ImportStoreOperation } from "./transcript-import-store";
import { controlImport, reconcileImport } from "./transcript-import-store";

export interface TranscriptImportWorkerHandle {
	readonly running: boolean;
	stop(): Promise<void>;
	nudge(): void;
}
export interface TranscriptImportWorkerOptions {
	readonly store: ImportStore;
	readonly agentId: string;
	readonly workspaceRoot?: string;
	readonly pressure?: () => boolean;
	readonly yield?: () => Promise<void>;
	readonly onBatch?: (jobId: string, sourceId: string) => Promise<void>;
	readonly pollMs?: number;
}
type Job = {
	id: string;
	state: ImportJobState;
	generation?: number;
	control_request?: string | null;
	lease_token?: string | null;
};
type File = {
	id: string;
	job_id: string;
	source_id: string;
	managed_path: string;
	checkpoint_byte_offset: number;
	checkpoint_ordinal: number;
	state: string;
	size_bytes?: number | null;
	content_hash?: string | null;
	error?: string | null;
};
type Row = InventoryRecord & {
	id: string;
	file_id: string;
	source_id: string;
	job_id: string;
	status: string;
	value?: never;
};

class SourceChangedError extends Error {
	readonly code = "source_changed";
	constructor(message = "staged source changed during import") {
		super(message);
		this.name = "SOURCE_CHANGED";
	}
}

class ImportDataError extends Error {
	readonly code = "malformed_record";
	constructor(message: string) {
		super(message);
		this.name = "IMPORT_DATA";
	}
}

class TransientImportError extends Error {
	readonly code = "transient";
	constructor(message: string, cause?: unknown) {
		super(message, { cause });
		this.name = "IMPORT_TRANSIENT";
	}
}

function classifyInventoryError(error: unknown): Error {
	if (error instanceof SourceChangedError || error instanceof ImportDataError || error instanceof TransientImportError)
		return error;
	const message = error instanceof Error ? error.message : String(error);
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ENOENT" || message === "checkpoint is beyond file size")
		return new SourceChangedError(message === "checkpoint is beyond file size" ? message : "staged source is missing");
	if (message === "oversized_record" || message === "canonical_transcript_corrupt") return new ImportDataError(message);
	return error instanceof Error ? error : new TransientImportError("unable to inventory staged source", error);
}

/** Executes imports one job/file at a time. SQLite mutations are delegated to ImportStore. */
export function startTranscriptImportWorker(options: TranscriptImportWorkerOptions): TranscriptImportWorkerHandle {
	let active = true;
	let wake: (() => void) | undefined;
	let loopPromise: Promise<void>;
	const wait = () =>
		new Promise<void>((resolve) => {
			wake = resolve;
		});
	const root = options.workspaceRoot ?? resolveDefaultBasePath();
	const run = async (): Promise<void> => {
		// Recovery can race DB-owner startup. Keep retrying the durable reset until
		// it is accepted; proceeding after one swallowed failure strands jobs with
		// an old lease and prevents the post-filesystem replay path from running.
		while (active) {
			try {
				await options.store.run({
					kind: "source_import",
					operation: "recover",
					agentId: options.agentId,
					jobId: "*",
					payload: { startup: true },
				});
				break;
			} catch {
				await new Promise<void>((resolve) => setTimeout(resolve, 250));
			}
		}
		while (active) {
			if (options.pressure?.()) {
				await wait();
				continue;
			}
			try {
				const jobs = await options.store.run<Job[]>({
					kind: "source_import",
					operation: "list",
					agentId: options.agentId,
					jobId: "*",
					payload: { limit: 1, view: "work" },
				});
				const job = jobs[0];
				if (job && ["queued", "running", "inventorying"].includes(job.state)) await processJob(job);
			} catch {
				/* retain durable state; the next nudge retries infrastructure work */
			}
			if (active) {
				await options.yield?.();
				if ((options.pollMs ?? 250) > 0)
					await Promise.race([wait(), new Promise<void>((r) => setTimeout(r, options.pollMs ?? 250))]);
			}
		}
	};
	const processJob = async (job: Job): Promise<void> => {
		const leaseToken = randomUUID();
		const leased = await options.store.run<(Job & { lease_token: string }) | null>({
			kind: "source_import",
			operation: "lease",
			agentId: options.agentId,
			jobId: job.id,
			payload: { token: leaseToken, generation: job.generation ?? 0 },
		});
		if (!leased) return;
		const generation = typeof leased.generation === "number" ? leased.generation : (job.generation ?? 0);
		const activeLeaseToken = typeof leased.lease_token === "string" ? leased.lease_token : leaseToken;
		let currentFileId: string | undefined;
		try {
			const guard = async (): Promise<void> => {
				const rows = await options.store.run<Job[]>({
					kind: "source_import",
					operation: "list",
					agentId: options.agentId,
					jobId: job.id,
					payload: { view: "status" },
				});
				const current = rows[0];
				if (!current) return;
				if (
					(current.generation !== undefined && current.generation !== generation) ||
					(current.lease_token !== undefined && current.lease_token !== activeLeaseToken)
				)
					throw new Error("stale import lease");
				if (current.control_request === "pause" || current.control_request === "cancel") {
					await options.store.run({
						kind: "source_import",
						operation: "control",
						agentId: options.agentId,
						jobId: job.id,
						payload: { apply: true, generation, leaseToken: activeLeaseToken },
					});
					throw new Error(`import ${current.control_request}d at checkpoint`);
				}
			};
			const guarded = async <T>(operation: ImportStoreOperation): Promise<T> => {
				await guard();
				return options.store.run<T>(operation);
			};
			await guard();
			const files = await options.store.run<File[]>({
				kind: "source_import",
				operation: "list",
				agentId: options.agentId,
				jobId: job.id,
				payload: { view: "files" },
			});
			for (const file of files) {
				if (!active) return;
				currentFileId = file.id;
				const path = resolveManagedImportPath(root, file.managed_path);
				if (file.state === "staging") throw new TransientImportError("file_not_ready");
				if (file.state === "failed") throw new SourceChangedError(file.error ?? "staged file failed");
				if (!["ready", "inventorying", "completed"].includes(file.state))
					throw new TransientImportError(`unsupported staged file state: ${file.state}`);
				if (file.state !== "completed") {
					await verifyStagedFile(file, path);
					let inventory: Awaited<ReturnType<typeof inventoryTranscriptFile>>;
					try {
						inventory = await inventoryTranscriptFile(
							path,
							{ byteOffset: file.checkpoint_byte_offset, ordinal: file.checkpoint_ordinal },
							TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch,
							async (records, checkpoint) => {
								await guarded<void>({
									kind: "source_import",
									operation: "record_batch",
									agentId: options.agentId,
									jobId: job.id,
									payload: {
										fileId: file.id,
										sourceId: file.source_id,
										records,
										checkpoint,
										generation,
										leaseToken: activeLeaseToken,
									},
								});
								await maybeCrashDuringInventory(root);
							},
						);
					} catch (error) {
						throw classifyInventoryError(error);
					}
					if (!inventory.complete) throw new SourceChangedError("staged source grew during inventory");
					await verifyStagedFile(file, path);
					await guarded<void>({
						kind: "source_import",
						operation: "file_complete",
						agentId: options.agentId,
						jobId: job.id,
						payload: { fileId: file.id, generation, leaseToken: activeLeaseToken },
					});
				}
				await commitPending(job.id, file, path, guarded, guard, { generation, leaseToken: activeLeaseToken });
			}
			await guard();
			const callbackSources = new Set(files.map((file) => file.source_id));
			for (const sourceId of callbackSources) await options.onBatch?.(job.id, sourceId);
			await guarded<void>({
				kind: "source_import",
				operation: "finalize",
				agentId: options.agentId,
				jobId: job.id,
				payload: { generation, leaseToken: activeLeaseToken },
			});
		} catch (error) {
			await recoverImportJob(options, job.id, generation, activeLeaseToken, error, currentFileId, () => active);
		}
	};
	const commitPending = async (
		jobId: string,
		file: File,
		path: string,
		guarded: <T>(operation: ImportStoreOperation) => Promise<T>,
		guard: () => Promise<void>,
		lease: { generation: number; leaseToken: string },
	): Promise<boolean> => {
		let committed = false;
		for (;;) {
			const rows = await options.store.run<Row[]>({
				kind: "source_import",
				operation: "list",
				agentId: options.agentId,
				jobId,
				payload: { view: "pending", fileId: file.id, limit: TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch },
			});
			if (!rows.length) return committed;
			await verifyStagedFile(file, path);
			const commits: CompletedTranscriptCommit[] = [];
			for (const row of rows) {
				try {
					const handle = await open(path, "r");
					const raw = Buffer.alloc(row.byteLength);
					try {
						const got = await handle.read(raw, 0, row.byteLength, row.byteOffset);
						if (got.bytesRead !== row.byteLength) throw new SourceChangedError("source record moved or was truncated");
						const bytes = raw.subarray(0, got.bytesRead);
						if (/^[a-f0-9]{64}$/u.test(row.rawHash)) {
							const hashedBytes = bytes[bytes.length - 1] === 0x0a ? bytes.subarray(0, bytes.length - 1) : bytes;
							const actualHash = createHash("sha256").update(hashedBytes).digest("hex");
							if (actualHash !== row.rawHash) throw new SourceChangedError("source record hash changed");
						}
						let value: ReturnType<typeof signetExportV1Adapter.parse>;
						try {
							value = signetExportV1Adapter.parse(
								JSON.parse(
									new TextDecoder("utf-8", { fatal: true }).decode(
										bytes[bytes.length - 1] === 0x0a ? bytes.subarray(0, bytes.length - 1) : bytes,
									),
								),
							);
						} catch (error) {
							throw new ImportDataError(error instanceof Error ? error.message : "malformed_record");
						}
						commits.push(
							buildCompletedTranscriptCommit(value, {
								agentId: options.agentId,
								sourceId: row.source_id,
								sourceRecordId: row.id,
								sourcePath: file.managed_path,
							}),
						);
					} finally {
						await handle.close();
					}
				} catch (error) {
					if (!(error instanceof ImportDataError)) throw error;
					await guarded<void>({
						kind: "source_import",
						operation: "reject",
						agentId: options.agentId,
						jobId,
						payload: {
							recordId: row.id,
							sourceId: row.source_id,
							code: error.message,
							generation: lease.generation,
							leaseToken: lease.leaseToken,
						},
					});
				}
			}
			if (commits.length) {
				const byHarness = new Map<string, typeof commits>();
				for (const commit of commits) {
					let group = byHarness.get(commit.harness);
					if (group === undefined) {
						group = [];
						byHarness.set(commit.harness, group);
					}
					group.push(commit);
				}
				for (const [harness, batch] of byHarness) {
					let commitBatches: CompletedTranscriptCommit[][];
					try {
						commitBatches = splitTranscriptCommitBatches(batch);
					} catch (error) {
						if (error instanceof RangeError) throw new ImportDataError(error.message);
						throw error;
					}
					for (const commitBatch of commitBatches) {
						await verifyStagedFile(file, path);
						await guard();
						await appendCanonical(root, options.agentId, harness, commitBatch);
						await guarded<void>({
							kind: "source_import",
							operation: "commit",
							agentId: options.agentId,
							jobId,
							payload: { commits: commitBatch, generation: lease.generation, leaseToken: lease.leaseToken },
						});
						committed = true;
					}
				}
			}
		}
	};
	loopPromise = run();
	return {
		get running() {
			return active;
		},
		stop: async () => {
			active = false;
			wake?.();
			await loopPromise;
		},
		nudge: () => wake?.(),
	};
}

async function verifyStagedFile(file: File, path: string): Promise<void> {
	const expectedSize = typeof file.size_bytes === "number" && file.size_bytes > 0 ? file.size_bytes : null;
	const expectedHash = typeof file.content_hash === "string" && file.content_hash.length > 0 ? file.content_hash : null;
	if (expectedSize === null && expectedHash === null) return;
	let actual: { readonly size: number; readonly hash: string };
	try {
		actual = await fingerprintFile(path);
	} catch (error) {
		if (error instanceof SourceChangedError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SourceChangedError("staged source is missing");
		throw new TransientImportError("unable to verify staged source", error);
	}
	if (expectedSize !== null && actual.size !== expectedSize) throw new SourceChangedError("staged source size changed");
	if (expectedHash !== null && actual.hash !== expectedHash) throw new SourceChangedError("staged source hash changed");
}

async function fingerprintFile(path: string): Promise<{ readonly size: number; readonly hash: string }> {
	const handle = await open(path, "r");
	const digest = createHash("sha256");
	let size = 0;
	try {
		for (;;) {
			const chunk = Buffer.allocUnsafe(64 * 1024);
			const result = await handle.read(chunk, 0, chunk.length, null);
			if (result.bytesRead === 0) break;
			size += result.bytesRead;
			digest.update(chunk.subarray(0, result.bytesRead));
		}
		const finalInfo = await stat(path);
		if (finalInfo.size !== size) throw new SourceChangedError("staged source grew while being read");
		return { size, hash: digest.digest("hex") };
	} finally {
		await handle.close();
	}
}

async function recoverImportJob(
	options: TranscriptImportWorkerOptions,
	jobId: string,
	generation: number,
	leaseToken: string,
	error: unknown,
	fileId?: string,
	isActive: () => boolean = () => true,
): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	const retryable =
		!(error instanceof SourceChangedError || error instanceof ImportDataError) &&
		message !== "canonical_transcript_corrupt";
	while (isActive()) {
		if (!message) return;
		try {
			await options.store.run({
				kind: "source_import",
				operation: "recover",
				agentId: options.agentId,
				jobId,
				payload: {
					generation,
					leaseToken,
					retryable,
					error: message,
					...(fileId === undefined ? {} : { fileId }),
				},
			});
			return;
		} catch {
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
		}
	}
}

export async function appendCanonical(
	root: string,
	agentId: string,
	harness: string,
	commits: readonly Parameters<typeof canonicalTranscriptLine>[0][],
): Promise<void> {
	if (commits.length === 0 || commits.length > TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch)
		throw new RangeError("invalid transcript commit batch");
	if (transcriptCommitBatchBytes(commits) > TRANSCRIPT_IMPORT_LIMITS.maxCanonicalBatchBytes)
		throw new RangeError("canonical_batch_too_large");
	const path = join(root, "transcripts", `${hash(`${agentId}\0${harness}`)}.jsonl`);
	await mkdir(dirname(path), { recursive: true });
	const lock = `${path}.lock`;
	for (;;) {
		try {
			await mkdir(lock);
			await writeFile(join(lock, "owner"), `${process.pid}\n`, "utf8");
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const owner = (await import("node:fs/promises")).readFile(join(lock, "owner"), "utf8");
				const ownerPid = Number((await owner).trim());
				if (Number.isInteger(ownerPid) && ownerPid > 0) {
					try {
						process.kill(ownerPid, 0);
						await new Promise((resolve) => setTimeout(resolve, 5));
						continue;
					} catch (probeError) {
						if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") throw probeError;
					}
				}
				await rm(lock, { recursive: true, force: true });
			} catch {
				// A process killed after mkdir or while holding the lock leaves a
				// stale directory. Only this worker writes these per-harness locks.
				await rm(lock, { recursive: true, force: true });
			}
		}
	}
	try {
		const existing = await readText(path);
		const ids = new Set<string>();
		for (const line of existing.split("\n")) {
			if (!line) continue;
			try {
				const id = (JSON.parse(line) as { id?: unknown }).id;
				if (typeof id === "string") ids.add(id);
			} catch {
				throw new Error("canonical_transcript_corrupt");
			}
		}
		const missing = commits.filter((commit) => !ids.has(commit.recordId));
		if (!missing.length) return;
		const temp = `${path}.append-${randomUUID()}`;
		const payload = missing.map(canonicalTranscriptLine).join("");
		const staged = await open(temp, "wx");
		try {
			await staged.writeFile(payload);
			await staged.sync();
		} finally {
			await staged.close();
		}
		const source = await open(path, "a+");
		try {
			await source.writeFile(payload);
			await source.sync();
		} finally {
			await source.close();
		}
		await maybeCrashAfterCanonicalWrite(root);
		await rm(temp, { force: true });
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await rm(lock, { recursive: true, force: true });
	}
}
async function maybeCrashDuringInventory(root: string): Promise<void> {
	if (process.env.SIGNET_TRANSCRIPT_IMPORT_FAILPOINT !== "inventory") return;
	const marker = join(root, ".daemon", "transcript-import-inventory-failpoint-fired");
	try {
		await open(marker, "wx").then((handle) => handle.close());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
		throw error;
	}
	process.stderr.write("transcript-import failpoint: inventory\\n");
	process.exit(87);
}

async function maybeCrashAfterCanonicalWrite(root: string): Promise<void> {
	if (process.env.SIGNET_TRANSCRIPT_IMPORT_FAILPOINT !== "after-fs-before-db") return;
	const marker = join(root, ".daemon", "transcript-import-failpoint-fired");
	try {
		await open(marker, "wx").then((handle) => handle.close());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
		throw error;
	}
	process.stderr.write("transcript-import failpoint: after-fs-before-db\\n");
	process.exit(86);
}

async function _recover(options: TranscriptImportWorkerOptions): Promise<void> {
	const jobs = await options.store.run<Job[]>({
		kind: "source_import",
		operation: "list",
		agentId: options.agentId,
		jobId: "*",
		payload: { limit: 100, view: "recovery" },
	});
	for (const job of jobs)
		if (["running", "inventorying"].includes(job.state))
			await options.store.run({
				kind: "source_import",
				operation: "recover",
				agentId: options.agentId,
				jobId: job.id,
				payload: { startup: true },
			});
}
async function readText(path: string): Promise<string> {
	try {
		return await (await import("node:fs/promises")).readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw new TransientImportError("unable to read canonical transcript", error);
	}
}

function resolveManagedImportPath(root: string, managedPath: string): string {
	const rootResolved = resolve(root);
	const candidate = resolve(rootResolved, managedPath);
	const relativePath = relative(rootResolved, candidate);
	const managedPrefix = `${join("imports", "transcripts")}${sep}`;
	if (
		!relativePath ||
		relativePath.startsWith("..") ||
		isAbsolute(relativePath) ||
		!relativePath.startsWith(managedPrefix)
	)
		throw new SourceChangedError("managed staged path escapes workspace");
	return candidate;
}
function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Remove staged source data and rewrite each canonical harness stream once. */
export async function purgeTranscriptImportFilesystem(
	root: string,
	sourceId: string,
	agentId?: string,
	managedPaths: readonly string[] = [],
): Promise<void> {
	for (const managedPath of managedPaths) {
		try {
			await rm(resolveManagedImportPath(root, managedPath), { force: true });
		} catch {
			// Never follow an invalid ledger path during purge.
		}
	}
	if (!sourceId.includes("/") && !sourceId.includes("\\") && !sourceId.includes("..")) {
		await rm(join(root, "imports", "transcripts", sourceId), { recursive: true, force: true });
	}
	const dir = join(root, "transcripts");
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch {
		return;
	}
	for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
		const path = join(dir, name);
		const input = await readText(path);
		const kept = input
			.split(/(?<=\n)/u)
			.filter((line) => {
				try {
					const value = JSON.parse(line) as { source_id?: unknown; agent_id?: unknown };
					return !(value.source_id === sourceId && (agentId === undefined || value.agent_id === agentId));
				} catch {
					return true;
				}
			})
			.join("");
		if (kept === input) continue;
		const temp = `${path}.purge-${randomUUID()}`;
		await writeFile(temp, kept, { flag: "w" });
		const fd = await open(temp, "r+");
		try {
			await fd.sync();
		} finally {
			await fd.close();
		}
		await rename(temp, path);
	}
}
export function importWorkerBatchSize(): number {
	return TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch;
}
export function newImportLeaseToken(): string {
	return randomUUID();
}
export { controlImport, reconcileImport };
