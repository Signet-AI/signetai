/** Typed SQL helpers for work that must execute inside the DB owner process. */

import type { DbOwnerClient } from "./db-owner-client";
import type { DbOwnerParameter, DbOwnerRequest } from "./db-owner-protocol";

export interface DbOwnerRunResult {
	readonly changes: number;
	readonly lastInsertRowid?: number | bigint;
}

export interface DbOwnerSqlOptions {
	readonly operation: string;
	readonly lane?: "read" | "write" | "maintenance";
	readonly deadlineMs?: number;
	readonly estimatedWorkUnits?: number;
}

function parameter(value: unknown): DbOwnerParameter {
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
		return { type: "bytes", base64: Buffer.from(value).toString("base64") };
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
		return value;
	}
	throw new Error("DB owner parameters must be scalar values or byte buffers");
}

function submit<Result>(client: DbOwnerClient, request: DbOwnerRequest, options: DbOwnerSqlOptions): Promise<Result> {
	const handle = client.submit<Result>(request, {
		operation: options.operation,
		lane: options.lane ?? "maintenance",
		deadlineMs: options.deadlineMs ?? 30_000,
		estimatedWorkUnits: options.estimatedWorkUnits,
	});
	return handle.result;
}

export function ownerReadAll<Row extends object>(
	client: DbOwnerClient,
	sql: string,
	params: readonly unknown[] = [],
	options: DbOwnerSqlOptions,
): Promise<readonly Row[]> {
	return submit<readonly Row[]>(
		client,
		{ kind: "query", statement: { sql, params: params.map(parameter), result: "all" } },
		{ ...options, lane: "read" },
	);
}

export async function ownerReadOne<Row extends object>(
	client: DbOwnerClient,
	sql: string,
	params: readonly unknown[] = [],
	options: DbOwnerSqlOptions,
): Promise<Row | null> {
	const result = await submit<Row | null>(
		client,
		{ kind: "query", statement: { sql, params: params.map(parameter), result: "get" } },
		{ ...options, lane: "read" },
	);
	return result;
}

export function ownerRun(
	client: DbOwnerClient,
	sql: string,
	params: readonly unknown[] = [],
	options: DbOwnerSqlOptions,
): Promise<DbOwnerRunResult> {
	return submit<DbOwnerRunResult>(
		client,
		{ kind: "query", statement: { sql, params: params.map(parameter), result: "run" } },
		options,
	);
}

export function ownerBatch(
	client: DbOwnerClient,
	statements: readonly {
		readonly sql: string;
		readonly params?: readonly unknown[];
		readonly requireChanges?: boolean;
	}[],
	options: DbOwnerSqlOptions & { readonly requireChanges?: boolean },
): Promise<readonly DbOwnerRunResult[]> {
	const request: DbOwnerRequest = {
		kind: "batch",
		statements: statements.map((statement) => ({
			sql: statement.sql,
			params: statement.params?.map(parameter),
			result: "run",
			requireChanges: statement.requireChanges,
		})),
		requireChanges: options.requireChanges,
	};
	return submit<readonly DbOwnerRunResult[]>(client, request, options);
}

export function ownerBytesFromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/i.test(value)) throw new Error("DB owner returned an invalid vector blob");
	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < bytes.length; index++)
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	return bytes;
}
