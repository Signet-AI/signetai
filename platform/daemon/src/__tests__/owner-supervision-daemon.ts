import { getDbOwner } from "../db-owner-runtime";
import { prepareOwnerDaemonFixture } from "./isolated-owner-daemon-fixture";

const { root, endpoint } = await prepareOwnerDaemonFixture();
await import("../daemon");
const until = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
	const deadline = Date.now() + 10000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("Supervision fixture did not converge");
		await Bun.sleep(10);
	}
};
await until(async () => {
	try {
		const response = await fetch(`${endpoint}/health`);
		return response.ok && (await response.json()).status === "healthy";
	} catch {
		return false;
	}
});
const health = await (await fetch(`${endpoint}/health`)).json();
if (health.pid !== process.pid || health.agentsDir !== root) throw new Error("Wrong daemon");
const owner = await getDbOwner();
const runaway =
	"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT SUM(x) total FROM n";
await owner.submit(
	{ kind: "query", statement: { sql: "CREATE TABLE supervision_writes(id TEXT PRIMARY KEY)", result: "run" } },
	{ operation: "organization.supervision-setup", lane: "write", deadlineMs: 5000 },
).result;
const results = [];
for (const write of [false, true]) {
	const previous = owner.health();
	const active = owner.submit(
		write
			? {
					kind: "transaction",
					transaction: {
						statements: [
							{ sql: "INSERT INTO supervision_writes VALUES('partial')", result: "run" },
							{ sql: runaway, result: "get" },
						],
					},
				}
			: { kind: "query", statement: { sql: runaway, result: "get", readonly: true } },
		{ operation: "organization.supervision-runaway", lane: write ? "write" : "read", deadlineMs: 100 },
	);
	const expired = active.result.catch((error: unknown) =>
		error instanceof Error && "code" in error ? error.code : String(error),
	);
	await until(() => owner.health().activeJobId === active.job.id);
	const queued = owner
		.submit(
			{ kind: "query", statement: { sql: "SELECT 1 ok", result: "get", readonly: true } },
			{ operation: "organization.supervision-queued", lane: "read", deadlineMs: 5000 },
		)
		.result.catch((error: unknown) => (error instanceof Error && "code" in error ? error.code : String(error)));
	const queuedOutcome = await queued;
	const deadlineOutcome = await expired;
	if (queuedOutcome !== "owner_retired") {
		console.error(`SUPERVISION_FAILURE Expected owner_retired, received ${JSON.stringify(queuedOutcome)}`);
		throw new Error(`Expected owner_retired, received ${JSON.stringify(queuedOutcome)}`);
	}
	const retirement = owner.health();
	if (retirement.databaseReady) throw new Error("Retired generation still reports database ready");
	const degraded = await (await fetch(`${endpoint}/health`)).json();
	if (degraded.dbOwner?.databaseReady === false && (degraded.db || degraded.status !== "degraded"))
		throw new Error("Replacement reported healthy before database readiness");
	await until(
		() => owner.health().databaseReady && owner.health().state === "ready" && owner.health().pid !== previous.pid,
	);
	if (owner.health().generation <= previous.generation) throw new Error("Owner generation was not fenced");
	if (previous.pid !== null) {
		try {
			process.kill(previous.pid, 0);
			throw new Error("Retired owner still exists");
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
		}
	}
	const recovered = await owner.submit(
		{ kind: "query", statement: { sql: "SELECT COUNT(*) n FROM supervision_writes", result: "get", readonly: true } },
		{ operation: "organization.supervision-recovered", lane: "read", deadlineMs: 2000 },
	).result;
	const healthy = await (await fetch(`${endpoint}/health`)).json();
	if (!healthy.db || healthy.status !== "healthy") throw new Error("Replacement did not restore healthy reads");
	results.push({ write, previous, current: owner.health(), queuedOutcome, deadlineOutcome, recovered });
}
console.log(`SUPERVISION_RESULT ${JSON.stringify({ daemonPid: process.pid, health, results })}`);
process.kill(process.pid, "SIGTERM");
