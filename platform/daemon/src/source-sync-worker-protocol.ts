import type { SignetSourceEntry } from "@signet/core";
import type { DbOwnerSubmitOptions } from "./db-owner-client";
import type { DbOwnerRequest, DbOwnerSerializedError } from "./db-owner-protocol";
import type { LogEntry } from "./logger";
import type { SourceProviderProgressEvent, SourceProviderSyncResult } from "./source-providers";

export const SOURCE_SYNC_WORKER_PROTOCOL_VERSION = 1;
export const SOURCE_SYNC_WORKER_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const SOURCE_SYNC_WORKER_MAX_ERROR_CHARS = 16 * 1024;
export const SOURCE_SYNC_WORKER_MAX_OWNER_JOBS = 8;
export const SOURCE_SYNC_WORKER_OWNER_REQUESTS: ReadonlySet<DbOwnerRequest["kind"]> = new Set<DbOwnerRequest["kind"]>([
	"query",
	"batch",
	"transaction",
	"source_artifact_upsert",
	"source_artifact_upsert_batch",
	"source_artifact_index",
	"source_artifact_purge",
]);

export interface SourceSyncWorkerJob {
	readonly source: SignetSourceEntry;
	readonly agentsDir: string;
	readonly agentId: string;
}

export type SourceSyncHostMessage =
	| { readonly type: "sync"; readonly job: SourceSyncWorkerJob }
	| { readonly type: "cancel" }
	| { readonly type: "owner_result"; readonly id: string; readonly result: unknown }
	| { readonly type: "owner_error"; readonly id: string; readonly error: DbOwnerSerializedError }
	| { readonly type: "secret_result"; readonly id: string; readonly value: string }
	| { readonly type: "secret_error"; readonly id: string; readonly message: string };

export type SourceSyncWorkerMessage =
	| { readonly type: "ready"; readonly threadId: number }
	| { readonly type: "progress"; readonly event: SourceProviderProgressEvent }
	| {
			readonly type: "owner_submit";
			readonly id: string;
			readonly request: DbOwnerRequest;
			readonly options: DbOwnerSubmitOptions;
	  }
	| { readonly type: "owner_cancel"; readonly id: string }
	| { readonly type: "secret"; readonly id: string; readonly name: string }
	| { readonly type: "log"; readonly entry: LogEntry }
	| { readonly type: "result"; readonly result: SourceProviderSyncResult }
	| { readonly type: "error"; readonly message: string };

type SourceSyncFrame = (SourceSyncHostMessage | SourceSyncWorkerMessage) & { readonly version: number };

export function boundedErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length <= SOURCE_SYNC_WORKER_MAX_ERROR_CHARS
		? message
		: message.slice(0, SOURCE_SYNC_WORKER_MAX_ERROR_CHARS);
}

export function sourceSyncFrameBytes(message: SourceSyncHostMessage | SourceSyncWorkerMessage): number {
	return Buffer.byteLength(JSON.stringify({ version: SOURCE_SYNC_WORKER_PROTOCOL_VERSION, ...message }), "utf8");
}

export function postSourceSyncFrame(
	port: { postMessage(value: unknown): void },
	message: SourceSyncHostMessage | SourceSyncWorkerMessage,
): void {
	port.postMessage({ version: SOURCE_SYNC_WORKER_PROTOCOL_VERSION, ...message } satisfies SourceSyncFrame);
}

export function decodeSourceSyncFrame<Message extends SourceSyncHostMessage | SourceSyncWorkerMessage>(
	value: unknown,
): Message | null {
	if (typeof value !== "object" || value === null) return null;
	const frame = value as { readonly version?: unknown; readonly type?: unknown };
	if (frame.version !== SOURCE_SYNC_WORKER_PROTOCOL_VERSION || typeof frame.type !== "string") return null;
	return value as Message;
}

export function serializeOwnerError(error: unknown): DbOwnerSerializedError {
	if (error instanceof Error) {
		const owner = error as Error & {
			readonly code?: string | number;
			readonly causeFamily?: DbOwnerSerializedError["causeFamily"];
			readonly sqliteCode?: string | number;
		};
		return {
			name: error.name,
			message: boundedErrorMessage(error),
			...(owner.code === undefined ? {} : { code: owner.code }),
			...(owner.causeFamily === undefined ? {} : { causeFamily: owner.causeFamily }),
			...(owner.sqliteCode === undefined ? {} : { sqliteCode: owner.sqliteCode }),
		};
	}
	return { name: "Error", message: boundedErrorMessage(error) };
}
