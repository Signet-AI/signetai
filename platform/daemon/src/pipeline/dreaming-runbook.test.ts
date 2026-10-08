import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { getDbOwnerForAccessor } from "../db-owner-runtime";
import { readDreamingPassRecord } from "./dreaming-runbook";

describe("dreaming pass record", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-dreaming-runbook-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(async () => {
		await closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	it("summarizes a pass's operations as counts plus distinct failures", async () => {
		const claim = { operation: "add_claim_value", payload: {} };
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO dreaming_passes (id, agent_id, status, completed_at, summary)
				 VALUES ('pass-1', 'agent-a', 'completed', datetime('now'), 'Filed claims')`,
			).run();
			const call = db.prepare(
				`INSERT INTO dreaming_tool_calls (id, agent_id, pass_id, sequence, tool_name, input_json, output_json, success, latency_ms)
				 VALUES (?, 'agent-a', 'pass-1', ?, 'apply_ontology_ops', ?, ?, ?, 1)`,
			);
			call.run(
				"call-1",
				1,
				JSON.stringify({ operations: [{ operation: "create_entity", payload: {} }, claim, claim, claim] }),
				JSON.stringify({ ok: true, items: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }] }),
				1,
			);
			call.run(
				"call-2",
				2,
				JSON.stringify({ operations: [claim, claim] }),
				JSON.stringify({ ok: false, error: "quote not found", items: [] }),
				0,
			);
		});

		const pass = await readDreamingPassRecord(await getDbOwnerForAccessor(getDbAccessor()), "agent-a", "pass-1");
		expect(pass?.operations).toEqual({
			applied: { create_entity: 1, add_claim_value: 3 },
			failed: [{ operation: "add_claim_value", error: "quote not found", count: 2 }],
		});
	});
});
