import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ensureCompartmentShards, rebuildBaseCompartmentFts } from "../../core/src/compartment-shards";
import { isDuplicate } from "./memory-classification";

test("duplicate detection searches only the caller's readable FTS shards", () => {
	const db = new Database(":memory:");
	try {
		db.exec(
			"CREATE TABLE memories(id TEXT PRIMARY KEY,content TEXT,agent_id TEXT,visibility TEXT,compartment_id INTEGER,is_deleted INTEGER); CREATE VIRTUAL TABLE memories_fts USING fts5(content,content='memories',content_rowid='rowid')",
		);
		rebuildBaseCompartmentFts(db);
		ensureCompartmentShards(db, 7, 0);
		db.exec(
			"INSERT INTO memories VALUES ('hidden','Atlas deploys through the canary pipeline','default','global',7,0)",
		);
		const scope = { reach: { kind: "own" as const, agentId: "default" }, compartments: [], projects: null };
		expect(isDuplicate(db, "Atlas deploys through the canary pipeline", "default", scope)).toBe(false);
		expect(
			isDuplicate(db, "Atlas deploys through the canary pipeline", "default", { ...scope, compartments: [7] }),
		).toBe(true);
	} finally {
		db.close();
	}
});
