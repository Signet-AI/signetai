import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { initDbAccessor, closeDbAccessor, getDbAccessor } from "./db-accessor";
import { listAgentMessagePage } from "./cross-agent";

test("message pages exclude classified content before counts and limits", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-message-scope-"));
	const path = join(dir, "test.db");
	initDbAccessor(path, { agentsDir: dir });
	const db = new Database(path);
	try {
		db.exec(
			"INSERT INTO classifications(id,name) VALUES('secret','Secret'); INSERT INTO compartments(id,key) VALUES(1,'secret'); INSERT INTO compartment_members VALUES(1,'secret'); INSERT INTO cross_agent_messages(id,from_agent_id,to_agent_id,content,message_type,broadcast,delivery_path,delivery_status,created_at,expires_at,compartment_id) VALUES('hidden','default','default','hidden','info',0,'local','delivered','2026-01-02','2999-01-01',1),('visible','default','default','visible','info',0,'local','delivered','2026-01-01','2999-01-01',NULL)",
		);
		const options = {
			agentId: "default",
			limit: 1,
			readScope: { reach: { kind: "all" as const }, compartments: [], projects: null },
		};
		const page = listAgentMessagePage(options);
		expect(page.items.map((item) => item.id)).toEqual(["visible"]);
		expect(page.total).toBe(1);
		expect(page.unreadCount).toBe(1);
	} finally {
		db.close();
		await closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("retention expires session recall events and their citations together", async () => {
	const { runRetentionSweepOnce, DEFAULT_RETENTION } = await import("./pipeline/retention-worker");
	const dir = mkdtempSync(join(tmpdir(), "signet-recall-retention-"));
	const path = join(dir, "test.db");
	initDbAccessor(path, { agentsDir: dir });
	const accessor = getDbAccessor();
	const db = new Database(path);
	try {
		db.exec(
			"INSERT INTO session_recall_events(session_key,agent_id,context_epoch,item_kind,item_id,surface,mode,created_at) VALUES('s','default',0,'memory','m','test','test','2000-01-01'); INSERT INTO evidence_citations VALUES('telemetry',json_array('s',0,'memory','m'),'default','memory','m')",
		);
		await runRetentionSweepOnce(accessor, DEFAULT_RETENTION);
		expect(db.prepare("SELECT count(*) n FROM session_recall_events").get()).toEqual({ n: 0 });
		expect(db.prepare("SELECT count(*) n FROM evidence_citations WHERE derived_kind='telemetry'").get()).toEqual({
			n: 0,
		});
	} finally {
		db.close();
		await closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("wake claims exclude classified messages before their batch limit", async () => {
	const { claimDirectMessageWakes } = await import("./cross-agent-wake");
	const { closeDbOwner } = await import("./db-owner-runtime");
	const dir = mkdtempSync(join(tmpdir(), "signet-wake-scope-"));
	const path = join(dir, "test.db");
	initDbAccessor(path, { agentsDir: dir });
	const db = new Database(path);
	try {
		db.exec(
			"INSERT INTO classifications(id,name) VALUES('cls_secret','Secret'); INSERT INTO compartments(id,key) VALUES(1,'cls_secret'); INSERT INTO compartment_members VALUES(1,'cls_secret'); INSERT INTO cross_agent_messages(id,from_agent_id,to_agent_id,content,message_type,broadcast,delivery_path,delivery_status,created_at,expires_at,compartment_id) VALUES('hidden','default','default','hidden','info',0,'local','delivered','2026-01-01','2999-01-01',1),('visible','default','default','visible','info',0,'local','delivered','2026-01-02','2999-01-01',NULL)",
		);
		const input = {
			agentId: "default",
			sessionKey: "recipient",
			harness: "pi",
			readScope: { reach: { kind: "all" as const }, compartments: [], projects: null },
		};
		expect((await claimDirectMessageWakes(input)).map((row) => row.id)).toEqual(["visible"]);
	} finally {
		await closeDbOwner();
		db.close();
		await closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	}
});
