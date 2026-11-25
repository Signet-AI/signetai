import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as dbAccessor from "./db-accessor";

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compartmentForWrite } from "../../core/src/compartment-shards";

let dir = "";
let accessor: ReturnType<typeof dbAccessor.getDbAccessor>;
const originalGet = dbAccessor.getDbAccessor;
const getDbAccessorSpy = spyOn(dbAccessor, "getDbAccessor").mockImplementation(() => accessor);

const { advanceRecallContextEpoch, applyRecallDedupe, applyRecallDedupeAsync, claimRecallItems } = await import(
	"./session-recall-dedupe"
);

afterAll(() => {
	getDbAccessorSpy.mockRestore();
});

beforeEach(async () => {
	await dbAccessor.closeDbAccessor();
	dir = mkdtempSync(join(tmpdir(), "signet-recall-dedupe-"));
	mkdirSync(join(dir, "memory"));
	dbAccessor.initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
	accessor = originalGet();
	await accessor.withWriteTxAsync((db) => {
		for (const id of ["mem-1", "mem-2", "mem-duplicate"])
			db.prepare(
				"INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES(?,?,'agent-a','now','now')",
			).run(id, id);
	});
});
afterEach(async () => {
	await dbAccessor.closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
});

describe("session recall dedupe", () => {
	it("suppresses repeated rows within one session agent epoch", () => {
		const first = claimRecallItems({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
		});
		expect(first.items.map((item) => item.id)).toEqual(["mem-1"]);
		expect(first.meta.contextEpoch).toBe(0);

		const second = claimRecallItems({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			items: [
				{ id: "mem-1", score: 0.9, source: "hybrid" },
				{ id: "mem-2", score: 0.8, source: "hybrid" },
			],
		});
		expect(second.items.map((item) => item.id)).toEqual(["mem-2"]);
		expect(second.meta.suppressed).toBe(1);
	});

	it("marks already recalled rows when includeRecalled is true", () => {
		claimRecallItems({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
		});

		const result = applyRecallDedupe({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			claim: true,
			includeRecalled: true,
			items: [
				{ id: "mem-1", score: 0.9, source: "hybrid" },
				{ id: "mem-2", score: 0.8, source: "hybrid" },
			],
			markRepeated: (item) => ({ ...item, already_recalled: true }),
		});

		expect(result.items).toEqual([
			{ id: "mem-1", score: 0.9, source: "hybrid", already_recalled: true },
			{ id: "mem-2", score: 0.8, source: "hybrid" },
		]);
		expect(result.meta.repeatedReturned).toBe(1);
	});

	it("deduplicates duplicate identities within one batch", () => {
		const items = [{ id: "mem-duplicate" }, { id: "mem-duplicate" }];
		const included = applyRecallDedupe({
			sessionKey: "sess-include-duplicate",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			claim: true,
			includeRecalled: true,
			items,
		});
		const filtered = applyRecallDedupe({
			sessionKey: "sess-filter-duplicate",
			agentId: "agent-a",
			surface: "test",
			mode: "automatic",
			claim: false,
			items,
		});

		expect(included.items).toEqual([{ id: "mem-duplicate" }]);
		expect(included.meta.repeatedReturned).toBe(0);
		expect(filtered.items).toEqual([{ id: "mem-duplicate" }]);
		expect(filtered.meta.suppressed).toBe(1);
	});

	it("derives an omitted agent identity from an encoded session key", () => {
		const sessionKey = "agent:agent-a:session-1";
		const first = claimRecallItems({
			sessionKey,
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-1" }],
		});
		const defaultAgent = claimRecallItems({
			sessionKey,
			agentId: "default",
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-1" }],
		});
		const second = claimRecallItems({
			sessionKey,
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-1" }],
		});

		expect(first.items).toHaveLength(1);
		expect(defaultAgent.items).toHaveLength(1);
		expect(second.items).toHaveLength(0);
	});

	it("advances compaction epochs and isolates agents", () => {
		claimRecallItems({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
		});

		expect(
			claimRecallItems({
				sessionKey: "sess-1",
				agentId: "agent-b",
				surface: "test",
				mode: "direct",
				items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
			}).items,
		).toHaveLength(1);

		const epoch = advanceRecallContextEpoch({
			sessionKey: "sess-1",
			agentId: "agent-a",
			reason: "compaction-complete",
			sourceRef: "summary-1",
		});
		expect(epoch).toEqual({ advanced: true, contextEpoch: 1 });
		expect(
			claimRecallItems({
				sessionKey: "sess-1",
				agentId: "agent-a",
				surface: "test",
				mode: "direct",
				items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
			}).items,
		).toHaveLength(1);
	});

	it("leaves sessionless recall unchanged", () => {
		const first = claimRecallItems({
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
		});
		const second = claimRecallItems({
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
		});

		expect(first.meta.enabled).toBe(false);
		expect(second.items.map((item) => item.id)).toEqual(["mem-1"]);
	});

	it("can filter already recalled rows without claiming unreturned candidates", async () => {
		const result = applyRecallDedupe({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "automatic",
			claim: false,
			items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
		});
		expect(result.items).toHaveLength(1);
		expect(
			await accessor.withReadDbAsync((db) => db.prepare("SELECT count(*) n FROM session_recall_events").get()),
		).toEqual({ n: 0 });
	});

	it("reports when dedupe fails open", () => {
		const writer = spyOn(accessor, "withWriteTx").mockImplementation(() => {
			throw new Error("ledger unavailable");
		});
		const result = claimRecallItems({
			sessionKey: "sess-failure",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-1" }],
		});

		expect(result.items).toEqual([{ id: "mem-1" }]);
		expect(result.meta).toMatchObject({ enabled: false, failedOpen: true });
		expect(advanceRecallContextEpoch({ sessionKey: "sess-failure", agentId: "agent-a", reason: "test" })).toEqual({
			advanced: false,
			failedOpen: true,
		});
		writer.mockRestore();
	});

	it("copies the returned memory label and citation into the recall event", async () => {
		await accessor.withWriteTxAsync((db) => {
			db.exec(
				"INSERT INTO classifications(id,name) VALUES('cls_hr','HR'); INSERT INTO classification_assignments VALUES('memory','mem-1','agent-a','cls_hr','alice','now')",
			);
			db.prepare("UPDATE memories SET compartment_id=? WHERE id='mem-1'").run(
				compartmentForWrite(db, { agentId: "agent-a", memoryId: "mem-1" }),
			);
		});
		await applyRecallDedupeAsync({
			sessionKey: "s",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			claim: true,
			items: [{ id: "mem-1" }],
		});
		expect(
			await accessor.withReadDbAsync((db) => db.prepare("SELECT compartment_id FROM session_recall_events").get()),
		).toEqual({ compartment_id: expect.any(Number) });
		expect(
			await accessor.withReadDbAsync((db) =>
				db
					.prepare("SELECT derived_id,evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='telemetry'")
					.all(),
			),
		).toEqual([{ derived_id: '["s",0,"memory","mem-1"]', evidence_kind: "memory", evidence_id: "mem-1" }]);
	});

	it("keeps the async path aligned with batch dedupe", async () => {
		const result = await applyRecallDedupeAsync({
			sessionKey: "sess-async-duplicate",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			claim: true,
			includeRecalled: true,
			items: [{ id: "mem-1" }, { id: "mem-1" }],
		});

		expect(result.items).toEqual([{ id: "mem-1" }]);
		expect(result.meta.failedOpen).toBeUndefined();
	});
});
