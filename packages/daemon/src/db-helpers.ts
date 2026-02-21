/**
 * Shared low-level DB helpers used across transaction and pipeline code.
 */

/** Serialize a numeric vector to a SQLite BLOB via Float32Array. */
export function vectorToBlob(vec: readonly number[]): Buffer {
	const f32 = new Float32Array(vec);
	return Buffer.from(f32.buffer.slice(0));
}

/**
 * Extract the `changes` count from a bun:sqlite run result.
 *
 * Note: bun:sqlite's `.changes` includes rows modified by triggers,
 * so for tables with FTS sync triggers the count may be inflated.
 * Use the SELECT-count pattern when an exact row count matters.
 */
export function countChanges(result: unknown): number {
	if (typeof result !== "object" || result === null) return 0;
	const row = result as { changes?: number };
	return typeof row.changes === "number" ? row.changes : 0;
}
