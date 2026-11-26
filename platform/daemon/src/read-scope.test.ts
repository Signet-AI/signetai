import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readScopeSql, resolveReadScope } from "./read-scope";
import { buildAgentScopeClause } from "./memory-access-scope";

test("read scope preserves all three local policies and restricts compartments and projects before limits", () => {
	const db = new Database(":memory:");
	db.exec(
		`CREATE TABLE agents(id TEXT,policy_group TEXT,archived_at TEXT); INSERT INTO agents VALUES('a','g',NULL),('b','g',NULL),('c','other',NULL),('gone','g','now'); CREATE TABLE memories(id TEXT,agent_id TEXT,visibility TEXT,compartment_id INTEGER,project TEXT); INSERT INTO memories VALUES('own','a','private',NULL,'p'),('peer','b','global',NULL,'p'),('other','c','global',NULL,'p'),('hidden','b','private',1,'p'),('archived','a','archived',NULL,'p'),('gone','gone','global',NULL,'p');`,
	);
	for (const policy of ["shared", "group", "isolated"] as const) {
		const old = buildAgentScopeClause("a", policy, "g");
		const expected = {
			shared: [{ id: "gone" }, { id: "other" }, { id: "own" }, { id: "peer" }],
			group: [{ id: "gone" }, { id: "own" }, { id: "peer" }],
			isolated: [{ id: "own" }],
		};
		expect(db.prepare(`SELECT id FROM memories m WHERE 1=1 ${old.sql} ORDER BY id`).all(...old.args)).toEqual(
			expected[policy],
		);
		const scope = readScopeSql("m", {
			reach:
				policy === "isolated"
					? { kind: "own", agentId: "a" }
					: policy === "shared"
						? { kind: "shared", agentId: "a" }
						: { kind: "group", agentId: "a", group: "g" },
			compartments: "all",
			projects: null,
		});
		expect(db.prepare(`SELECT id FROM memories m WHERE 1=1 ${scope.sql} ORDER BY id`).all(...scope.args)).toEqual(
			db.prepare(`SELECT id FROM memories m WHERE 1=1 ${old.sql} ORDER BY id`).all(...old.args),
		);
	}
	const org = readScopeSql("m", { reach: { kind: "all" }, compartments: [], projects: ["p"] });
	expect(db.prepare(`SELECT id FROM memories m WHERE 1=1 ${org.sql} ORDER BY id`).all(...org.args)).toEqual([
		{ id: "other" },
		{ id: "own" },
		{ id: "peer" },
	]);
	const permitted = readScopeSql("m", { reach: { kind: "all" }, compartments: [1], projects: ["p"] });
	expect(db.prepare(`SELECT id FROM memories m WHERE 1=1 ${permitted.sql} ORDER BY id`).all(...permitted.args)).toEqual(
		[{ id: "hidden" }, { id: "other" }, { id: "own" }, { id: "peer" }],
	);
	expect(() => readScopeSql("m;DROP TABLE x", { reach: { kind: "all" }, compartments: [], projects: null })).toThrow();
	db.exec(
		"INSERT INTO agents VALUES('default',NULL,NULL); INSERT INTO memories VALUES('legacy','default',NULL,NULL,'p'),('missing',NULL,'global',NULL,'p'),('empty','','global',NULL,'p')",
	);
	const legacy = readScopeSql("m", { reach: { kind: "own", agentId: "default" }, compartments: "all", projects: null });
	expect(db.prepare(`SELECT id FROM memories m WHERE 1=1 ${legacy.sql} ORDER BY id`).all(...legacy.args)).toEqual([
		{ id: "legacy" },
	]);
	db.close();
});

test("an unresolved audience identity cannot construct a public organization read scope", async () => {
	await expect(
		resolveReadScope({ reach: { kind: "all" }, projects: null }, { local: false, userId: null, groupIds: [] }),
	).rejects.toThrow("unauthorized");
});

test("A14b derived reads without visibility stay within their own agent under shared and group reach", async () => {
	const db = new Database(":memory:");
	db.exec(
		"CREATE TABLE agents(id TEXT,policy_group TEXT,archived_at TEXT); INSERT INTO agents VALUES ('a','g',NULL),('b','g',NULL); CREATE TABLE summaries(id TEXT,agent_id TEXT,compartment_id INTEGER,project TEXT); INSERT INTO summaries VALUES ('own','a',NULL,NULL),('peer','b',NULL,NULL)",
	);
	for (const reach of [
		{ kind: "shared", agentId: "a" },
		{ kind: "group", agentId: "a", group: "g" },
		{ kind: "all" },
	] as const) {
		const scope = await resolveReadScope({ reach, projects: null }, { local: true, userId: null, groupIds: [] });
		const access = readScopeSql("r", scope, { visibility: null });
		expect(db.prepare(`SELECT id FROM summaries r WHERE 1=1${access.sql} ORDER BY id`).all(...access.args)).toEqual(
			reach.kind === "all" ? [{ id: "own" }, { id: "peer" }] : [{ id: "own" }],
		);
	}
	db.close();
});
