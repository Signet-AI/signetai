/**
 * Frozen daemon/DB-owner protocol.
 *
 * The daemon sends serializable jobs. The owner is the only process that
 * imports SQLite and executes synchronous statements. `lane` is deliberately
 * part of every job even though the first implementation has one owner. A
 * future transport can route read jobs to parallel readers and write or
 * maintenance jobs to the single writer without changing this contract.
 */

export type DbOwnerLane = "read" | "write" | "maintenance";
export type DbOwnerCancellation = "pending" | "requested" | "started";
export type DbOwnerOutcome = "completed" | "cancelled" | "timed_out" | "failed" | "owner_died";

export type DbOwnerParameter = string | number | boolean | null | { readonly type: "bytes"; readonly base64: string };

export interface DbOwnerStatement {
	readonly sql: string;
	readonly params?: readonly DbOwnerParameter[];
	readonly result: "all" | "get" | "run";
	readonly transactional?: boolean;
}

export type DbOwnerRequest =
	| { readonly kind: "query"; readonly statement: DbOwnerStatement }
	| { readonly kind: "sleep"; readonly durationMs: number };

export interface DbOwnerJob {
	readonly id: string;
	readonly operation: string;
	readonly lane: DbOwnerLane;
	readonly enqueuedAt: number;
	readonly deadlineAt: number;
	readonly estimatedWorkUnits: number;
	readonly cancellation: DbOwnerCancellation;
	readonly request: DbOwnerRequest;
}

export type DbOwnerCommand =
	| { readonly type: "submit"; readonly job: DbOwnerJob }
	| { readonly type: "cancel"; readonly jobId: string }
	| { readonly type: "shutdown" };

export interface DbOwnerSerializedError {
	readonly name: string;
	readonly message: string;
}

export type DbOwnerEvent =
	| { readonly type: "ready"; readonly pid: number }
	| {
			readonly type: "result";
			readonly jobId: string;
			readonly outcome: DbOwnerOutcome;
			readonly result?: unknown;
			readonly error?: DbOwnerSerializedError;
	  }
	| { readonly type: "fatal"; readonly error: DbOwnerSerializedError };

export function serializeError(error: unknown): DbOwnerSerializedError {
	return {
		name: error instanceof Error ? error.name : "Error",
		message: error instanceof Error ? error.message : String(error),
	};
}
