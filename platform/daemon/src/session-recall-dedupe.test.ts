import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compartmentFor, findSqliteVecExtension } from "@signet/core";
import type { ReadScope } from "./read-scope";
import type { RecallDedupeItem } from "./session-recall-dedupe";
import { executeClassification } from "./classification-owner";
import * as dbAccessor from "./db-accessor";

let dir = "";
let prevSignetPath: string | undefined;
let writeTxError: Error | null = null;
const realGetDbAccessor = dbAccessor.getDbAccessor;
const getDbAccessorSpy = spyOn(dbAccessor, "getDbAccessor").mockImplementation(() => {
	const real = realGetDbAccessor();
	if (!writeTxError) return real;
	const error = writeTxError;
	return Object.assign(Object.create(real), {
		withWriteTx: () => {
			throw error;
		},
		withWriteTxAsync: async () => {
			throw error;
		},
	});
});

const dedupe = await import("./session-recall-dedupe");
const { advanceRecallContextEpoch } = dedupe;
const { localTestReadScope } = await import("./test-support/local-read-scope");
type ApplyOptions<T extends RecallDedupeItem> = Omit<Parameters<typeof dedupe.applyRecallDedupe<T>>[0], "readScope"> & {
	readonly readScope?: ReadScope;
};
type ClaimOptions<T extends RecallDedupeItem> = Omit<Parameters<typeof dedupe.claimRecallItems<T>>[0], "readScope"> & {
	readonly readScope?: ReadScope;
};
function scoped<T extends { readonly agentId?: string | null; readonly readScope?: ReadScope }>(
	opts: T,
): T & { readonly readScope: ReadScope } {
	return { ...opts, readScope: opts.readScope ?? localTestReadScope(opts.agentId ?? "default") };
}
function applyRecallDedupe<T extends RecallDedupeItem>(opts: ApplyOptions<T>) {
	return dedupe.applyRecallDedupe(scoped(opts));
}
async function applyRecallDedupeAsync<T extends RecallDedupeItem>(opts: ApplyOptions<T>) {
	return await dedupe.applyRecallDedupeAsync(scoped(opts));
}
function claimRecallItems<T extends RecallDedupeItem>(opts: ClaimOptions<T>) {
	return dedupe.claimRecallItems(scoped(opts));
}

function ledgerCount(): unknown {
	return realGetDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS n FROM session_recall_events").get()?.n);
}

import { compartmentForWrite } from "../../core/src/compartment-shards";
let accessor: ReturnType<typeof dbAccessor.getDbAccessor>;

afterAll(() => {
	getDbAccessorSpy.mockRestore();
});

beforeEach(async () => {
	await dbAccessor.closeDbAccessor();
	dir = mkdtempSync(join(tmpdir(), "signet-recall-dedupe-"));
	mkdirSync(join(dir, "memory"), { recursive: true });
	writeFileSync(join(dir, "agent.yaml"), "name: RecallDedupeTest\n");
	prevSignetPath = process.env.SIGNET_PATH;
	process.env.SIGNET_PATH = dir;
	dbAccessor.initDbAccessor(join(dir, "memory", "memories.db"));
	accessor = realGetDbAccessor();
	await accessor.withWriteTxAsync((db) => {
		for (const id of ["mem-1", "mem-2", "mem-duplicate"])
			db.prepare(
				"INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES(?,?,'agent-a','now','now')",
			).run(id, id);
	});
	writeTxError = null;
});

afterEach(async () => {
	writeTxError = null;
	await dbAccessor.closeDbAccessor();
	if (prevSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = prevSignetPath;
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
		expect(ledgerCount()).toBe(0);
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

	it.each(["classified-session", "classified-session\0codex"])(
		"inherits the classified session label for ledger key %s",
		async (sessionKey) => {
			await accessor.withWriteTxAsync((db) =>
				db.exec(
					"INSERT INTO classifications(id,name) VALUES('cls_session','Session'); INSERT INTO classification_assignments VALUES('session','classified-session','agent-a','cls_session','alice','now')",
				),
			);
			await applyRecallDedupeAsync({
				sessionKey,
				agentId: "agent-a",
				surface: "test",
				mode: "direct",
				claim: true,
				items: [{ id: "mem-1" }],
			});
			expect(
				await accessor.withReadDbAsync((db) =>
					db.prepare("SELECT session_key,compartment_id FROM session_recall_events").get(),
				),
			).toEqual({ session_key: sessionKey, compartment_id: expect.any(Number) });
			expect(
				await accessor.withReadDbAsync((db) =>
					db.prepare("SELECT compartment_id FROM memories WHERE id='mem-1'").get(),
				),
			).toEqual({ compartment_id: null });
		},
	);

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

describe("session recall ledger compartments", () => {
	const scope = { reach: { kind: "all" as const }, compartments: [] as number[], projects: null };
	function seed(): { readonly hr: number; readonly legal: number; readonly both: number } {
		return realGetDbAccessor().withWriteTx((db) => {
			db.exec(`INSERT INTO agents(id, name, created_at, updated_at) VALUES ('agent-a', 'A', 'now', 'now');
				INSERT INTO classifications(id, name) VALUES ('cls_hr', 'HR'), ('cls_legal', 'Legal');`);
			const hr = compartmentFor(db, ["cls_hr"]);
			const legal = compartmentFor(db, ["cls_legal"]);
			const both = compartmentFor(db, ["cls_hr", "cls_legal"]);
			if (hr === null || legal === null || both === null) throw new Error("compartments missing");
			const insert = db.prepare(
				"INSERT INTO memories(id, content, type, agent_id, compartment_id, created_at, updated_at, updated_by) VALUES (?, ?, 'fact', 'agent-a', ?, 'now', 'now', 'test')",
			);
			insert.run("mem-hr", "hr", hr);
			insert.run("mem-legal", "legal", legal);
			insert.run("mem-open", "open", null);
			db.prepare(
				"INSERT INTO classification_assignments(target_kind, target_id, agent_id, classification_id, applied_by, applied_at) VALUES ('session', 'sess-legal', 'agent-a', 'cls_legal', 'test', 'now')",
			).run();
			return { hr, legal, both };
		});
	}
	function ledger(): unknown[] {
		return realGetDbAccessor().withReadDb((db) =>
			db
				.prepare(
					`SELECT e.item_id, e.compartment_id, c.derived_id, c.evidence_kind, c.evidence_id
					 FROM session_recall_events e
					 LEFT JOIN evidence_citations c ON c.derived_kind = 'telemetry' AND c.agent_id = e.agent_id
					   AND c.derived_id = json_array(e.session_key, e.context_epoch, e.item_kind, e.item_id)
					 ORDER BY e.item_id`,
				)
				.all(),
		);
	}

	it("labels each ledger row with its item and session labels and cites the item", () => {
		const { hr, legal, both } = seed();
		claimRecallItems({
			sessionKey: "sess-legal",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-hr" }, { id: "mem-open" }],
		});
		expect(hr).not.toBe(both);
		expect(ledger()).toEqual([
			{
				item_id: "mem-hr",
				compartment_id: both,
				derived_id: '["sess-legal",0,"memory","mem-hr"]',
				evidence_kind: "memory",
				evidence_id: "mem-hr",
			},
			{
				item_id: "mem-open",
				compartment_id: legal,
				derived_id: '["sess-legal",0,"memory","mem-open"]',
				evidence_kind: "memory",
				evidence_id: "mem-open",
			},
		]);
	});

	it("does not let a hidden ledger row suppress or mark an item for another audience", () => {
		const { hr } = seed();
		claimRecallItems({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-hr" }],
			readScope: { ...scope, compartments: [hr] },
		});
		const claimed = claimRecallItems({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-hr" }, { id: "mem-open" }],
			readScope: scope,
		});
		expect(claimed.items.map((item) => item.id)).toEqual(["mem-hr", "mem-open"]);
		expect(claimed.meta.suppressed).toBe(0);
		const marked = applyRecallDedupe({
			sessionKey: "sess-2",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			claim: true,
			includeRecalled: true,
			items: [{ id: "mem-hr" }],
			readScope: { ...scope, compartments: [hr] },
		});
		expect(marked.meta.repeatedReturned).toBe(0);
		const filtered = applyRecallDedupe({
			sessionKey: "sess-2",
			agentId: "agent-a",
			surface: "test",
			mode: "automatic",
			claim: false,
			items: [{ id: "mem-hr" }],
			readScope: scope,
		});
		expect(filtered.items.map((item) => item.id)).toEqual(["mem-hr"]);
		const audience = applyRecallDedupe({
			sessionKey: "sess-2",
			agentId: "agent-a",
			surface: "test",
			mode: "automatic",
			claim: false,
			items: [{ id: "mem-hr" }],
			readScope: { ...scope, compartments: [hr] },
		});
		expect(audience.items).toEqual([]);
	});

	it("dedupes under a local shared-reach scope instead of failing open", () => {
		seed();
		const readScope = {
			reach: { kind: "shared" as const, agentId: "agent-a" },
			compartments: "all" as const,
			projects: null,
		};
		const claim = () =>
			claimRecallItems({
				sessionKey: "sess-shared",
				agentId: "agent-a",
				surface: "test",
				mode: "direct",
				items: [{ id: "mem-open" }],
				readScope,
			});
		expect(claim().items).toHaveLength(1);
		const second = claim();
		expect(second.items).toEqual([]);
		expect(second.meta).toMatchObject({ enabled: true, suppressed: 1 });
	});

	it("follows reclassification of a recalled memory through the ledger copy edge", async () => {
		seed();
		claimRecallItems({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-open" }],
		});
		const path = join(dir, "memory", "memories.db");
		await dbAccessor.closeDbAccessor();
		const db = new Database(path);
		try {
			const extension = findSqliteVecExtension();
			if (!extension) throw new Error("sqlite-vec required for classification fixture");
			db.loadExtension(extension);
			const actor = {
				userId: "carol",
				groupIds: [],
				local: false,
				compliance: true,
				boundAgentId: null,
				allowedProjects: null,
				credential: "session:test",
			};
			const target = { kind: "memory" as const, id: "mem-open", agentId: "agent-a" };
			const job = executeClassification(db, { op: "enqueue", actor, id: "cls_hr", target, remove: false });
			if (typeof job !== "object" || job === null || !("jobId" in job) || typeof job.jobId !== "string")
				throw new Error("missing job");
			for (let turn = 0; turn < 20; turn++) {
				executeClassification(db, { op: "execute", jobId: job.jobId });
				const status = db.prepare("SELECT status FROM org_jobs WHERE id=?").get(job.jobId)?.status;
				if (status !== "pending" && status !== "running") break;
			}
			expect(db.prepare("SELECT status FROM org_jobs WHERE id=?").get(job.jobId)).toEqual({ status: "complete" });
			const memory = db.prepare("SELECT compartment_id FROM memories WHERE id = 'mem-open'").get();
			expect(memory?.compartment_id).toEqual(expect.any(Number));
			expect(db.prepare("SELECT compartment_id FROM session_recall_events").get()).toEqual(memory);
		} finally {
			db.close();
			dbAccessor.initDbAccessor(path);
		}
	});
});
