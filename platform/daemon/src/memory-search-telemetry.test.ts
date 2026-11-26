import { compartmentForWrite } from "../../core/src/compartment-shards";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compartmentFor } from "@signet/core";
import { executeClassification } from "./classification-owner";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import type { RecallResponse } from "./memory-search";
import { listMemorySearchTelemetry, recordMemorySearchTelemetry } from "./memory-search-telemetry";
import { resolveMemorySearchTelemetryProject } from "./memory-search-telemetry-project";

describe("memory search telemetry", () => {
	let dir = "";
	let prevSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-memory-search-telemetry-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    telemetry:
      memorySearchQaEnabled: true
`,
		);
		prevSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"));
		getDbAccessor().withWriteTx((db) =>
			db.exec(
				"INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('mem-1','Recall QA context','ant','now','now')",
			),
		);
	});

	afterEach(async () => {
		await closeDbAccessor();
		if (prevSignetPath === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = prevSignetPath;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	function response(): RecallResponse {
		return {
			query: "what did we decide about recall qa",
			method: "hybrid",
			results: [
				{
					id: "mem-1",
					content: "Recall QA should preserve enough context for manual review.",
					content_length: 61,
					truncated: false,
					score: 0.91,
					source: "memory",
					type: "decision",
					tags: "signet,recall",
					pinned: false,
					importance: 0.8,
					who: "ant",
					project: "/repo",
					created_at: "2026-05-06T00:00:00.000Z",
				},
			],
			meta: {
				totalReturned: 1,
				hasSupplementary: false,
				noHits: false,
				timings: {
					totalMs: 12.34,
					stages: [{ name: "memory_fts", durationMs: 1.2 }],
				},
			},
		};
	}

	it("stores query text, filters, timings, and result snapshots for QA", async () => {
		await recordMemorySearchTelemetry(getDbAccessor(), {
			route: "POST /api/memory/recall",
			agentId: "ant",
			sessionKey: "sess-1",
			project: "/repo",
			params: {
				query: "what did we decide about recall qa",
				keywordQuery: "recall qa",
				limit: 5,
				agentId: "ant",
				readPolicy: "isolated",
				project: "/repo",
			},
			response: response(),
			retentionDays: 90,
		});

		const items = await listMemorySearchTelemetry(getDbAccessor(), { agentId: "ant" });

		expect(items).toHaveLength(1);
		expect(items[0]?.query).toBe("what did we decide about recall qa");
		expect(items[0]?.keyword_query).toBe("recall qa");
		expect(items[0]?.filters.limit).toBe(5);
		expect(items[0]?.duration_ms).toBe(12.34);
		expect(items[0]?.results[0]?.rank).toBe(1);
		expect(items[0]?.results[0]?.content).toContain("manual review");
	});

	it("copies classified result labels and citations into telemetry", async () => {
		await getDbAccessor().withWriteTxAsync((db) => {
			db.exec(
				"INSERT INTO classifications(id,name) VALUES('cls_hr','HR'); INSERT INTO classification_assignments VALUES('memory','mem-1','ant','cls_hr','alice','now')",
			);
			const compartment = compartmentForWrite(db, { agentId: "ant", memoryId: "mem-1" });
			db.prepare("UPDATE memories SET compartment_id=? WHERE id='mem-1'").run(compartment);
		});
		await recordMemorySearchTelemetry(getDbAccessor(), {
			route: "test",
			agentId: "ant",
			sessionKey: null,
			project: null,
			params: { query: "secret" },
			response: response(),
			retentionDays: 90,
		});
		const persisted = await getDbAccessor().withReadDbAsync((db) => ({
			row: db.prepare("SELECT compartment_id FROM memory_search_telemetry").get(),
			citations: db
				.prepare("SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='telemetry'")
				.all(),
		}));
		expect(persisted.row).toEqual({ compartment_id: expect.any(Number) });
		expect(persisted.citations).toEqual([{ evidence_kind: "memory", evidence_id: "mem-1" }]);
	});

	it("does not persist snapshots whose result evidence cannot be resolved", async () => {
		for (const id of ["foreign-memory", "constructed:Private", "summary:digest"]) {
			const source = response();
			const result = source.results[0];
			if (!result) throw new Error("missing test result");
			await recordMemorySearchTelemetry(getDbAccessor(), {
				route: "test",
				agentId: "ant",
				sessionKey: null,
				project: null,
				params: { query: "private" },
				response: { ...source, results: [{ ...result, id }] },
				retentionDays: 90,
			});
		}
		expect(await listMemorySearchTelemetry(getDbAccessor(), {})).toEqual([]);
	});

	it("resolves telemetry project from effective recall params", () => {
		expect(resolveMemorySearchTelemetryProject({ project: "/repo" })).toBe("/repo");
		expect(resolveMemorySearchTelemetryProject({ project: "  /repo  " })).toBe("/repo");
		expect(resolveMemorySearchTelemetryProject({ project: "" })).toBeNull();
		expect(resolveMemorySearchTelemetryProject({})).toBeNull();
	});

	it("filters no-hit rows", async () => {
		const empty: RecallResponse = {
			query: "nothing here",
			method: "hybrid",
			results: [],
			meta: {
				totalReturned: 0,
				hasSupplementary: false,
				noHits: true,
				timings: { totalMs: 3, stages: [] },
			},
		};

		await recordMemorySearchTelemetry(getDbAccessor(), {
			route: "GET /api/memory/search",
			agentId: "ant",
			sessionKey: null,
			project: null,
			params: { query: "nothing here", agentId: "ant" },
			response: empty,
			retentionDays: 90,
		});

		expect(await listMemorySearchTelemetry(getDbAccessor(), { noHits: true })).toHaveLength(1);
		expect(await listMemorySearchTelemetry(getDbAccessor(), { noHits: false })).toHaveLength(0);
	});

	describe("compartment labels", () => {
		const scope = { reach: { kind: "all" as const }, compartments: [] as number[], projects: null };
		function seed(): { readonly hr: number; readonly legal: number; readonly both: number } {
			return getDbAccessor().withWriteTx((db) => {
				db.exec(`INSERT INTO agents(id, name, created_at, updated_at) VALUES ('ant', 'Ant', 'now', 'now'), ('peer', 'Peer', 'now', 'now');
					INSERT INTO classifications(id, name) VALUES ('cls_hr', 'HR'), ('cls_legal', 'Legal');`);
				const hr = compartmentFor(db, ["cls_hr"]);
				const legal = compartmentFor(db, ["cls_legal"]);
				const both = compartmentFor(db, ["cls_hr", "cls_legal"]);
				if (hr === null || legal === null || both === null) throw new Error("compartments missing");
				const insert = db.prepare(
					"INSERT INTO memories(id, content, type, agent_id, compartment_id, created_at, updated_at, updated_by) VALUES (?, ?, 'fact', ?, ?, 'now', 'now', 'test')",
				);
				insert.run("mem-hr", "hr memory", "ant", hr);
				insert.run("mem-legal", "legal memory", "ant", legal);
				insert.run("mem-open", "open memory", "ant", null);
				insert.run("mem-peer", "peer memory", "peer", hr);
				return { hr, legal, both };
			});
		}
		function result(id: string): RecallResponse["results"][number] {
			const base = response().results[0];
			if (!base) throw new Error("fixture missing");
			return { ...base, id, content: `${id} content` };
		}
		async function record(ids: readonly string[], sessionKey: string | null = "sess-1"): Promise<void> {
			const base = response();
			await recordMemorySearchTelemetry(getDbAccessor(), {
				route: "POST /api/memory/recall",
				agentId: "ant",
				sessionKey,
				project: null,
				params: { query: "labels", agentId: "ant" },
				response: { ...base, results: ids.map(result), meta: { ...base.meta, totalReturned: ids.length } },
				retentionDays: 90,
			});
		}
		function stored(): { readonly id: string; readonly compartment: unknown; readonly citations: unknown[] } {
			return getDbAccessor().withReadDb((db) => {
				const row = db.prepare("SELECT id, compartment_id FROM memory_search_telemetry").get();
				const id = typeof row?.id === "string" ? row.id : "";
				const citations = db
					.prepare(
						"SELECT agent_id, evidence_kind, evidence_id FROM evidence_citations WHERE derived_kind = 'telemetry' AND derived_id = ? ORDER BY evidence_id",
					)
					.all(id);
				return { id, compartment: row?.compartment_id, citations };
			});
		}

		it("labels a constructed snapshot from every copied claim and input compartment", async () => {
			const { hr, legal, both } = seed();
			getDbAccessor().withWriteTx((db) => {
				db.exec(
					"INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) VALUES ('telemetry-entity','Atlas','atlas','project','ant','now','now'); INSERT INTO entity_aspects(id,entity_id,agent_id,name,canonical_name,created_at,updated_at) VALUES ('telemetry-aspect','telemetry-entity','ant','Deploy','deploy','now','now')",
				);
				db.prepare(
					"INSERT INTO entity_attributes(id,aspect_id,agent_id,kind,content,normalized_content,compartment_id,created_at,updated_at) VALUES ('telemetry-claim','telemetry-aspect','ant','attribute','Classified claim','classified claim',?,'now','now')",
				).run(hr);
			});
			const base = response();
			await recordMemorySearchTelemetry(getDbAccessor(), {
				route: "constructed-probe",
				agentId: "ant",
				sessionKey: null,
				project: null,
				params: { query: "Atlas" },
				retentionDays: 90,
				response: {
					...base,
					results: [
						{
							...result("constructed:Atlas"),
							readProvenance: { compartmentIds: [legal], attributeIds: ["telemetry-claim"] },
						},
					],
				},
			});
			expect(stored()).toMatchObject({
				compartment: both,
				citations: [{ agent_id: "ant", evidence_kind: "attribute", evidence_id: "telemetry-claim" }],
			});
		});

		it("retains the labels of summary inputs trimmed from the returned results", async () => {
			const { hr } = seed();
			const base = response();
			await recordMemorySearchTelemetry(getDbAccessor(), {
				route: "summary-probe",
				agentId: "ant",
				sessionKey: null,
				project: null,
				params: { query: "Atlas" },
				retentionDays: 90,
				response: { ...base, results: [{ ...result("summary:probe"), readProvenance: { resultIds: ["mem-hr"] } }] },
			});
			expect(stored()).toMatchObject({
				compartment: hr,
				citations: [{ agent_id: "ant", evidence_kind: "memory", evidence_id: "mem-hr" }],
			});
		});

		it("inherits a pending classification before its evidence batch moves", async () => {
			const { hr } = seed();
			await getDbAccessor().withWriteTxAsync((db) => {
				db.prepare(
					"INSERT INTO classification_assignments(target_kind,target_id,agent_id,classification_id) VALUES ('memory','mem-open','ant','cls_hr')",
				).run();
			});
			await record(["mem-open"]);
			expect(stored().compartment).toBe(hr);
			expect(await listMemorySearchTelemetry(getDbAccessor(), { readScope: scope })).toEqual([]);
		});

		it("takes the union label of every returned result and cites each one", async () => {
			const { both } = seed();
			await record(["mem-hr", "mem-legal", "mem-open"]);
			expect(stored()).toMatchObject({
				compartment: both,
				citations: [
					{ agent_id: "ant", evidence_kind: "memory", evidence_id: "mem-hr" },
					{ agent_id: "ant", evidence_kind: "memory", evidence_id: "mem-legal" },
					{ agent_id: "ant", evidence_kind: "memory", evidence_id: "mem-open" },
				],
			});
		});

		it("labels cross-agent results without inventing citations the closure cannot follow", async () => {
			const { hr } = seed();
			await record(["mem-peer", "mem-open"]);
			expect(stored()).toMatchObject({
				compartment: hr,
				citations: [{ agent_id: "ant", evidence_kind: "memory", evidence_id: "mem-open" }],
			});
		});

		it("hides labelled telemetry from readers outside the label", async () => {
			const { hr } = seed();
			await record(["mem-open"]);
			await record(["mem-hr"]);
			const outside = await listMemorySearchTelemetry(getDbAccessor(), { readScope: scope });
			expect(outside.map((item) => item.results.map((row) => row.id))).toEqual([["mem-open"]]);
			const inside = await listMemorySearchTelemetry(getDbAccessor(), { readScope: { ...scope, compartments: [hr] } });
			expect(inside).toHaveLength(2);
		});

		it("follows reclassification of a cited memory through the telemetry copy edge", async () => {
			seed();
			await record(["mem-open"], null);
			expect(stored().compartment).toBeNull();
			const path = join(dir, "memory", "memories.db");
			await closeDbAccessor();
			const db = new Database(path);
			try {
				const actor = {
					userId: "carol",
					groupIds: [],
					local: false,
					compliance: true,
					boundAgentId: null,
					allowedProjects: null,
					credential: "session:test",
				};
				const target = { kind: "memory" as const, id: "mem-open", agentId: "ant" };
				const job = executeClassification(db, { op: "enqueue", actor, id: "cls_hr", target, remove: false });
				if (typeof job !== "object" || job === null || !("jobId" in job) || typeof job.jobId !== "string")
					throw new Error("missing job");
				executeClassification(db, { op: "execute", jobId: job.jobId });
				const memory = db.prepare("SELECT compartment_id FROM memories WHERE id = 'mem-open'").get();
				expect(memory?.compartment_id).toEqual(expect.any(Number));
				expect(db.prepare("SELECT compartment_id FROM memory_search_telemetry").get()).toEqual(memory);
			} finally {
				db.close();
				initDbAccessor(path);
			}
		});

		it("drops telemetry citations with the rows retention deletes", async () => {
			seed();
			await record(["mem-open"]);
			getDbAccessor().withWriteTx((db) => {
				db.prepare("UPDATE memory_search_telemetry SET created_at = '2000-01-01T00:00:00.000Z'").run();
			});
			await record(["mem-hr"]);
			const left = getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT evidence_id FROM evidence_citations WHERE derived_kind = 'telemetry'").all(),
			);
			expect(left).toEqual([{ evidence_id: "mem-hr" }]);
		});
	});
});
