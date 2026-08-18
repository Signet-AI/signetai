import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import type { Database as BunDatabase } from "bun:sqlite";
import { findSqliteVecExtension } from "@signet/core";
import {
	applyObsidianSourceStructureInTx,
	applyObsidianSourceStructurePurgeInTx,
	buildObsidianMarkdownPathIndex,
	purgeObsidianSourceFileStructureInTx,
} from "./obsidian-source-graph";
import { upsertMemoryArtifactInTx } from "./memory-lineage";
import { applySourceSnapshotImportInTx } from "./source-snapshots";
import type {
	DbOwnerCommand,
	DbOwnerEvent,
	DbOwnerJob,
	DbOwnerParameter,
	DbOwnerRecallPayload,
	DbOwnerStatement,
} from "./db-owner-protocol";
import {
	DB_OWNER_MAX_DEADLINE_MS,
	DB_OWNER_MAX_QUEUE_DEPTH,
	DB_OWNER_MAX_RESULT_BYTES,
	DB_OWNER_MAX_TRANSACTION_STATEMENTS,
	DB_OWNER_MAX_WORK_UNITS,
	serializeError,
} from "./db-owner-protocol";

interface SqliteRunResult {
	readonly changes: number;
	readonly lastInsertRowid?: number | bigint;
}

interface SqliteStatement {
	all(...params: readonly unknown[]): unknown[];
	get(...params: readonly unknown[]): unknown;
	run(...params: readonly unknown[]): SqliteRunResult;
}

interface SqliteDatabase {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): void;
	loadExtension?(path: string): void;
	close(): void;
}

const require = createRequire(import.meta.url);
const Database = (
	typeof (globalThis as Record<string, unknown>).Bun !== "undefined"
		? require("bun:sqlite").Database
		: (() => {
				try {
					return require("node:sqlite").DatabaseSync;
				} catch {
					return require("better-sqlite3");
				}
			})()
) as new (
	path: string,
	options?: Record<string, unknown>,
) => SqliteDatabase;

export function runDbOwnerWorker(): void {
	const dbPath = process.env.SIGNET_DB_OWNER_DB_PATH;
	if (dbPath === undefined) throw new Error("DB owner requires SIGNET_DB_OWNER_DB_PATH");
	const ownerDbPath = dbPath;
	const parentPid = process.ppid;
	const parentWatch = setInterval(() => {
		// A test harness can disappear without sending the protocol shutdown
		// command. Do not let its owner survive as an orphan indefinitely.
		if (process.ppid !== parentPid) process.exit(0);
	}, 250);
	parentWatch.unref();

	const db = new Database(dbPath);
	db.exec("PRAGMA busy_timeout = 5000");
	const vecExtension = findSqliteVecExtension();
	if (vecExtension !== null) {
		if (typeof db.loadExtension !== "function") throw new Error("SQLite loadExtension API unavailable");
		db.loadExtension(vecExtension);
	}

	const BUSY_RETRIES = 3;
	const BUSY_BACKOFF_MS = 50;
	const isBusyError = (error: unknown): boolean => {
		const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
		const message = error instanceof Error ? error.message : String(error);
		return code === "SQLITE_BUSY" || message.includes("SQLITE_BUSY") || message.includes("database is locked");
	};
	const wait = (milliseconds: number): void => {
		const signal = new Int32Array(new SharedArrayBuffer(4));
		Atomics.wait(signal, 0, 0, milliseconds);
	};
	const withBusyRetry = <Result>(operation: () => Result): Result => {
		for (let attempt = 0; ; attempt += 1) {
			try {
				db.exec("BEGIN IMMEDIATE");
				const result = operation();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// Preserve the original SQLite error.
				}
				if (!isBusyError(error) || attempt >= BUSY_RETRIES) throw error;
				wait(BUSY_BACKOFF_MS * 2 ** attempt);
			}
		}
	};

	const cancelled = new Set<string>();
	const queue: DbOwnerJob[] = [];
	let activeJobId: string | null = null;
	let draining = false;

	function send(event: DbOwnerEvent): void {
		process.stdout.write(`${JSON.stringify(event)}\n`);
	}

	function bindParameter(value: DbOwnerParameter): unknown {
		if (typeof value === "object" && value !== null && value.type === "bytes") {
			return Buffer.from(value.base64, "base64");
		}
		return value;
	}

	function resultLimitError(name: string, message: string): Error {
		const error = new Error(message);
		error.name = name;
		return error;
	}

	function enforceResultLimit(statement: DbOwnerStatement, value: unknown): unknown {
		const maxResultBytes = statement.maxResultBytes ?? DB_OWNER_MAX_RESULT_BYTES;
		if (!Number.isInteger(maxResultBytes) || maxResultBytes <= 0 || maxResultBytes > DB_OWNER_MAX_RESULT_BYTES) {
			throw resultLimitError(
				"DB_OWNER_RESULT_LIMIT_INVALID",
				`DB owner maxResultBytes must be an integer from 1 to ${DB_OWNER_MAX_RESULT_BYTES}`,
			);
		}
		const serialized = JSON.stringify(value) ?? "null";
		const resultBytes = Buffer.byteLength(serialized, "utf8");
		if (resultBytes > maxResultBytes) {
			throw resultLimitError(
				"DB_OWNER_RESULT_TOO_LARGE",
				`DB owner result is ${resultBytes} bytes, above the ${maxResultBytes}-byte limit; page the query or reduce its columns`,
			);
		}
		return value;
	}

	function executeStatement(statement: DbOwnerStatement): unknown {
		const params = (statement.params ?? []).map(bindParameter);
		const prepared = db.prepare(statement.sql);
		if (statement.result === "all") return enforceResultLimit(statement, prepared.all(...params));
		if (statement.result === "get") return enforceResultLimit(statement, prepared.get(...params));
		if (statement.transactional === false) return enforceResultLimit(statement, prepared.run(...params));

		return withBusyRetry(() => enforceResultLimit(statement, prepared.run(...params)));
	}

	function executeTransaction(statements: readonly DbOwnerStatement[]): readonly unknown[] {
		if (statements.length === 0 || statements.length > DB_OWNER_MAX_TRANSACTION_STATEMENTS) {
			throw new Error(`DB owner transaction must contain 1 to ${DB_OWNER_MAX_TRANSACTION_STATEMENTS} statements`);
		}
		return withBusyRetry(() => {
			const results = statements.map((statement) => executeStatement({ ...statement, transactional: false }));
			return enforceResultLimit({ sql: "DB_OWNER_TRANSACTION", result: "all" }, results) as readonly unknown[];
		});
	}

	function executeBatch(statements: readonly DbOwnerStatement[], requireChanges: boolean): readonly unknown[] {
		if (statements.length === 0) throw new Error("DB owner batch must contain at least one statement");
		db.exec("BEGIN IMMEDIATE");
		try {
			const results: unknown[] = [];
			for (const statement of statements) {
				if (statement.result !== "run") throw new Error("DB owner batches only support run statements");
				const result = executeStatementWithoutTransaction(statement);
				if ((requireChanges || statement.requireChanges === true) && result.changes === 0) {
					const error = new Error("DB owner batch precondition changed zero rows");
					error.name = "DB_OWNER_NO_CHANGES";
					throw error;
				}
				results.push(result);
			}
			db.exec("COMMIT");
			return enforceResultLimit({ sql: "db-owner-batch", result: "all" }, results) as readonly unknown[];
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// The original error is the actionable failure.
			}
			throw error;
		}
	}

	function executeStatementWithoutTransaction(statement: DbOwnerStatement): SqliteRunResult {
		const params = (statement.params ?? []).map(bindParameter);
		return db.prepare(statement.sql).run(...params);
	}

	function executeSourceSnapshotImport(
		job: Extract<DbOwnerJob["request"], { readonly kind: "source_snapshot_import" }>,
	): unknown {
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = applySourceSnapshotImportInTx(db as unknown as BunDatabase, job.input);
			db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// The original error is the actionable failure.
			}
			throw error;
		}
	}

	function executeSourceArtifactUpsert(
		request: Extract<
			DbOwnerJob["request"],
			{ readonly kind: "source_artifact_upsert" | "source_artifact_upsert_batch" }
		>,
	): { readonly upserted: number } {
		const inputs = request.kind === "source_artifact_upsert" ? [request.input] : request.input;
		if (inputs.length === 0 || inputs.length > 50) throw new Error("DB owner artifact batch must contain 1 to 50 rows");
		db.exec("BEGIN IMMEDIATE");
		try {
			for (const input of inputs) {
				upsertMemoryArtifactInTx(db as unknown as BunDatabase, input.fields, {
					conflictGuardSourceId: input.conflictGuardSourceId,
				});
			}
			db.exec("COMMIT");
			return { upserted: inputs.length };
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// The original error is the actionable failure.
			}
			throw error;
		}
	}

	function executeSourceGraph(
		request: Extract<
			DbOwnerJob["request"],
			{ readonly kind: "source_graph_index" | "source_graph_file_purge" | "source_graph_purge" }
		>,
	): unknown {
		db.exec("BEGIN IMMEDIATE");
		try {
			let result: unknown;
			if (request.kind === "source_graph_index") {
				const markdownPathIndex =
					request.input.markdownPaths === undefined
						? undefined
						: buildObsidianMarkdownPathIndex(request.input.root, request.input.markdownPaths);
				result = applyObsidianSourceStructureInTx(db as unknown as import("./db-accessor").WriteDb, {
					...request.input,
					markdownPathIndex,
				});
			} else if (request.kind === "source_graph_file_purge") {
				result = purgeObsidianSourceFileStructureInTx(db as unknown as import("./db-accessor").WriteDb, request.input);
			} else {
				result = applyObsidianSourceStructurePurgeInTx(db as unknown as import("./db-accessor").WriteDb, request.input);
			}
			db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// The original error is the actionable failure.
			}
			throw error;
		}
	}

	let recallAccessorReady = false;

	async function executeRecall(payload: DbOwnerRecallPayload): Promise<unknown> {
		if (process.env.SIGNET_DB_OWNER_RECALL_WORKER !== "1") {
			throw new Error("DB owner recall jobs require a recall worker");
		}
		if (!recallAccessorReady) {
			const { initDbAccessorAsync } = await import("./db-accessor");
			await initDbAccessorAsync(ownerDbPath);
			recallAccessorReady = true;
		}
		const { getDbAccessor } = await import("./db-accessor");
		const { resolveActiveEmbeddingConfig } = await import("./embedding-index-state");
		const { hybridRecall } = await import("./memory-search");
		const config = payload.config as Parameters<typeof hybridRecall>[1];
		const agentId = payload.agentId ?? (await import("./agent-id")).resolveDaemonAgentId();
		if (config.pipelineV2.reranker.enabled && config.pipelineV2.reranker.useExtractionModel) {
			const { resolveDefaultBasePath } = await import("@signet/core");
			const { getOrCreateInferenceRouter } = await import("./inference-router");
			const { initInferenceProviderResolver } = await import("./llm");
			const router = getOrCreateInferenceRouter(resolveDefaultBasePath());
			initInferenceProviderResolver((workload) => {
				switch (workload) {
					case "memoryExtraction":
						return router.createWorkloadProvider("memory_extraction", agentId);
					case "sessionSynthesis":
						return router.createWorkloadProvider("session_synthesis", agentId);
					case "aggregateRecall":
						return router.createWorkloadProvider("aggregate_recall", agentId);
					case "widgetGeneration":
						return router.createWorkloadProvider("widget_generation", agentId);
					case "repair":
						return router.createWorkloadProvider("repair", agentId);
					case "interactive":
						return router.createWorkloadProvider("interactive", agentId);
					case "default":
						return router.createWorkloadProvider("default", agentId);
				}
			});
		}
		const embedding = await getDbAccessor().withReadDbAsync(async (db) =>
			resolveActiveEmbeddingConfig(db, config.embedding),
		);
		const query = payload.query;
		const queryEmbedding =
			payload.queryEmbedding !== undefined
				? payload.queryEmbedding
				: query === undefined
					? null
					: await (async () => {
							const { fetchEmbedding } = await import("./embedding-fetch");
							return await fetchEmbedding(query, embedding, "query", {
								usage: { source: "recall", agentId },
							});
						})();
		return await hybridRecall(
			payload.params as Parameters<typeof hybridRecall>[0],
			{ ...config, embedding },
			async () => (queryEmbedding === null ? null : queryEmbedding === undefined ? null : [...queryEmbedding]),
		);
	}

	async function executeInitialization(agentsDir: string | undefined): Promise<unknown> {
		const startedMarker = process.env.SIGNET_DB_OWNER_TEST_INIT_STARTED;
		const releaseMarker = process.env.SIGNET_DB_OWNER_TEST_INIT_RELEASE;
		if (startedMarker !== undefined && releaseMarker !== undefined) {
			writeFileSync(startedMarker, "started\n");
			while (!existsSync(releaseMarker)) await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const { initDbAccessorAsync } = await import("./db-accessor");
		await initDbAccessorAsync(ownerDbPath, { agentsDir });
		return { initialized: true };
	}

	async function execute(job: DbOwnerJob): Promise<unknown> {
		if (job.request.kind === "initialize") return await executeInitialization(job.request.agentsDir);
		if (job.request.kind === "query") return executeStatement(job.request.statement);
		if (job.request.kind === "transaction") return executeTransaction(job.request.transaction.statements);
		if (job.request.kind === "batch") return executeBatch(job.request.statements, job.request.requireChanges === true);
		if (job.request.kind === "source_snapshot_import") return executeSourceSnapshotImport(job.request);
		if (job.request.kind === "source_artifact_upsert" || job.request.kind === "source_artifact_upsert_batch")
			return executeSourceArtifactUpsert(job.request);
		if (
			job.request.kind === "source_graph_index" ||
			job.request.kind === "source_graph_file_purge" ||
			job.request.kind === "source_graph_purge"
		)
			return executeSourceGraph(job.request);
		if (job.request.kind === "recall") return await executeRecall(job.request.payload);
		const durationMs = Math.max(0, Math.floor(job.request.durationMs));
		const wait = new Int32Array(new SharedArrayBuffer(4));
		Atomics.wait(wait, 0, 0, durationMs);
		return { sleptMs: durationMs };
	}

	function result(jobId: string, outcome: "completed" | "cancelled" | "timed_out", value?: unknown): void {
		send({ type: "result", jobId, outcome, ...(value === undefined ? {} : { result: value }) });
	}

	function failed(jobId: string, name: string, message: string): void {
		send({ type: "result", jobId, outcome: "failed", error: { name, message } });
	}

	function runNext(): void {
		if (draining) return;
		draining = true;
		const next = async (): Promise<void> => {
			const job = queue.shift();
			if (job === undefined) {
				draining = false;
				return;
			}
			activeJobId = job.id;
			try {
				if (cancelled.delete(job.id)) {
					result(job.id, "cancelled");
				} else if (Date.now() >= job.deadlineAt) {
					result(job.id, "timed_out");
				} else {
					result(job.id, "completed", await execute(job));
				}
			} catch (error) {
				send({ type: "result", jobId: job.id, outcome: "failed", error: serializeError(error) });
			} finally {
				activeJobId = null;
				setImmediate(() => void next());
			}
		};
		setImmediate(() => void next());
	}

	function handle(command: DbOwnerCommand): void {
		if (command.type === "shutdown") {
			clearInterval(parentWatch);
			db.close();
			process.exit(0);
		}
		if (command.type === "cancel") {
			cancelled.add(command.jobId);
			return;
		}
		if (command.job.deadlineAt - command.job.enqueuedAt > DB_OWNER_MAX_DEADLINE_MS) {
			failed(command.job.id, "DB_OWNER_WORK_BUDGET", `DB owner deadline exceeds ${DB_OWNER_MAX_DEADLINE_MS}ms`);
			return;
		}
		if (
			!Number.isFinite(command.job.estimatedWorkUnits) ||
			command.job.estimatedWorkUnits < 0 ||
			command.job.estimatedWorkUnits > DB_OWNER_MAX_WORK_UNITS
		) {
			failed(command.job.id, "DB_OWNER_WORK_BUDGET", `DB owner work budget exceeds ${DB_OWNER_MAX_WORK_UNITS} units`);
			return;
		}
		if (queue.length >= DB_OWNER_MAX_QUEUE_DEPTH) {
			failed(command.job.id, "DB_OWNER_QUEUE_FULL", `DB owner queue is full at ${DB_OWNER_MAX_QUEUE_DEPTH} jobs`);
			return;
		}
		queue.push(command.job);
		runNext();
	}

	let input = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		input += chunk;
		const lines = input.split("\n");
		input = lines.pop() ?? "";
		for (const line of lines) {
			if (line.length === 0) continue;
			try {
				handle(JSON.parse(line) as DbOwnerCommand);
			} catch (error) {
				send({ type: "fatal", error: serializeError(error) });
				process.exitCode = 1;
			}
		}
	});

	send({ type: "ready", pid: process.pid });
	void activeJobId;
}

const entrypoint = process.argv[1] ?? "";
if (
	process.env.SIGNET_DB_OWNER_DB_PATH !== undefined &&
	(entrypoint.endsWith("db-owner-worker.ts") ||
		entrypoint.endsWith("db-owner-worker.js") ||
		entrypoint.endsWith("db-owner-worker.mjs"))
) {
	runDbOwnerWorker();
}
