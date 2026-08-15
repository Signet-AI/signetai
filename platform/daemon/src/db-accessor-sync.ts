/**
 * Test/bootstrap-only synchronous DB accessor surface.
 *
 * Production code must not import this module. The public `DbAccessor` type in
 * `db-accessor.ts` exposes only async primitives, and the event-loop contract
 * audit rejects production imports of this compatibility module.
 *
 * The two synchronous primitives remain available here for the narrowly-scoped
 * paths that cannot cross the async boundary yet:
 *
 * - pre-readiness bootstrap: initialise and repair the SQLite database before
 *   the daemon can serve requests;
 * - CLI-only: short-lived stdio processes that own their database lifecycle;
 * - isolated-worker: worker processes with a private database connection.
 *
 * This is a transitional surface. The A3 migration removes its callers and
 * this module after the legacy inventory reaches zero.
 */

import { getDbAccessor } from "./db-accessor";
import type { ReadDb, WriteDb } from "./db-accessor";

export interface SyncDbAccessor {
	/** @deprecated Use `withWriteTxAsync` in production code. */
	withWriteTx<T>(fn: (db: WriteDb) => T): T;
	/** @deprecated Use `withReadDbAsync` in production code. */
	withReadDb<T>(fn: (db: ReadDb) => T): T;
}

/** Return the compatibility surface for tests and explicitly approved bootstrap code. */
export function getSyncDbAccessor(): SyncDbAccessor {
	return getDbAccessor() as unknown as SyncDbAccessor;
}
