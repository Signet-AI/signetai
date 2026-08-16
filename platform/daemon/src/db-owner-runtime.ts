import { stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveSqliteAgentsDir } from "./db-accessor";
import {
	createDbOwnerClient,
	DbOwnerAdmissionError,
	type DbOwnerClient,
	type DbOwnerSubmitOptions,
} from "./db-owner-client";
import { getDbOwnerMaintenance } from "./db-owner-maintenance";
import type {
	DbOwnerParameter,
	DbOwnerSourceGraphFilePurge,
	DbOwnerSourceGraphIndex,
	DbOwnerSourceGraphPurge,
	DbOwnerSourceSnapshotImport,
	DbOwnerSourceArtifactUpsert,
	DbOwnerStatement,
} from "./db-owner-protocol";

let client: DbOwnerClient | null = null;
let startPromise: Promise<DbOwnerClient> | null = null;
let clientDbPath: string | null = null;
let clientDbIdentity: string | null = null;
let startClient: DbOwnerClient | null = null;

async function dbIdentity(dbPath: string): Promise<string> {
	try {
		const metadata = await stat(dbPath);
		return `${metadata.dev}:${metadata.ino}`;
	} catch {
		return dbPath;
	}
}

/** Start the single process DB owner used by category migrations. */
export async function startDbOwner(
	dbPath = join(resolveSqliteAgentsDir(), "memory", "memories.db"),
): Promise<DbOwnerClient> {
	const identity = await dbIdentity(dbPath);
	if (
		client !== null &&
		(clientDbPath !== dbPath ||
			clientDbIdentity !== identity ||
			client.health().state === "closed" ||
			client.health().state === "dead" ||
			client.health().state === "failed")
	) {
		const previous = client;
		client = null;
		clientDbPath = null;
		clientDbIdentity = null;
		if (startClient === previous) {
			startPromise = null;
			startClient = null;
		}
		await previous.close();
	}
	if (client === null) client = createDbOwnerClient({ dbPath });
	clientDbPath = dbPath;
	clientDbIdentity = identity;
	if (startPromise !== null && startClient === client) return await startPromise;
	const owner = client;
	const pendingStart = owner.start().then(() => owner);
	startPromise = pendingStart;
	startClient = owner;
	try {
		return await pendingStart;
	} finally {
		if (startPromise === pendingStart) {
			startPromise = null;
			startClient = null;
		}
	}
}

/** Lazily start an isolated owner when the daemon has not registered its shared owner. */
export async function getDbOwner(): Promise<DbOwnerClient> {
	const registered = getDbOwnerMaintenance()?.owner;
	if (registered !== undefined) return registered;
	return await startDbOwner();
}

export interface DbOwnerSqlOptions {
	readonly operation: string;
	readonly lane?: "read" | "write" | "maintenance";
	readonly deadlineMs?: number;
	readonly estimatedWorkUnits?: number;
}

function submitOptions(options: DbOwnerSqlOptions): DbOwnerSubmitOptions {
	return {
		operation: options.operation,
		lane: options.lane ?? "write",
		deadlineMs: options.deadlineMs ?? 5_000,
		estimatedWorkUnits: options.estimatedWorkUnits,
	};
}

async function submitWithAdmission<Result>(
	owner: DbOwnerClient,
	request: Parameters<DbOwnerClient["submit"]>[0],
	options: DbOwnerSqlOptions,
): Promise<Result> {
	const submit = submitOptions(options);
	const deadlineAt = Date.now() + submit.deadlineMs;
	for (;;) {
		try {
			const handle = owner.submit<Result>(request, submit);
			return await owner.awaitResult(handle);
		} catch (error) {
			if (!(error instanceof DbOwnerAdmissionError) || error.code !== "DB_OWNER_QUEUE_FULL") throw error;
			const remainingMs = deadlineAt - Date.now();
			if (remainingMs <= 0) throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remainingMs)));
		}
	}
}

export async function dbOwnerQuery<Row = unknown>(
	statement: DbOwnerStatement,
	options: DbOwnerSqlOptions,
): Promise<Row> {
	const owner = await getDbOwner();
	return await submitWithAdmission<Row>(
		owner,
		{ kind: "query", statement },
		{ ...options, lane: options.lane ?? "read" },
	);
}

export async function dbOwnerBatch(
	statements: readonly DbOwnerStatement[],
	options: DbOwnerSqlOptions,
): Promise<readonly unknown[]> {
	const owner = await getDbOwner();
	return await submitWithAdmission<readonly unknown[]>(owner, { kind: "batch", statements }, options);
}

export async function dbOwnerSourceSnapshotImport(
	input: DbOwnerSourceSnapshotImport,
	options: DbOwnerSqlOptions,
): Promise<{ readonly imported: number }> {
	const owner = await getDbOwner();
	return await submitWithAdmission<{ readonly imported: number }>(
		owner,
		{ kind: "source_snapshot_import", input },
		{ ...options, lane: options.lane ?? "write" },
	);
}

export async function dbOwnerSourceArtifactUpsert(
	input: DbOwnerSourceArtifactUpsert,
	options: DbOwnerSqlOptions,
): Promise<{ readonly upserted: number }> {
	const owner = await getDbOwner();
	return await submitWithAdmission<{ readonly upserted: number }>(
		owner,
		{ kind: "source_artifact_upsert", input },
		{ ...options, lane: options.lane ?? "write" },
	);
}

export async function dbOwnerSourceArtifactUpsertBatch(
	input: readonly DbOwnerSourceArtifactUpsert[],
	options: DbOwnerSqlOptions,
): Promise<{ readonly upserted: number }> {
	const owner = await getDbOwner();
	return await submitWithAdmission<{ readonly upserted: number }>(
		owner,
		{ kind: "source_artifact_upsert_batch", input },
		{ ...options, lane: options.lane ?? "write", estimatedWorkUnits: options.estimatedWorkUnits ?? input.length },
	);
}

export async function dbOwnerSourceGraphIndex(
	input: DbOwnerSourceGraphIndex,
	options: DbOwnerSqlOptions,
): Promise<unknown> {
	const owner = await getDbOwner();
	return await submitWithAdmission<unknown>(
		owner,
		{ kind: "source_graph_index", input },
		{ ...options, lane: options.lane ?? "write" },
	);
}

export async function dbOwnerSourceGraphFilePurge(
	input: DbOwnerSourceGraphFilePurge,
	options: DbOwnerSqlOptions,
): Promise<unknown> {
	const owner = await getDbOwner();
	return await submitWithAdmission<unknown>(
		owner,
		{ kind: "source_graph_file_purge", input },
		{ ...options, lane: options.lane ?? "write" },
	);
}

export async function dbOwnerSourceGraphPurge(
	input: DbOwnerSourceGraphPurge,
	options: DbOwnerSqlOptions,
): Promise<unknown> {
	const owner = await getDbOwner();
	return await submitWithAdmission<unknown>(
		owner,
		{ kind: "source_graph_purge", input },
		{ ...options, lane: options.lane ?? "write" },
	);
}

export function ownerStatement(
	sql: string,
	params: readonly DbOwnerParameter[] = [],
	result: "all" | "get" | "run" = "run",
): DbOwnerStatement {
	return { sql, params, result };
}

export async function closeDbOwner(): Promise<void> {
	const previous = client;
	client = null;
	clientDbPath = null;
	clientDbIdentity = null;
	startPromise = null;
	startClient = null;
	if (previous !== null) await previous.close();
}
