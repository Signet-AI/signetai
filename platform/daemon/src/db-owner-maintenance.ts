import { DbOwnerDiedError, type DbOwnerClient, type DbOwnerJobHandle } from "./db-owner-client";
import type { DbOwnerParameter, DbOwnerRequest, DbOwnerStatement } from "./db-owner-protocol";

export interface DbOwnerMaintenanceOptions {
	readonly deadlineMs?: number;
	readonly estimatedWorkUnits?: number;
}

const DEFAULT_DEADLINE_MS = 5_000;

function submitOptions(
	operation: string,
	lane: "read" | "write" | "maintenance",
	options: DbOwnerMaintenanceOptions,
): {
	readonly operation: string;
	readonly lane: "read" | "write" | "maintenance";
	readonly deadlineMs: number;
	readonly estimatedWorkUnits?: number;
} {
	return {
		operation,
		lane,
		deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
		estimatedWorkUnits: options.estimatedWorkUnits,
	};
}

async function runOwnerJob<Result>(
	owner: DbOwnerClient,
	request: DbOwnerRequest,
	operation: string,
	lane: "read" | "write" | "maintenance",
	options: DbOwnerMaintenanceOptions = {},
): Promise<Result> {
	const handle: DbOwnerJobHandle<Result> = owner.submit<Result>(request, submitOptions(operation, lane, options));
	return await handle.result;
}

/** Run an idempotent maintenance request once more after an owner crash. */
export async function runOwnerMaintenanceWithRetry<Result>(
	owner: DbOwnerClient,
	request: DbOwnerRequest,
	operation: string,
	options: DbOwnerMaintenanceOptions = {},
): Promise<Result> {
	try {
		return await runOwnerJob(owner, request, operation, "maintenance", options);
	} catch (error) {
		if (!(error instanceof DbOwnerDiedError)) throw error;
		await owner.start();
		return await runOwnerJob(owner, request, operation, "maintenance", options);
	}
}

export async function ownerQueryAll<Row extends object>(
	owner: DbOwnerClient,
	operation: string,
	sql: string,
	params: readonly DbOwnerParameter[] = [],
	options: DbOwnerMaintenanceOptions = {},
): Promise<readonly Row[]> {
	return await runOwnerMaintenanceWithRetry<readonly Row[]>(
		owner,
		{ kind: "query", statement: { sql, params, result: "all" } },
		operation,
		options,
	);
}

export async function ownerQueryOne<Row extends object>(
	owner: DbOwnerClient,
	operation: string,
	sql: string,
	params: readonly DbOwnerParameter[] = [],
	options: DbOwnerMaintenanceOptions = {},
): Promise<Row | undefined> {
	const result = await runOwnerMaintenanceWithRetry<Row | null | undefined>(
		owner,
		{ kind: "query", statement: { sql, params, result: "get" } },
		operation,
		options,
	);
	return result ?? undefined;
}

export async function ownerTransaction(
	owner: DbOwnerClient,
	operation: string,
	statements: readonly DbOwnerStatement[],
	options: DbOwnerMaintenanceOptions = {},
): Promise<readonly unknown[]> {
	return await runOwnerMaintenanceWithRetry<readonly unknown[]>(
		owner,
		{ kind: "transaction", transaction: { statements } },
		operation,
		options,
	);
}

export function ownerRunStatement(sql: string, params: readonly DbOwnerParameter[] = []): DbOwnerStatement {
	return { sql, params, result: "run" };
}

export function ownerChanges(result: unknown): number {
	if (typeof result !== "object" || result === null || !("changes" in result)) return 0;
	const changes = result.changes;
	return typeof changes === "number" && Number.isFinite(changes) ? changes : 0;
}
