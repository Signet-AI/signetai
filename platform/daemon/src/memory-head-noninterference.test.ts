import { getSyncDbAccessor } from "../legacy-sync/db-accessor-sync";
import { expect, test } from "bun:test";
import { compartmentFor } from "@signet/core";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { requestMemoryHead } from "./memory-head";
import { resolveReadScope } from "./read-scope";

test("hidden evidence cannot invalidate a reader's unchanged MEMORY.md entries", async () => {
	const directory = mkdtempSync(join(tmpdir(), "signet-head-noninterference-"));
	const previous = process.env.SIGNET_PATH;
	process.env.SIGNET_PATH = directory;
	try {
		mkdirSync(join(directory, "memory"));
		initDbAccessor(join(directory, "memory", "memories.db"));
		getSyncDbAccessor().withWriteTx((db) => {
			db.exec(
				"INSERT INTO classifications(id,name) VALUES ('cls_head_secret','Head secret'); INSERT INTO memories(id,content,type,memory_kind,agent_id,created_at,updated_at,updated_by) VALUES ('head-visible','Atlas public head','fact','episodic','default','now','now','test')",
			);
			db.prepare(
				"INSERT INTO memory_head_entries(entry_id,agent_id,canonical_text,entry_hash,status,first_revision,last_revision,created_at,updated_at) VALUES ('head-entry','default','Atlas public head','hash','active',1,1,'now','now')",
			).run();
			db.prepare(
				"INSERT INTO memory_head_revision_entries(agent_id,revision,entry_id,ordinal,operation,provenance_json) VALUES ('default',1,'head-entry',0,'add',?)",
			).run(JSON.stringify([{ source_ref: "memory:head-visible", quote: "Atlas public head" }]));
			db.prepare(
				"INSERT OR REPLACE INTO memory_md_heads(agent_id,content,content_hash,revision,revision_id,updated_at,is_current) VALUES ('default','- Atlas public head','hash',1,'head-revision','now',1)",
			).run();
		});
		const readScope = await resolveReadScope(
			{ reach: { kind: "own", agentId: "default" }, projects: null },
			{ userId: "alice", groupIds: [], local: false },
		);
		const read = () => requestMemoryHead({ action: "inspect", agentId: "default", content: "", readScope });
		const before = await read();
		expect(before).toEqual({ generated: true, status: "current", content: "- Atlas public head" });
		getSyncDbAccessor().withWriteTx((db) => {
			const compartment = compartmentFor(db, ["cls_head_secret"]);
			db.prepare(
				"INSERT INTO memories(id,content,type,agent_id,compartment_id,created_at,updated_at,updated_by) VALUES ('head-hidden','Classified unrelated change','fact','default',?,'now','now','test')",
			).run(compartment);
			db.prepare("UPDATE memories SET content='Classified unrelated mutation' WHERE id='head-hidden'").run();
		});
		expect(await read()).toEqual(before);
		getSyncDbAccessor().withWriteTx((db) =>
			db.prepare("UPDATE memories SET content='Atlas public head corrected' WHERE id='head-visible'").run(),
		);
		expect(await read()).toEqual(before);
		getSyncDbAccessor().withWriteTx((db) =>
			db.prepare("UPDATE memories SET content='Replacement without the old quote' WHERE id='head-visible'").run(),
		);
		expect(await read()).toEqual({ generated: true, status: "current", content: "" });
	} finally {
		await closeDbAccessor();
		if (previous === undefined) delete process.env.SIGNET_PATH;
		else process.env.SIGNET_PATH = previous;
		rmSync(directory, { recursive: true, force: true });
	}
}, 30000);
