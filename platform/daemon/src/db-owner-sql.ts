import { z } from "zod";
import type { DbOwnerClient, DbOwnerJobHandle, DbOwnerSubmitOptions } from "./db-owner-client";
import type { DbOwnerParameter, DbOwnerRequest, DbOwnerWorkloadClass } from "./db-owner-protocol";

export interface DbOwnerRunResult {
	readonly changes: number;
	readonly lastInsertRowid?: number | bigint;
}

export interface DbOwnerSqlOptions {
	readonly operation: string;
	readonly lane?: "read" | "write" | "maintenance";
	readonly workloadClass?: DbOwnerWorkloadClass;
	readonly deadlineMs?: number;
	readonly estimatedWorkUnits?: number;
	readonly embeddingProjection?: import("./embedding-projection").EmbeddingProjectionRequest;
}

const compartmentParameter = z.object({
	type: z.literal("compartment"),
	scope: z.object({
		agentId: z.string().min(1),
		sessionKey: z.string().nullable().optional(),
		sourceId: z.string().nullable().optional(),
		memoryId: z.string().nullable().optional(),
		parentCompartment: z.number().int().positive().nullable().optional(),
	}),
	parentMemoryId: z.string().optional(),
});
function parameter(value: unknown): DbOwnerParameter {
	const scope = compartmentParameter.safeParse(value);
	if (scope.success) return scope.data;
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
		workloadClass: options.workloadClass,
		deadlineMs: options.deadlineMs ?? 30_000,
		estimatedWorkUnits: options.estimatedWorkUnits,
	});
	return handle.result;
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("DB owner request was cancelled");
}

export function cancellableOwner(owner: DbOwnerClient, signal: AbortSignal | undefined): DbOwnerClient {
	if (!signal) return owner;
	const cancellableSubmit = <Result>(
		request: DbOwnerRequest,
		options: DbOwnerSubmitOptions,
	): DbOwnerJobHandle<Result> => {
		if (signal.aborted) throw abortReason(signal);
		const handle = owner.submit<Result>(request, options);
		const cancel = (): void => handle.cancel();
		const release = (): void => signal.removeEventListener("abort", cancel);
		signal.addEventListener("abort", cancel, { once: true });
		const result = handle.result.catch((error: unknown) => {
			throw signal.aborted ? abortReason(signal) : error;
		});
		void result.then(release, release);
		if (signal.aborted) cancel();
		return { ...handle, result };
	};
	return new Proxy(owner, {
		get(target, key) {
			if (key === "submit") return cancellableSubmit;
			const value: unknown = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
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
		embeddingProjection: options.embeddingProjection,
	};
	return submit<readonly DbOwnerRunResult[]>(client, request, options);
}

export function ownerBytesFromHex(value: string): Uint8Array {
	const bytes = Buffer.from(value, "hex");
	if (bytes.byteLength * 2 !== value.length) throw new Error("DB owner returned an invalid hex blob");
	return new Uint8Array(bytes);
}
