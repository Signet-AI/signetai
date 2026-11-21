import { dbOwnerBatch, dbOwnerQuery, ownerStatement } from "../../../db/owner/runtime";
import type { NativeMemorySource } from "./provider";

export type NativeSourceSyncStatus = "running" | "paused";

export interface NativeSourceSyncState {
	readonly agentId: string;
	readonly sourceKey: string;
	readonly sourceRoot: string;
	readonly status: NativeSourceSyncStatus;
	readonly checkpointPath: string | null;
	readonly pauseReason: string | null;
}

interface NativeSourceSyncStateRow {
	readonly agent_id: string;
	readonly source_key: string;
	readonly source_root: string;
	readonly status: NativeSourceSyncStatus;
	readonly checkpoint_path: string | null;
	readonly pause_reason: string | null;
}

export function nativeSourceSyncKey(source: Pick<NativeMemorySource, "harness" | "root" | "sourceId">): string {
	return source.sourceId ?? `${source.harness}:${source.root.replace(/\\/g, "/").replace(/\/$/, "")}`;
}

function normalizedSourceRoot(root: string): string {
	return root.replace(/\\/g, "/").replace(/\/$/, "");
}

export async function readNativeSourceSyncState(
	agentId: string,
	source: Pick<NativeMemorySource, "harness" | "root" | "sourceId">,
	signal?: AbortSignal,
): Promise<NativeSourceSyncState | null> {
	const sourceKey = nativeSourceSyncKey(source);
	const row = await dbOwnerQuery<NativeSourceSyncStateRow | null>(
		ownerStatement(
			`SELECT agent_id, source_key, source_root, status, checkpoint_path, pause_reason
			 FROM native_source_sync_state
			 WHERE agent_id = ? AND source_key = ?`,
			[agentId, sourceKey],
			"get",
		),
		{ operation: "sources.sync-state.read", lane: "read", signal },
	);
	if (row === null || normalizedSourceRoot(row.source_root) !== normalizedSourceRoot(source.root)) return null;
	return {
		agentId: row.agent_id,
		sourceKey: row.source_key,
		sourceRoot: row.source_root,
		status: row.status,
		checkpointPath: row.checkpoint_path,
		pauseReason: row.pause_reason,
	};
}

export async function persistNativeSourceSyncState(input: {
	readonly agentId: string;
	readonly source: Pick<NativeMemorySource, "harness" | "root" | "sourceId">;
	readonly status: NativeSourceSyncStatus;
	readonly checkpointPath?: string;
	readonly pauseReason?: string | null;
	readonly signal?: AbortSignal;
}): Promise<void> {
	const sourceKey = nativeSourceSyncKey(input.source);
	const now = new Date().toISOString();
	await dbOwnerBatch(
		[
			ownerStatement(
				`INSERT INTO native_source_sync_state
				 (agent_id, source_key, source_root, status, checkpoint_path, pause_reason, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(agent_id, source_key) DO UPDATE SET
				   source_root = excluded.source_root,
				   status = excluded.status,
				   checkpoint_path = COALESCE(excluded.checkpoint_path, native_source_sync_state.checkpoint_path),
				   pause_reason = excluded.pause_reason,
				   updated_at = excluded.updated_at`,
				[
					input.agentId,
					sourceKey,
					input.source.root,
					input.status,
					input.checkpointPath ?? null,
					input.pauseReason ?? null,
					now,
				],
			),
		],
		{ operation: "sources.sync-state.persist", lane: "write", estimatedWorkUnits: 1, signal: input.signal },
	);
}

export async function clearNativeSourceSyncCheckpoint(input: {
	readonly agentId: string;
	readonly source: Pick<NativeMemorySource, "harness" | "root" | "sourceId">;
	readonly signal?: AbortSignal;
}): Promise<void> {
	const sourceKey = nativeSourceSyncKey(input.source);
	await dbOwnerBatch(
		[
			ownerStatement(
				`UPDATE native_source_sync_state
				 SET status = 'running', checkpoint_path = NULL, pause_reason = NULL, updated_at = ?
				 WHERE agent_id = ? AND source_key = ?`,
				[new Date().toISOString(), input.agentId, sourceKey],
			),
		],
		{ operation: "sources.sync-state.complete", lane: "write", estimatedWorkUnits: 1, signal: input.signal },
	);
}
