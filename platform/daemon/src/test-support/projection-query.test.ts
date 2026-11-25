import type { ReadDb } from "../db-accessor";
import { getDbOwnerForAccessor } from "../db-owner-runtime";
import { loadProjectionRowsAsync } from "../embedding-projection-owner";
import { computeProjectionFromRows, type ProjectionQuery } from "../umap-projection";

export async function computeProjectionForQuery(db: ReadDb, dimensions: 2 | 3, query: ProjectionQuery) {
	const accessor = {
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn(db);
		},
		async withReadDbAsync<T>(fn: (db: ReadDb) => T | Promise<T>): Promise<T> {
			return await fn(db);
		},
		withWriteTx<T>(fn: (db: ReadDb) => T): T {
			return fn(db);
		},
		close() {},
	};
	const loaded = await loadProjectionRowsAsync(await getDbOwnerForAccessor(accessor), {
		...query,
		scope: query.scope ?? { reach: { kind: "all" }, compartments: "all", projects: null },
	});
	return {
		result: computeProjectionFromRows(loaded.rows, dimensions),
		total: loaded.total,
		count: loaded.rows.length,
		limit: loaded.limit,
		offset: loaded.offset,
		hasMore: loaded.hasMore,
	};
}
