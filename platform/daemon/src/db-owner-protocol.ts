/**
 * Frozen daemon/DB-owner protocol.
 *
 * The daemon sends serializable jobs. The owner is the only process that
 * imports SQLite and executes synchronous statements. Read jobs run on an
 * independent reader owner while write and maintenance jobs share one serial
 * owner. `lane` selects that scheduling boundary.
 */

export type DbOwnerLane = "read" | "write" | "maintenance";
export const DB_OWNER_MAX_QUEUE_DEPTH = 64;
export const DB_OWNER_MAX_WORK_UNITS = 10_000;
export const DB_OWNER_MAX_DEADLINE_MS = 60_000;
export const DB_OWNER_MAX_RESULT_BYTES = 1_048_576;
export const DB_OWNER_MAX_TRANSACTION_STATEMENTS = 128;
export type DbOwnerCancellation = "pending" | "requested" | "started";
export type DbOwnerOutcome = "completed" | "cancelled" | "timed_out" | "failed" | "owner_died";

export type DbOwnerParameter = string | number | boolean | null | { readonly type: "bytes"; readonly base64: string };

export interface DbOwnerStatement {
	readonly sql: string;
	readonly params?: readonly DbOwnerParameter[];
	readonly result: "all" | "get" | "run";
	/** Maximum UTF-8 JSON payload for this result. The owner rejects larger results. */
	readonly maxResultBytes?: number;
	readonly transactional?: boolean;
	/** Abort a transaction when this run statement changes zero rows. */
	readonly requireChanges?: boolean;
}

export interface DbOwnerTransaction {
	readonly statements: readonly DbOwnerStatement[];
}

export type DbOwnerRequest =
	| { readonly kind: "query"; readonly statement: DbOwnerStatement }
	| { readonly kind: "transaction"; readonly transaction: DbOwnerTransaction }
	| {
			readonly kind: "batch";
			readonly statements: readonly DbOwnerStatement[];
			/** Abort a transaction when a run statement changes zero rows. */
			readonly requireChanges?: boolean;
	  }
	| {
			readonly kind: "recall";
			/** Serialized recall inputs. The owner reconstructs no daemon callbacks. */
			readonly payload: DbOwnerRecallPayload;
	  }
	| { readonly kind: "sleep"; readonly durationMs: number };

export interface DbOwnerRecallPayload {
	readonly params: unknown;
	readonly config: unknown;
	/** Resolved agent used for query-embedding usage attribution. */
	readonly agentId?: string;
	/** Original query used when the owner must compute its embedding. */
	readonly query?: string;
	/** Precomputed embedding for callers that already own the embedding boundary. */
	readonly queryEmbedding?: readonly number[] | null;
}

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

export type DbOwnerFailureCause = "provider_unavailable" | "internal_error";

export interface DbOwnerSerializedError {
	readonly name: string;
	readonly message: string;
	readonly causeFamily?: DbOwnerFailureCause;
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

function serializedCauseFamily(error: unknown): DbOwnerFailureCause | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const causeFamily = (error as Record<string, unknown>).causeFamily;
	if (causeFamily === "provider_unavailable" || causeFamily === "internal_error") return causeFamily;
	return undefined;
}

export function serializeError(error: unknown): DbOwnerSerializedError {
	const causeFamily = serializedCauseFamily(error);
	return {
		name: error instanceof Error ? error.name : "Error",
		message: error instanceof Error ? error.message : String(error),
		...(causeFamily === undefined ? {} : { causeFamily }),
	};
}
