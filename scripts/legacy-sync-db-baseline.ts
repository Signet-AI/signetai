#!/usr/bin/env bun
/**
 * Regenerate scripts/legacy-sync-db-baseline.json — the committed snapshot of
 * the LEGACY_SYNC_DB_ACCESS marker count in platform/daemon/src.
 *
 * Run this only when the marker count has DECREASED and you are tightening the
 * ratchet in the same PR that removed the call sites. The ratchet never moves
 * up: if `bun scripts/audit-event-loop-contract.ts` fails with
 * "RATCHET FAIL: ... increased", the fix is converting the new call site to
 * withReadDbAsync/withWriteTxAsync, not bumping the baseline.
 */
import { resolve } from "node:path";
import { countLegacyDbAccess, writeCountBaseline } from "./audit-event-loop-contract";

const counts = countLegacyDbAccess(resolve("platform/daemon/src"));
writeCountBaseline(counts);
console.log(
	`legacy-sync-db-baseline.json updated: ${counts.total} marked callsites ` +
		`(${counts.withReadDb} withReadDb, ${counts.withWriteTx} withWriteTx)`,
);
