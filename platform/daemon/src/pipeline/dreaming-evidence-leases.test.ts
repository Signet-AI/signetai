import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DbAccessor, WriteDb } from "../db-accessor";
import { DEFAULT_DREAMING } from "../memory-config";
import { runDreamingAgentPass, type DreamingAgentExecutor } from "./dreaming";
import type { PiAgentTool } from "./pi-agent-protocol";
import { runMigrations } from "../../../core/src/migrations";
import { searchDreamingEvidenceInDb } from "./dreaming-capabilities";
import {
	evidenceLeasedByOtherPasses,
	leaseDreamingEvidence,
	leaseDreamingEvidenceInTx,
	releaseDreamingEvidenceLeasesInTx,
} from "./dreaming-evidence-leases";

let db: Database;

function pass(id: string, compartmentId: number | null = null, agentId = "alice"): void {
	db.query(`INSERT INTO dreaming_passes (id,agent_id,mode,status,created_at,compartment_id)
		VALUES (?,?,'incremental','running','now',?)`).run(id, agentId, compartmentId);
}

function source(id: string, compartmentId: number | null = null, agentId = "alice"): string {
	db.query(`INSERT INTO session_transcripts (session_key,agent_id,content,harness,created_at,updated_at,completed_at,compartment_id)
		VALUES (?,?,'User: evidence','pi','now','now','now',?)`).run(id, agentId, compartmentId);
	return `transcript:${id}`;
}

function lease(
	passId: string,
	refs: readonly string[],
	compartmentId?: number | null,
	agentId = "alice",
): ReadonlySet<string> {
	return db.transaction(() =>
		leaseDreamingEvidenceInTx(db, { agentId, passId, sourceRefs: refs, ttlMs: 60_000, compartmentId }),
	)();
}

function accessorFor(connection: Database): DbAccessor {
	const transaction = <T>(fn: (db: WriteDb) => T): T => connection.transaction(() => fn(connection))();
	const accessor = {
		withReadDb: <T>(fn: (db: Database) => T): T => fn(connection),
		withReadDbAsync: async <T>(fn: (db: Database) => T | Promise<T>): Promise<T> => await fn(connection),
		withWriteTx: transaction,
		withWriteTxAsync: async <T>(fn: (db: WriteDb) => T): Promise<T> => transaction(fn),
		withWriteDbAsync: async <T>(fn: (db: WriteDb) => T): Promise<T> => fn(connection),
		close: () => {},
	};
	return accessor;
}

async function invoke(tools: readonly PiAgentTool[], name: string, input: unknown): Promise<Record<string, unknown>> {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing ${name}`);
	const result = await tool.execute(name, input);
	const first = result.content[0];
	if (first?.type !== "text") throw new Error("Missing tool response");
	const output: unknown = JSON.parse(first.text);
	if (typeof output !== "object" || output === null || Array.isArray(output)) throw new Error("Invalid tool response");
	if (!("ok" in output)) throw new Error("Missing tool status");
	if (output.ok !== true) throw new Error(first.text);
	return output;
}

async function readAndReview(tools: readonly PiAgentTool[], input: Record<string, unknown>): Promise<string[]> {
	const output = await invoke(tools, "search_evidence", { agentId: "alice", ...input });
	const items = Array.isArray(output.items)
		? output.items.map((item: unknown) => {
				if (
					typeof item !== "object" ||
					item === null ||
					!("sourceRef" in item) ||
					typeof item.sourceRef !== "string" ||
					!("contentOffset" in item) ||
					typeof item.contentOffset !== "number"
				)
					throw new Error("Invalid excerpt");
				return { sourceRef: item.sourceRef, contentOffset: item.contentOffset };
			})
		: [];
	if (items.length > 0) await invoke(tools, "review_evidence", { agentId: "alice", items });
	return items.map((item) => item.sourceRef);
}

describe("Dreaming evidence lease ownership", () => {
	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db);
		db.exec("INSERT INTO classifications (id,name) VALUES ('cls_secret','Secret')");
		db.exec("INSERT INTO compartments (id,key) VALUES (1,'cls_secret')");
		db.exec("INSERT INTO compartment_members (compartment_id,classification_id) VALUES (1,'cls_secret')");
	});
	afterEach(() => db.close());

	it("grants one winner per NULL partition and lets the owner renew", () => {
		const ref = source("same");
		pass("a");
		pass("b");
		expect([...lease("a", [ref, ref])]).toEqual([ref]);
		expect([...lease("b", [ref])]).toEqual([]);
		expect([...lease("a", [ref])]).toEqual([ref]);
		expect(db.query("SELECT COUNT(*) AS n FROM dreaming_evidence_leases").get()).toEqual({ n: 1 });
		expect(evidenceLeasedByOtherPasses(db, "alice", "b")).toEqual([ref]);
	});

	it("keeps classified sources separate from the same agent's public queue", () => {
		const publicRef = source("public");
		const secretRef = source("secret", 1);
		pass("public");
		pass("secret", 1);
		expect([...lease("public", [publicRef])]).toEqual([publicRef]);
		expect([...lease("secret", [secretRef])]).toEqual([secretRef]);
		expect(evidenceLeasedByOtherPasses(db, "alice", "secret")).toEqual([]);
		expect(() => lease("public", [secretRef])).toThrow("compartment_mismatch");
		expect(() => lease("secret", [publicRef])).toThrow("compartment_mismatch");
		expect(() => lease("secret", [secretRef], null)).toThrow("compartment_mismatch");
	});

	it("keys all evidence kinds independently and checks each source's exact label", () => {
		for (const { id, compartmentId } of [
			{ id: "shared", compartmentId: null },
			{ id: "classified", compartmentId: 1 },
		]) {
			source(id, compartmentId);
			db.query(
				"INSERT INTO memories (id,agent_id,content,created_at,updated_at,updated_by,compartment_id) VALUES (?,'alice','Memory evidence','now','now','test',?)",
			).run(id, compartmentId);
			db.query(`INSERT INTO memory_artifacts (agent_id,source_path,source_sha256,source_kind,session_id,session_token,captured_at,content,updated_at,compartment_id)
			VALUES ('alice',?,?,'source_markdown','session','token','now','Artifact evidence','now',?)`).run(
				id,
				id,
				compartmentId,
			);
			db.query(`INSERT INTO session_summaries (id,agent_id,content,token_count,depth,kind,earliest_at,latest_at,created_at,compartment_id)
			VALUES (?,'alice','Summary evidence',10,0,'session','now','now','now',?)`).run(id, compartmentId);
		}
		pass("public");
		pass("classified", 1);
		const kinds = ["memory", "artifact", "transcript", "summary"];
		const publicRefs = kinds.map((kind) => `${kind}:shared`);
		const classifiedRefs = kinds.map((kind) => `${kind}:classified`);
		expect([...lease("public", publicRefs)]).toEqual(publicRefs);
		expect([...lease("classified", classifiedRefs)]).toEqual(classifiedRefs);
		for (const ref of classifiedRefs) expect(() => lease("public", [ref])).toThrow("compartment_mismatch");
		for (const ref of publicRefs) expect(() => lease("classified", [ref])).toThrow("compartment_mismatch");
	});

	it("does not collapse identical source refs across agents", () => {
		const ref = source("same");
		source("same", null, "bob");
		pass("a");
		pass("b", null, "bob");
		expect([...lease("a", [ref])]).toEqual([ref]);
		expect([...lease("b", [ref], null, "bob")]).toEqual([ref]);
		expect(() => lease("a", [ref], null, "bob")).toThrow("agent_not_permitted");
	});

	it("redelivers failed or expired leases without releasing a live peer", () => {
		const failed = source("failed");
		const expired = source("expired");
		const live = source("live");
		pass("a");
		pass("b");
		pass("c");
		lease("a", [failed]);
		lease("b", [expired]);
		lease("c", [live]);
		db.exec("UPDATE dreaming_passes SET status='failed' WHERE id='a'");
		db.exec("UPDATE dreaming_evidence_leases SET expires_at='2000-01-01' WHERE pass_id='b'");
		pass("next");
		expect([...lease("next", [failed, expired, live])]).toEqual([failed, expired]);
		releaseDreamingEvidenceLeasesInTx(db, "next");
		expect(db.query("SELECT pass_id FROM dreaming_evidence_leases").all()).toEqual([{ pass_id: "c" }]);
	});

	it("rejects stopped and stale passes before acquiring any evidence", () => {
		const ref = source("source");
		pass("stale");
		pass("stopped");
		db.exec("UPDATE dreaming_passes SET status='complete' WHERE id='stopped'");
		expect(() => lease("stopped", [ref])).toThrow("not running");
		db.exec(
			"INSERT INTO classification_assignments (target_kind,target_id,agent_id,classification_id) VALUES ('agent','bob','bob','cls_secret')",
		);
		expect(() => lease("stale", [ref])).toThrow("compartment_mismatch");
		pass("fresh");
		expect([...lease("fresh", [ref])]).toEqual([ref]);
	});

	it("rolls back a batch whose later source has a different label", () => {
		const publicRef = source("public");
		const secretRef = source("secret", 1);
		pass("a");
		expect(() => lease("a", [publicRef, secretRef])).toThrow("compartment_mismatch");
		expect(db.query("SELECT COUNT(*) AS n FROM dreaming_evidence_leases").get()).toEqual({ n: 0 });
	});

	it("denies organization personal aggregation and permits organization single storage", () => {
		db.exec("UPDATE organization SET claimed_at='now', agent_model='personal' WHERE id=1");
		db.exec("UPDATE agents SET kind='organization' WHERE id='default'");
		const ref = source("org", null, "default");
		pass("org", null, "default");
		expect(() => lease("org", [ref], null, "default")).toThrow("org_policy");
		db.exec("UPDATE organization SET agent_model='single' WHERE id=1");
		expect([...lease("org", [ref], null, "default")]).toEqual([ref]);
	});

	it("grants exactly one concurrent owner transaction and rolls back invalid batches", async () => {
		const ref = source("race");
		pass("a");
		pass("b");
		const accessor = accessorFor(db);
		const [first, second] = await Promise.all(
			["a", "b"].map((passId) =>
				leaseDreamingEvidence(accessor, { agentId: "alice", passId, sourceRefs: [ref], ttlMs: 60_000 }),
			),
		);
		expect(Number(first.has(ref)) + Number(second.has(ref))).toBe(1);
		const other = source("other");
		await expect(
			leaseDreamingEvidence(accessor, {
				agentId: "alice",
				passId: "a",
				sourceRefs: [other, "transcript:missing"],
				ttlMs: 60_000,
			}),
		).rejects.toThrow("compartment_mismatch");
		expect(db.query("SELECT source_id FROM dreaming_evidence_leases WHERE source_id='other'").get()).toBeNull();
	});

	it("delivers only the exact classified queue while targeted historical reads retain subset access", () => {
		const publicRef = source("public");
		const secretRef = source("secret", 1);
		pass("public");
		pass("secret", 1);
		expect(refs(queue("secret", 10))).toEqual([secretRef]);
		expect(refs(queue("public", 10))).toEqual([publicRef]);
		const historical = db.transaction(() =>
			searchDreamingEvidenceInDb(db, { agentId: "alice", passId: "secret", sourceRef: publicRef }),
		)();
		expect(refs(historical)).toEqual([publicRef]);
	});

	it("rejects invalid and oversized lease requests", () => {
		pass("a");
		expect(() => lease("a", ["unknown:x"])).toThrow("invalid_source_ref");
		expect(() =>
			lease(
				"a",
				Array.from({ length: 101 }, (_, i) => `transcript:${i}`),
			),
		).toThrow("evidence_lease_limit");
		expect(() =>
			leaseDreamingEvidenceInTx(db, { agentId: "alice", passId: "a", sourceRefs: [], ttlMs: Number.NaN }),
		).toThrow("invalid_lease_ttl");
	});
});

function queue(passId: string, limit: number): Record<string, unknown> {
	return db.transaction(() =>
		searchDreamingEvidenceInDb(db, { agentId: "alice", passId, limit, evidenceLeaseMs: 60_000 }),
	)();
}

function refs(output: Record<string, unknown>): string[] {
	if (!Array.isArray(output.items)) throw new Error("Missing evidence items");
	return output.items.map((item: unknown) => {
		if (typeof item !== "object" || item === null || !("sourceRef" in item) || typeof item.sourceRef !== "string")
			throw new Error("Invalid evidence item");
		return item.sourceRef;
	});
}

describe("Dreaming leased queue delivery", () => {
	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db);
	});
	afterEach(() => db.close());

	it("hands peers disjoint pages and lets the owner resume its own page", () => {
		const all = Array.from({ length: 6 }, (_, index) => source(`session-${index}`));
		pass("a");
		pass("b");
		const first = refs(queue("a", 3));
		const second = refs(queue("b", 3));
		expect(first).toHaveLength(3);
		expect(second).toHaveLength(3);
		expect(first.filter((ref) => second.includes(ref))).toEqual([]);
		expect([...first, ...second].sort()).toEqual(all.sort());
		expect(refs(queue("a", 6)).sort()).toEqual(first.sort());
	});

	it("refills beyond a full peer-held scan window and reports honest exhaustion", () => {
		Array.from({ length: 60 }, (_, index) => source(`session-${String(index).padStart(2, "0")}`));
		pass("a");
		pass("b");
		pass("c");
		const first = refs(queue("a", 50));
		const second = refs(queue("b", 50));
		expect(first).toHaveLength(50);
		expect(second).toHaveLength(10);
		expect(first.filter((ref) => second.includes(ref))).toEqual([]);
		const exhausted = queue("c", 50);
		expect(refs(exhausted)).toEqual([]);
		expect(exhausted.hasMore).toBe(false);
	});

	it("redelivers a failed pass's queue without consuming evidence", () => {
		const ref = source("again");
		pass("a");
		pass("b");
		expect(refs(queue("a", 1))).toEqual([ref]);
		db.exec("UPDATE dreaming_passes SET status='failed' WHERE id='a'");
		expect(refs(queue("b", 1))).toEqual([ref]);
		expect(db.query("SELECT COUNT(*) AS n FROM dreaming_evidence_consumption").get()).toEqual({ n: 0 });
	});
	it("settles disjoint reviewed queues and releases both owners' leases", async () => {
		const all = Array.from({ length: 6 }, (_, index) => source(`settle-${index}`));
		const pages: string[][] = [];
		let entered = 0;
		let release = (): void => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const executor: DreamingAgentExecutor = {
			async run(input) {
				pages.push(await readAndReview(input.tools, { limit: 3 }));
				entered++;
				if (entered === 2) release();
				await Promise.race([
					barrier,
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("peer never started")), 2_000)),
				]);
				return { summary: "Reviewed leased sources" };
			},
		};
		const accessor = accessorFor(db);
		await Promise.all(
			[1, 2].map(() =>
				runDreamingAgentPass(
					accessor,
					executor,
					{ ...DEFAULT_DREAMING, enabled: true },
					"/tmp",
					"alice",
					["alice"],
					"incremental",
					undefined,
					undefined,
					{ sharedScope: { evidenceLeaseMs: 60_000, attentionScopes: [] } },
				),
			),
		);
		expect(pages).toHaveLength(2);
		expect(pages.flat().sort()).toEqual(all.sort());
		expect(
			db.query("SELECT COUNT(*) AS n FROM dreaming_evidence_consumption WHERE delivered_offset = source_length").get(),
		).toEqual({ n: 6 });
		expect(db.query("SELECT COUNT(*) AS n FROM dreaming_evidence_leases").get()).toEqual({ n: 0 });
	});

	it("does not settle a peer-held source reviewed through a targeted lookup", async () => {
		const ref = source("targeted");
		pass("holder");
		lease("holder", [ref]);
		const executor: DreamingAgentExecutor = {
			async run(input) {
				expect(await readAndReview(input.tools, { sourceRef: ref })).toEqual([ref]);
				return { summary: "Historical review" };
			},
		};
		await runDreamingAgentPass(
			accessorFor(db),
			executor,
			{ ...DEFAULT_DREAMING, enabled: true },
			"/tmp",
			"alice",
			["alice"],
			"incremental",
		);
		expect(db.query("SELECT COUNT(*) AS n FROM dreaming_evidence_consumption").get()).toEqual({ n: 0 });
		expect(db.query("SELECT pass_id FROM dreaming_evidence_leases").all()).toEqual([{ pass_id: "holder" }]);
	});
});
