import type { DbOwnerClient } from "./db-owner-client";
import { ownerRun } from "./db-owner-sql";

export const QUERY_PLANNER_ANALYSIS_LIMIT = 400;

interface ExecDb {
	exec(sql: string): unknown;
}

export function refreshQueryPlannerStatisticsOnOpen(db: ExecDb): void {
	db.exec(`PRAGMA analysis_limit = ${QUERY_PLANNER_ANALYSIS_LIMIT}`);
	db.exec("PRAGMA optimize = 0x10002");
}

export async function refreshQueryPlannerStatisticsThroughOwner(owner: DbOwnerClient): Promise<void> {
	await ownerRun(owner, `PRAGMA analysis_limit = ${QUERY_PLANNER_ANALYSIS_LIMIT}`, [], {
		operation: "maintenance.query-planner.analysis-limit",
		lane: "maintenance",
		deadlineMs: 60_000,
	});
	await ownerRun(owner, "PRAGMA optimize", [], {
		operation: "maintenance.query-planner.optimize",
		lane: "maintenance",
		deadlineMs: 60_000,
	});
}
