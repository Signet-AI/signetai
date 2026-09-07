import { dbOwnerQuery, dbOwnerTransaction } from "./db-owner-runtime";
import { randomUUID } from "node:crypto";
import {
	buildCompletedTranscriptCommit,
	transcriptCommitBatchBytes,
	type CompletedTranscriptCommit,
} from "./transcript-import-commit";
import { signetExportV1Adapter, TRANSCRIPT_IMPORT_LIMITS } from "./transcript-import-adapter";
import {
	cleanupCancelledTranscriptImport,
	readTranscriptBytes,
	type TranscriptUploadScope,
} from "./transcript-import-bytes";
import { scanTranscriptBatch, type TranscriptCheckpoint } from "./transcript-import-scan";
import type { InventoryRecord } from "./transcript-import-scan";
import { prepareTranscriptRetry, type ImportStore } from "./transcript-import-store";
import { resolveDefaultBasePath } from "@signet/core";
import { migrateTranscriptImports } from "./transcript-import-migration";

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
interface Job {
	readonly id: string;
	readonly generation: number;
	readonly state: string;
	readonly lease_token: string | null;
	readonly control_request: string | null;
}
interface File {
	readonly id: string;
	readonly source_id: string;
	readonly storage_state: string;
	readonly upload_generation: number;
	readonly size_bytes: number;
	readonly checkpoint_byte_offset: number;
	readonly checkpoint_ordinal: number;
	readonly checkpoint_line_number: number;
	readonly state: string;
}

/** One active import, bounded owner transactions, and an awaited shutdown boundary. */
export function startTranscriptImportWorker(options: TranscriptImportWorkerOptions): TranscriptImportWorkerHandle {
	let active = true;
	let wake: (() => void) | undefined;
	const wait = (): Promise<void> =>
		new Promise((resolve) => {
			const timer = setTimeout(done, Math.max(10, options.pollMs ?? 250));
			function done(): void {
				clearTimeout(timer);
				wake = undefined;
				resolve();
			}
			wake = done;
		});
	const store = <Result>(
		jobId: string,
		operation: Parameters<ImportStore["run"]>[0]["operation"],
		payload: Readonly<Record<string, unknown>>,
	): Promise<Result> =>
		options.store.run<Result>({ kind: "source_import", operation, jobId, agentId: options.agentId, payload });
	const processJob = async (job: Job): Promise<void> => {
		while (active && (await prepareTranscriptRetry(job.id, options.agentId, job.generation))) await options.yield?.();
		if (!active) return;
		const leaseToken = randomUUID();
		const leased = await store<Job | null>(job.id, "lease", { token: leaseToken, generation: job.generation });
		if (!leased) return;
		const generation = leased.generation;
		const guard = async (): Promise<void> => {
			if (!active) throw new Error("import worker stopped");
			const current = (await store<Job[]>(job.id, "list", { view: "status" }))[0];
			if (!current || current.generation !== generation || current.lease_token !== leaseToken)
				throw new Error("stale import lease");
		};
		let fileId: string | undefined;
		try {
			const files = await store<File[]>(job.id, "list", { view: "files" });
			for (const file of files) {
				fileId = file.id;
				if (file.storage_state !== "sealed")
					throw new RangeError("source evidence requires migration or is unavailable");
				const scope: TranscriptUploadScope = {
					agentId: options.agentId,
					jobId: job.id,
					fileId: file.id,
					generation: file.upload_generation,
				};
				// Upgrade/retry can leave durable pending records before the saved scan offset.
				for (;;) {
					const pending = await store<Array<InventoryRecord & { id: string }>>(job.id, "list", {
						view: "pending",
						fileId: file.id,
						limit: 1,
					});
					const row = pending[0];
					if (!row) break;
					await guard();
					try {
						if (row.byteLength > TRANSCRIPT_IMPORT_LIMITS.maxRecordBytes + 1) throw new RangeError("oversized_record");
						const parts: Buffer[] = [];
						for (let offset = row.byteOffset; offset < row.byteOffset + row.byteLength; ) {
							await guard();
							const bytes = await readTranscriptBytes(
								scope,
								offset,
								Math.min(64 * 1024, row.byteOffset + row.byteLength - offset),
							);
							parts.push(bytes);
							offset += bytes.length;
						}
						const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
						let value: import("./transcript-import-adapter").SignetExportRecord;
						try {
							value = signetExportV1Adapter.parse(parsed);
						} catch {
							throw new RangeError("schema_invalid");
						}
						const commit = buildCompletedTranscriptCommit(value, {
							agentId: options.agentId,
							sourceId: file.source_id,
							sourceRecordId: row.id,
							sourceMetaJson: JSON.stringify({ fileId: file.id, uploadGeneration: file.upload_generation }),
						});
						if (transcriptCommitBatchBytes([commit]) > TRANSCRIPT_IMPORT_LIMITS.maxCanonicalBatchBytes)
							throw new RangeError("canonical_batch_too_large");
						await store(job.id, "commit", { sourceId: file.source_id, commits: [commit], generation, leaseToken });
					} catch (error) {
						if (!(error instanceof RangeError) && !(error instanceof SyntaxError)) throw error;
						await store(job.id, "reject", {
							sourceId: file.source_id,
							recordId: row.id,
							code: error instanceof SyntaxError ? "malformed" : error.message,
							generation,
							leaseToken,
						});
					}
				}
				let checkpoint: TranscriptCheckpoint = {
					byteOffset: file.checkpoint_byte_offset,
					ordinal: file.checkpoint_ordinal,
					lineNumber: file.checkpoint_line_number,
				};
				let complete = file.state === "completed";
				while (!complete) {
					await guard();
					if (options.pressure?.()) {
						await wait();
						continue;
					}
					const scanned = await scanTranscriptBatch(
						async (offset) => {
							await guard();
							return readTranscriptBytes(scope, offset);
						},
						file.size_bytes,
						checkpoint,
					);
					let records: InventoryRecord[] = [];
					let commits: CompletedTranscriptCommit[] = [];
					const flush = async (next: TranscriptCheckpoint, last: boolean): Promise<void> => {
						await guard();
						await store(job.id, "commit", {
							sourceId: file.source_id,
							commits,
							generation,
							leaseToken,
							inventory: {
								fileId: file.id,
								records,
								previousByteOffset: checkpoint.byteOffset,
								checkpoint: next,
								complete: last,
							},
						});
						checkpoint = next;
						records = [];
						commits = [];
						await options.yield?.();
					};
					for (const record of scanned.records) {
						let commit =
							record.value === undefined
								? undefined
								: buildCompletedTranscriptCommit(record.value, {
										agentId: options.agentId,
										sourceId: file.source_id,
										sourceRecordId: `${job.id}:${file.id}:${record.ordinal}`,
										sourceMetaJson: JSON.stringify({ fileId: file.id, uploadGeneration: file.upload_generation }),
									});
						const { value: _value, ...metadata } = record;
						let inventory: InventoryRecord = metadata;
						if (commit && transcriptCommitBatchBytes([commit]) > TRANSCRIPT_IMPORT_LIMITS.maxCanonicalBatchBytes) {
							inventory = { ...metadata, status: "rejected", rejectionCode: "canonical_batch_too_large" };
							commit = undefined;
						}
						if (
							commit &&
							records.length &&
							transcriptCommitBatchBytes([...commits, commit]) > TRANSCRIPT_IMPORT_LIMITS.maxCanonicalBatchBytes
						) {
							const last = records[records.length - 1];
							if (!last) throw new Error("missing inventory boundary");
							await flush(
								{ byteOffset: last.byteOffset + last.byteLength, ordinal: last.ordinal, lineNumber: last.lineNumber },
								false,
							);
						}
						records.push(inventory);
						if (commit) commits.push(commit);
					}
					await flush(scanned.checkpoint, scanned.complete);
					complete = scanned.complete;
				}
				await options.onBatch?.(job.id, file.source_id);
			}
			await guard();
			await store(job.id, "finalize", { generation, leaseToken });
		} catch (error) {
			await store(job.id, "recover", {
				generation,
				leaseToken,
				fileId,
				retryable: !(error instanceof RangeError),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const run = async (): Promise<void> => {
		let recovered = false;
		while (active) {
			try {
				await cleanupCancelledTranscriptImport(options.agentId, undefined, () => active);
				if (!recovered) {
					try {
						await migrateTranscriptImports(
							options.workspaceRoot ?? resolveDefaultBasePath(),
							options.agentId,
							() => active,
						);
					} catch (error) {
						if (!active) return;
						const message = error instanceof Error ? error.message : String(error);
						await dbOwnerTransaction(
							[
								{
									sql: "UPDATE source_import_migrations SET state = 'failed', error = ? WHERE agent_id = ?",
									params: [message, options.agentId],
									result: "run",
								},
							],
							{ operation: "sources.import.migrate.failure", lane: "write" },
						);
						for (;;) {
							const legacy = await dbOwnerQuery<{ id: string }>(
								{
									sql: "SELECT j.id FROM source_import_jobs j WHERE j.agent_id = ? AND j.state IN ('queued','running','inventorying') AND EXISTS (SELECT 1 FROM source_import_files f WHERE f.job_id = j.id AND f.agent_id = j.agent_id AND f.storage_state = 'legacy') LIMIT 1",
									params: [options.agentId],
									result: "get",
									readonly: true,
								},
								{ operation: "sources.import.migrate.failed-job", lane: "read" },
							);
							if (!legacy || !active) break;
							await dbOwnerTransaction(
								[
									{
										sql: "UPDATE source_import_jobs SET state = 'failed',error = ?,generation = generation + 1,lease_token = NULL WHERE id = ? AND agent_id = ?",
										params: [message, legacy.id, options.agentId],
										result: "run",
									},
								],
								{ operation: "sources.import.migrate.failed-job", lane: "write" },
							);
						}
						console.error("Transcript import migration:", message);
					}
					for (;;) {
						if (!active) return;
						const jobs = await store<Job[]>("*", "list", { view: "recovery", limit: 25 });
						if (!jobs.length) break;
						for (const job of jobs) await store(job.id, "recover", { startup: true });
					}
					recovered = true;
				}
				if (!options.pressure?.()) {
					const jobs = await store<Job[]>("*", "list", { view: "work", limit: 1 });
					if (jobs[0]) await processJob(jobs[0]);
				}
			} catch (error) {
				// Durable leases/checkpoints remain the retry boundary if the owner dies.
				console.error("Transcript import worker:", error instanceof Error ? error.message : String(error));
			}
			if (active) await wait();
		}
	};
	const loop = run();
	return {
		get running() {
			return active;
		},
		nudge: () => wake?.(),
		stop: async () => {
			active = false;
			wake?.();
			await loop;
		},
	};
}
