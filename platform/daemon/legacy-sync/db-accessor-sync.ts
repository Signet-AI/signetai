import { getDbAccessor } from "../src/db/owner/accessor";
import type { ReadDb, SyncDbCallSiteToken, WriteDb } from "../src/db/owner/accessor";

export interface SyncDbAccessor {
	withWriteTx<T>(fn: (db: WriteDb) => T, siteToken?: SyncDbCallSiteToken): T;
	withReadDb<T>(fn: (db: ReadDb) => T, siteToken?: SyncDbCallSiteToken): T;
	checkpointWal(): void;
	incrementalVacuum(): number;
	vacuumConversion(): boolean;
}
export function getSyncDbAccessor(): SyncDbAccessor {
	return getDbAccessor() as unknown as SyncDbAccessor;
}
