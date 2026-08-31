import { createHash, randomUUID } from "node:crypto";
import { access, open, mkdir, rm, writeFile, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TRANSCRIPT_IMPORT_LIMITS, signetExportV1Adapter } from "./transcript-import-adapter";
import { buildCompletedTranscriptCommit, canonicalTranscriptLine } from "./transcript-import-commit";
import { inventoryTranscriptFile, type InventoryRecord } from "./transcript-import-inventory";
import type { ImportJobState, ImportStore } from "./transcript-import-store";
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
type Job = { id: string; state: ImportJobState; generation?: number; control_request?: string | null };
type File = {
	id: string;
	job_id: string;
	source_id: string;
	managed_path: string;
	checkpoint_byte_offset: number;
	checkpoint_ordinal: number;
	state: string;
};
type Row = InventoryRecord & {
	id: string;
	file_id: string;
	source_id: string;
	job_id: string;
	status: string;
	value?: never;
};

/** Executes imports one job/file at a time. SQLite mutations are delegated to ImportStore. */
export function startTranscriptImportWorker(options: TranscriptImportWorkerOptions): TranscriptImportWorkerHandle {
	let active = true;
	let wake: (() => void) | undefined;
	let loopPromise: Promise<void>;
	const wait = () =>
		new Promise<void>((resolve) => {
			wake = resolve;
		});
	const root = options.workspaceRoot ?? process.env.SIGNET_PATH ?? join(process.env.HOME ?? ".", ".agents");
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
					payload: {},
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
		const leased = await options.store.run<Job | null>({
			kind: "source_import",
			operation: "lease",
			agentId: options.agentId,
			jobId: job.id,
			payload: { token: randomUUID(), generation: job.generation ?? 0 },
		});
		if (!leased) return;
		const files = await options.store.run<File[]>({
			kind: "source_import",
			operation: "list",
			agentId: options.agentId,
			jobId: job.id,
			payload: { view: "files" },
		});
		const committedSources = new Set<string>();
		for (const file of files) {
			if (!active) return;
			const path = join(root, file.managed_path);
			if (file.state !== "completed") {
				await inventoryTranscriptFile(
					path,
					{ byteOffset: file.checkpoint_byte_offset, ordinal: file.checkpoint_ordinal },
					TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch,
					async (records, checkpoint) => {
						await options.store.run({
							kind: "source_import",
							operation: "record_batch",
							agentId: options.agentId,
							jobId: job.id,
							payload: { fileId: file.id, sourceId: file.source_id, records, checkpoint },
						});
						await maybeCrashDuringInventory(root);
					},
				);
				await options.store.run({
					kind: "source_import",
					operation: "file_complete",
					agentId: options.agentId,
					jobId: job.id,
					payload: { fileId: file.id },
				});
			}
			if (await commitPending(job.id, file, path)) committedSources.add(file.source_id);
		}
		await options.store.run({
			kind: "source_import",
			operation: "finalize",
			agentId: options.agentId,
			jobId: job.id,
			payload: {},
		});
		for (const sourceId of committedSources) await options.onBatch?.(job.id, sourceId);
	};
	const commitPending = async (jobId: string, file: File, path: string): Promise<boolean> => {
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
			const commits = [];
			for (const row of rows) {
				try {
					const handle = await open(path, "r");
					const raw = Buffer.alloc(row.byteLength);
					try {
						const got = await handle.read(raw, 0, row.byteLength, row.byteOffset);
						if (got.bytesRead !== row.byteLength) throw new Error("source_changed");
						const bytes = raw.subarray(0, got.bytesRead);
						const value = signetExportV1Adapter.parse(
							JSON.parse(
								new TextDecoder("utf-8", { fatal: true }).decode(
									bytes[bytes.length - 1] === 0x0a ? bytes.subarray(0, bytes.length - 1) : bytes,
								),
							),
						);
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
					await options.store.run({
						kind: "source_import",
						operation: "reject",
						agentId: options.agentId,
						jobId,
						payload: { recordId: row.id, code: error instanceof Error ? error.message : "source_changed" },
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
					await appendCanonical(root, options.agentId, harness, batch);
					await options.store.run({
						kind: "source_import",
						operation: "commit",
						agentId: options.agentId,
						jobId,
						payload: { commits: batch },
					});
					committed = true;
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

export async function appendCanonical(
	root: string,
	agentId: string,
	harness: string,
	commits: readonly Parameters<typeof canonicalTranscriptLine>[0][],
): Promise<void> {
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
				continue;
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
				payload: {},
			});
}
async function readText(path: string): Promise<string> {
	try {
		return await (await import("node:fs/promises")).readFile(path, "utf8");
	} catch {
		return "";
	}
}
function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Remove staged source data and rewrite each canonical harness stream once. */
export async function purgeTranscriptImportFilesystem(root: string, sourceId: string, agentId?: string): Promise<void> {
	await rm(join(root, "imports", "transcripts", sourceId), { recursive: true, force: true });
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
