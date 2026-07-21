import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { type ResolvedMemoryConfig, loadMemoryConfig } from "./memory-config";
import { hybridRecall } from "./memory-search";
import { hasFreshnessIntent } from "./temporal-recall";

const NOW_ISO = "2026-07-19T00:00:00.000Z";
const MARCH_CREATED = "2026-03-10T12:00:00.000Z";
const JULY_CREATED = "2026-07-10T12:00:00.000Z";

describe("hasFreshnessIntent", () => {
	it("detects explicit freshness terms", () => {
		expect(hasFreshnessIntent("current status of heron")).toBe(true);
		expect(hasFreshnessIntent("what is the latest on heron")).toBe(true);
		expect(hasFreshnessIntent("heron news today")).toBe(true);
		expect(hasFreshnessIntent("recently updated architecture")).toBe(true);
	});

	it("does not treat dates, month ranges, or bare now as freshness intent", () => {
		expect(hasFreshnessIntent("What did we plan in March?")).toBe(false);
		expect(hasFreshnessIntent("March 2026 retrospective")).toBe(false);
		expect(hasFreshnessIntent("what happened on March 15, 2026")).toBe(false);
		expect(hasFreshnessIntent("how does the embedding pipeline work now")).toBe(false);
	});

	it("does not fire for observed timeless production queries", () => {
		expect(hasFreshnessIntent("how does the embedding pipeline work")).toBe(false);
		expect(hasFreshnessIntent("what is Signet architecture")).toBe(false);
		expect(hasFreshnessIntent("GitHub bot configuration")).toBe(false);
	});
});

describe("hybridRecall freshness-aware rehearsal", () => {
	let dir = "";
	let prevSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-freshness-rehearsal-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "name: TemporalPriorTest\n");
		prevSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (prevSignetPath === undefined) {
			process.env.SIGNET_PATH = undefined;
		} else {
			process.env.SIGNET_PATH = prevSignetPath;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	function testCfg(overrides: Partial<ResolvedMemoryConfig["search"]> = {}): ResolvedMemoryConfig {
		const raw = loadMemoryConfig(dir);
		return {
			...raw,
			search: { ...raw.search, rehearsal_enabled: false, min_score: 0, ...overrides },
			pipelineV2: {
				...raw.pipelineV2,
				graph: { ...raw.pipelineV2.graph, enabled: false },
			},
		};
	}

	function seedFacts(): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, visibility, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'agent-a', 'global', ?, ?, 'test')`,
			).run("march-fact", "heron status level is red", MARCH_CREATED, MARCH_CREATED);
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, visibility, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'agent-a', 'global', ?, ?, 'test')`,
			).run("july-fact", "heron status level is blue", JULY_CREATED, JULY_CREATED);
		});
	}

	async function recall(query: string, cfg: ResolvedMemoryConfig) {
		return hybridRecall(
			{
				query,
				// Pin the lexical channel so both facts tie on BM25 and only the
				// temporal prior can break the tie.
				keywordQuery: "heron",
				limit: 5,
				agentId: "agent-a",
				readPolicy: "isolated",
				temporalNow: NOW_ISO,
			},
			cfg,
			async () => null,
		);
	}

	it("ranks the recent fact first for a 'current status' query", async () => {
		seedFacts();
		const res = await recall("current status of heron", testCfg());
		expect(res.results.length).toBeGreaterThanOrEqual(2);
		expect(res.results[0]?.id).toBe("july-fact");
	});

	it("does not change ordering for timeless queries", async () => {
		seedFacts();
		const enabled = await recall("heron status level", testCfg());
		const disabled = await recall("heron status level", testCfg({ temporal_prior_enabled: false }));
		expect(enabled.results.map((row) => row.id)).toEqual(disabled.results.map((row) => row.id));
	});

	it("does not add a second scoring path for month-range queries", async () => {
		seedFacts();
		const enabled = await recall("What did we plan for heron in March?", testCfg());
		const disabled = await recall("What did we plan for heron in March?", testCfg({ temporal_prior_enabled: false }));
		expect(enabled.results.map(({ id, score }) => ({ id, score }))).toEqual(
			disabled.results.map(({ id, score }) => ({ id, score })),
		);
	});

	it("skips the freshness boost when explicit since/until bounds are passed", async () => {
		seedFacts();
		const res = await hybridRecall(
			{
				query: "current status of heron",
				keywordQuery: "heron",
				limit: 5,
				agentId: "agent-a",
				readPolicy: "isolated",
				since: "2026-03-01T00:00:00.000Z",
				until: "2026-04-01T00:00:00.000Z",
				temporalNow: NOW_ISO,
			},
			testCfg(),
			async () => null,
		);
		expect(res.results.map((row) => row.id)).toEqual(["march-fact"]);
	});
});
