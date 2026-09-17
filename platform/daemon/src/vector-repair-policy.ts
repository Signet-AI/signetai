import { VECTOR_REPAIR_MAX_BYTES_PER_BATCH, VECTOR_REPAIR_MAX_ROWS_PER_BATCH } from "./db-owner-protocol";

export function normalizeAgentId(agentId: string): string {
	const normalized = agentId.trim();
	if (normalized.length === 0) throw new Error("vector repair requires a resolved agent id");
	return normalized;
}

export function boundedBatchSize(value: number | undefined): number {
	if (value === undefined) return VECTOR_REPAIR_MAX_ROWS_PER_BATCH;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError("vector repair batch size must be positive");
	return Math.max(1, Math.min(VECTOR_REPAIR_MAX_ROWS_PER_BATCH, Math.floor(value)));
}

export function boundedVectorBytes(value: number | undefined): number {
	if (value === undefined) return VECTOR_REPAIR_MAX_BYTES_PER_BATCH;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError("vector repair byte budget must be positive");
	return Math.max(1, Math.min(VECTOR_REPAIR_MAX_BYTES_PER_BATCH, Math.floor(value)));
}
