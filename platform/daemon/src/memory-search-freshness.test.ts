import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { type ResolvedMemoryConfig, loadMemoryConfig } from "./memory-config";
import { hybridRecall } from "./memory-search";
import { hasFreshnessIntent } from "./temporal-recall";

const DAY_MS = 86_400_000;
const TEST_NOW_MS = Date.now();
const OLDER_CREATED = new Date(TEST_NOW_MS - 130 * DAY_MS).toISOString();
const RECENT_CREATED = new Date(TEST_NOW_MS - 8 * DAY_MS).toISOString();

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
			).run("older-fact", "heron status level is red", OLDER_CREATED, OLDER_CREATED);
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, visibility, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'agent-a', 'global', ?, ?, 'test')`,
			).run("recent-fact", "heron status level is blue", RECENT_CREATED, RECENT_CREATED);
		});
	}

	// Keep this suite focused on ranking. Access-ledger writes are tested separately.
	async function recall(query: string, cfg: ResolvedMemoryConfig, trackRecallAccess = false) {
		return hybridRecall(
			{
				query,
				// Pin the lexical channel so both facts tie on BM25 and only the
				// temporal prior can break the tie.
				keywordQuery: "heron",
				limit: 5,
				agentId: "agent-a",
				readPolicy: "isolated",
				trackRecallAccess,
			},
			cfg,
			async () => null,
		);
	}

	it("ranks the recent fact first for a 'current status' query", async () => {
		seedFacts();
		const res = await recall("current status of heron", testCfg());
		expect(res.results.length).toBeGreaterThanOrEqual(2);
		expect(res.results[0]?.id).toBe("recent-fact");
	});

	it("does not change ordering for timeless queries", async () => {
		seedFacts();
		const enabled = await recall("heron status level", testCfg());
		const disabled = await recall("heron status level", testCfg({ temporal_prior_enabled: false }));
		expect(enabled.results.map((row) => row.id)).toEqual(disabled.results.map((row) => row.id));
	});

	it("awaits delayed rehearsal reads before ranking and teardown", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare("DELETE FROM memories WHERE id IN (?, ?)").run("older-fact", "recent-fact");
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, visibility, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'agent-a', 'global', ?, ?, 'test')`,
			).run("recent-fact", "heron status level is blue", RECENT_CREATED, RECENT_CREATED);
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, visibility, created_at, updated_at, updated_by, access_count, last_accessed
				) VALUES (?, ?, 'fact', 'agent-a', 'global', ?, ?, 'test', ?, ?)`,
			).run("older-fact", "heron status level is red", OLDER_CREATED, OLDER_CREATED, 20, new Date().toISOString());
		});

		const accessor = getDbAccessor();
		const originalWithReadDbAsync = accessor.withReadDbAsync;
		accessor.withReadDbAsync = async (fn, options) => {
			if (String(fn).includes("access_count")) await Bun.sleep(25);
			return await originalWithReadDbAsync(fn, options);
		};
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const result = await recall(
				"heron status level",
				testCfg({
					rehearsal_enabled: true,
					rehearsal_weight: 0.5,
					temporal_prior_enabled: false,
				}),
				false,
			);
			expect(result.results[0]?.id).toBe("older-fact");

			closeDbAccessor();
			await Bun.sleep(50);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			accessor.withReadDbAsync = originalWithReadDbAsync;
		}
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
				since: new Date(Date.parse(OLDER_CREATED) - DAY_MS).toISOString(),
				until: new Date(Date.parse(OLDER_CREATED) + DAY_MS).toISOString(),
			},
			testCfg(),
			async () => null,
		);
		expect(res.results.map((row) => row.id)).toEqual(["older-fact"]);
	});
});
