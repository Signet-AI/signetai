/**
 * Test/bootstrap-only synchronous DB accessor surface.
 *
 * Production code must not import this module. It intentionally lives outside
 * `src/`, while the daemon production project uses `src/` as its `rootDir` and
 * excludes this directory. A statically-resolved import therefore fails the
 * production TypeScript compile with TS6059 before any alias or computed member
 * can use the synchronous surface. The public `DbAccessor` type in
 * `db-accessor.ts` exposes only async primitives. The event-loop audit remains
 * belt-and-suspenders coverage for source-tree execution paths.
 *
 * The synchronous primitives remain available here for narrowly-scoped test,
 * bootstrap, CLI, and isolated-worker paths that cannot cross the async
 * boundary yet. The production accessor exposes none of these methods:
 * `withWriteTx`, `withReadDb`, `checkpointWal`, `incrementalVacuum`, and
 * `vacuumConversion`.
 *
 * - pre-readiness bootstrap: initialise and repair the SQLite database before
 *   the daemon can serve requests;
 * - CLI-only: short-lived stdio processes that own their database lifecycle;
 * - isolated-worker: worker processes with a private database connection.
 *
 * This is a transitional surface. The A3 migration removes its callers and
 * this module after the legacy inventory reaches zero.
 */

import { getDbAccessor } from "../src/db-accessor";
import type { ReadDb, WriteDb } from "../src/db-accessor";

export interface SyncDbAccessor {
	/** @deprecated Use `withWriteTxAsync` in production code. */
	withWriteTx<T>(fn: (db: WriteDb) => T): T;
	/** @deprecated Use `withReadDbAsync` in production code. */
	withReadDb<T>(fn: (db: ReadDb) => T): T;
	/** @deprecated Use `checkpointWalAsync` in production code. */
	checkpointWal(): void;
	/** @deprecated Use `incrementalVacuumAsync` in production code. */
	incrementalVacuum(): number;
	/** @deprecated Use `vacuumConversionAsync` in production code. */
	vacuumConversion(): boolean;
}

/** Return the compatibility surface for tests and explicitly approved bootstrap code. */
export function getSyncDbAccessor(): SyncDbAccessor {
	return getDbAccessor() as unknown as SyncDbAccessor;
}
