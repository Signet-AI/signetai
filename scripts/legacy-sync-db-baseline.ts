#!/usr/bin/env bun
import { resolve } from "node:path";
import { countLegacyDbAccess, writeCountBaseline } from "./audit-event-loop-contract";

const counts = countLegacyDbAccess(resolve("platform/daemon/src"));
writeCountBaseline(counts);
console.log(
	`legacy-sync-db-baseline.json updated: ${counts.total} marked callsites ` +
		`(${counts.withReadDb} withReadDb, ${counts.withWriteTx} withWriteTx)`,
);
