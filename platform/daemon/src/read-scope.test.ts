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
	db.close();
});

test("an unresolved audience identity cannot construct a public organization read scope", async () => {
	await expect(
		resolveReadScope({ reach: { kind: "all" }, projects: null }, { local: false, userId: null, groupIds: [] }),
	).rejects.toThrow("unauthorized");
});

test("shared reach rejects absent visibility instead of widening the reader", () => {
	expect(() =>
		readScopeSql(
			"r",
			{ reach: { kind: "shared", agentId: "a" }, compartments: [], projects: null },
			{ visibility: null },
		),
	).toThrow("visibility");
});
