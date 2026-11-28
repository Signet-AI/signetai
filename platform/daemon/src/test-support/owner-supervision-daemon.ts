import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initDbAccessor, closeDbAccessor } from "../db-accessor";
import { getDbOwner } from "../db-owner-runtime";

const root = process.env.SIGNET_PATH;
if (!root) throw new Error("Isolated workspace required");
mkdirSync(join(root, "data"), { recursive: true });
mkdirSync(join(root, ".daemon", "logs"), { recursive: true });
writeFileSync(join(root, "workspace-layout.json"), JSON.stringify({ version: 2 }));
writeFileSync(
	join(root, "agent.yaml"),
	"version: 1\nconfigVersion: 9\nembedding:\n  provider: none\nharnesses: []\nauth:\n  mode: local\nmemory:\n  dreaming:\n    enabled: false\n  pipelineV2:\n    enabled: false\n    reranker:\n      enabled: false\n",
);
initDbAccessor(join(root, "data", "signet.db"), { agentsDir: root });
await closeDbAccessor();
await import("../daemon");
const endpoint = `http://127.0.0.1:${process.env.SIGNET_PORT}`;
const until = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
	const deadline = Date.now() + 10000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("Supervision fixture did not converge");
		await Bun.sleep(10);
	}
};
await until(async () => {
	try {
		return (await fetch(`${endpoint}/health`)).ok;
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
	results.push({ write, previous, current: owner.health(), queuedOutcome, deadlineOutcome, recovered });
}
console.log(`SUPERVISION_RESULT ${JSON.stringify({ daemonPid: process.pid, health, results })}`);
process.kill(process.pid, "SIGTERM");
