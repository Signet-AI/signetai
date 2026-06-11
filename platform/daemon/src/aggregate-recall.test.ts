import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest } from "@signetai/core";
import { type AggregateInferenceRouter, InvalidAggregateRecallBudgetError, aggregateRecall } from "./aggregate-recall";
import { normalizeAndHashContent } from "./content-normalization";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { getOrCreateInferenceRouter, resetInferenceRouterForTests } from "./inference-router";
import { loadMemoryConfig } from "./memory-config";
import type { RecallParams, RecallResponse, RecallResult } from "./memory-search";
import { txIngestEnvelope } from "./transactions";

const originalFetch = globalThis.fetch;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

function row(
	id: string,
	content: string,
	opts: { readonly visibility?: string | null; readonly scope?: string | null } = {},
): RecallResult {
	const now = "2026-05-20T12:00:00.000Z";
	return {
		id,
		content,
		content_length: content.length,
		truncated: false,
		score: 0.9,
		source: "hybrid",
		type: "semantic",
		tags: null,
		pinned: false,
		importance: 0.7,
		who: "test",
		project: null,
		created_at: now,
		visibility: "global",
		scope: null,
		...opts,
	};
}

function response(query: string, results: readonly RecallResult[]): RecallResponse {
	return {
		results: [...results],
		query,
		method: "hybrid",
		meta: {
			totalReturned: results.length,
			hasSupplementary: false,
			noHits: results.length === 0,
			timings: { totalMs: 0, stages: [] },
		},
	};
}

function aggregateKeyForTest(input: {
	readonly agentId: string;
	readonly project: string | null;
	readonly query: string;
	readonly budget: "small" | "medium" | "large";
	readonly sourceMemoryIds: readonly string[];
}): string {
	const hash = createHash("sha256")
		.update(input.agentId)
		.update("\0")
		.update(input.project ?? "")
		.update("\0")
		.update(input.query.trim().replace(/\s+/g, " ").toLowerCase())
		.update("\0")
		.update(input.budget)
		.update("\0")
		.update([...input.sourceMemoryIds].sort().join("\0"))
		.digest("hex");
	return `aggregate-recall:${hash}`;
}

class StaticRouter implements AggregateInferenceRouter {
	calls: RouteRequest[] = [];
	prompts: string[] = [];
	opts: Array<{
		readonly timeoutMs?: number;
		readonly maxTokens?: number;
		readonly refresh?: boolean;
		readonly acpxHooks?: "disabled" | "inherit";
	}> = [];

	constructor(private readonly synthesisText = "Aggregate answer from memory evidence.") {}

	async execute(
		request: RouteRequest,
		prompt: string,
		opts?: {
			readonly timeoutMs?: number;
			readonly maxTokens?: number;
			readonly refresh?: boolean;
			readonly acpxHooks?: "disabled" | "inherit";
		},
	): ReturnType<AggregateInferenceRouter["execute"]> {
		this.calls.push(request);
		this.prompts.push(prompt);
		this.opts.push(opts ?? {});
		const callNumber = this.calls.length;
		return {
			ok: true,
			value: {
				text: callNumber === 1 ? JSON.stringify({ queries: ["follow up one", "follow up two"] }) : this.synthesisText,
				usage: {
					inputTokens: callNumber * 10,
					outputTokens: callNumber,
					cacheReadTokens: callNumber,
					cacheCreationTokens: null,
					totalCost: callNumber / 1000,
					totalDurationMs: callNumber * 100,
				},
				attempts: [
					{
						targetRef: "test-router/default",
						ok: true,
						durationMs: callNumber * 100,
						usage: {
							inputTokens: callNumber * 10,
							outputTokens: callNumber,
							cacheReadTokens: callNumber,
							cacheCreationTokens: null,
							totalCost: callNumber / 1000,
							totalDurationMs: callNumber * 100,
						},
					},
				],
			},
		};
	}
}

function quietLogger(): { readonly warn: ReturnType<typeof mock> } {
	return {
		warn: mock((_category: string, _message: string, _data?: Record<string, unknown>) => {}),
	};
}

describe("aggregateRecall", () => {
	let dir = "";
	let prevSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-aggregate-recall-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "name: AggregateRecallTest\n");
		prevSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		globalThis.fetch = originalFetch;
		if (originalOpenAiApiKey === undefined) {
			Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
		} else {
			process.env.OPENAI_API_KEY = originalOpenAiApiKey;
		}
		resetInferenceRouterForTests();
		if (prevSignetPath === undefined) {
			Reflect.deleteProperty(process.env as Record<string, string | undefined>, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = prevSignetPath;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("rejects invalid aggregate budgets instead of falling back to small", async () => {
		await expect(
			aggregateRecall(
				{
					query: "what happened",
					aggregate: true,
					aggregateBudget: "maximum",
				} as unknown as RecallParams,
				loadMemoryConfig(dir),
				{
					router: new StaticRouter(),
					embedFn: async () => null,
					logger: quietLogger(),
					hybridRecall: async () => response("what happened", []),
				},
			),
		).rejects.toBeInstanceOf(InvalidAggregateRecallBudgetError);
	});

	it("synthesizes, saves one normal memory, and links evidence sources", async () => {
		const router = new StaticRouter();
		const calls: string[] = [];
		const result = await aggregateRecall(
			{
				query: "what happened",
				aggregate: true,
				aggregateBudget: "small",
				agentId: "agent-a",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			{
				router,
				embedFn: async () => null,
				logger: quietLogger(),
				now: () => new Date("2026-05-20T12:00:00.000Z"),
				idFactory: () => "aggregate-1",
				hybridRecall: async (params: RecallParams) => {
					calls.push(params.query);
					if (params.query === "follow up one") return response(params.query, [row("mem-2", "Second evidence")]);
					if (params.query === "follow up two") return response(params.query, [row("mem-3", "Third evidence")]);
					return response(params.query, [row("mem-1", "First evidence")]);
				},
			},
		);

		expect(calls).toEqual(["what happened", "follow up one", "follow up two"]);
		expect(router.calls.map((call) => call.operation)).toEqual(["session_synthesis", "session_synthesis"]);
		expect(router.opts.map((opts) => opts.acpxHooks)).toEqual(["disabled", "disabled"]);
		expect(router.prompts[1]).toContain("one concise atomic memory note");
		expect(router.prompts[1]).toContain("not as a direct reply");
		expect(router.prompts[1]).toContain("Restate the question's subject or relationship");
		expect(router.prompts[1]).toContain("partially answers the question");
		expect(router.prompts[1]).toContain("INSUFFICIENT_EVIDENCE");
		expect(result.results).toHaveLength(1);
		expect(result.results[0].id).toBe("aggregate-1");
		expect(result.results[0].source).toBe("aggregate-recall");
		expect(result.aggregate).toMatchObject({
			savedMemoryId: "aggregate-1",
			saved: true,
			deduped: false,
			sourceMemoryIds: ["mem-1", "mem-2", "mem-3"],
			stoppedReason: "complete",
			usage: {
				inputTokens: 30,
				outputTokens: 3,
				cacheReadTokens: 3,
				totalCost: 0.003,
				totalDurationMs: 300,
				stages: [
					{
						name: "planning",
						targetRef: "test-router/default",
						attemptCount: 1,
						fallbackCount: 0,
						inputTokens: 10,
					},
					{
						name: "synthesis",
						targetRef: "test-router/default",
						attemptCount: 1,
						fallbackCount: 0,
						inputTokens: 20,
					},
				],
			},
		});
		expect(result.meta.timings.stages.map((stage) => stage.name)).toEqual([
			"aggregate_initial_recall",
			"aggregate_planning",
			"aggregate_followup_recalls",
			"aggregate_synthesis",
			"aggregate_save",
			"aggregate_embedding",
		]);

		const saved = getDbAccessor().withReadDb((db) =>
			db
				.prepare("SELECT source_type, idempotency_key, tags, who, type, extraction_status FROM memories WHERE id = ?")
				.get("aggregate-1"),
		) as Record<string, unknown>;
		expect(saved.source_type).toBe("aggregate-recall");
		expect(saved.idempotency_key).toStartWith("aggregate-recall:");
		expect(saved.tags).toBe("aggregate,recall");
		expect(saved.who).toBe("signet");
		expect(saved.type).toBe("semantic");
		expect(saved.extraction_status).toBe("none");

		const extractJob = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT job_type, status FROM memory_jobs WHERE memory_id = ?").get("aggregate-1"),
		) as Record<string, unknown>;
		expect(extractJob).toEqual({ job_type: "extract", status: "pending" });

		const links = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					"SELECT source_memory_id FROM aggregate_memory_sources WHERE aggregate_memory_id = ? ORDER BY source_memory_id",
				)
				.all("aggregate-1"),
		) as Array<{ source_memory_id: string }>;
		expect(links.map((link) => link.source_memory_id)).toEqual(["mem-1", "mem-2", "mem-3"]);

		const hint = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT hint FROM memory_hints WHERE memory_id = ?").get("aggregate-1") as { hint: string },
		);
		expect(hint.hint).toBe("what happened");
	});

	it("synthesizes through a direct OpenAI-compatible API target without ACPX", async () => {
		writeFileSync(
			join(dir, "agent.yaml"),
			`name: AggregateRecallTest
memory:
  pipelineV2:
    extraction:
      provider: openai-compatible
      model: gpt-4o-mini
      endpoint: https://gateway.example.test/v1
    synthesis:
      enabled: false
`,
		);
		process.env.OPENAI_API_KEY = "test-openai-compatible-key";
		let chatCalls = 0;
		const seen: Array<{ readonly url: string; readonly authorization: string | null }> = [];
		globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			seen.push({ url, authorization: headers.get("authorization") });
			if (url.endsWith("/models")) {
				return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
			}
			chatCalls += 1;
			const content =
				chatCalls === 1
					? JSON.stringify({ queries: [] })
					: "Aggregate recall can synthesize directly through an OpenAI-compatible API target.";
			return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }));
		}) as unknown as typeof fetch;

		const result = await aggregateRecall(
			{
				query: "can aggregate recall use direct API models",
				aggregate: true,
				aggregateBudget: "small",
				saveAggregate: false,
				agentId: "agent-a",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			{
				router: getOrCreateInferenceRouter(dir),
				embedFn: async () => null,
				logger: quietLogger(),
				hybridRecall: async (params: RecallParams) =>
					response(params.query, [row("mem-api-1", "Aggregate recall should use the unified LLM provider.")]),
			},
		);

		expect(result.aggregate?.stoppedReason).toBe("complete");
		expect(result.results[0]?.content).toBe(
			"Aggregate recall can synthesize directly through an OpenAI-compatible API target.",
		);
		expect(chatCalls).toBe(2);
		expect(
			seen
				.filter((entry) => entry.url.endsWith("/chat/completions"))
				.every((entry) => entry.authorization === "Bearer test-openai-compatible-key"),
		).toBe(true);
		expect(seen.map((entry) => entry.url).filter((url) => url.startsWith("https://gateway.example.test/"))).toEqual([
			"https://gateway.example.test/v1/models",
			"https://gateway.example.test/v1/chat/completions",
			"https://gateway.example.test/v1/chat/completions",
		]);
	});

	it("dedupes repeated aggregate runs for the same evidence set", async () => {
		const params: RecallParams = {
			query: "what happened",
			aggregate: true,
			agentId: "agent-a",
			readPolicy: "isolated",
		};
		const deps = {
			router: new StaticRouter(),
			embedFn: async () => null,
			logger: quietLogger(),
			now: () => new Date("2026-05-20T12:00:00.000Z"),
			idFactory: () => "aggregate-1",
			hybridRecall: async (input: RecallParams) => response(input.query, [row("mem-1", "First evidence")]),
		};

		const first = await aggregateRecall(params, loadMemoryConfig(dir), deps);
		const second = await aggregateRecall(params, loadMemoryConfig(dir), {
			...deps,
			router: new StaticRouter(),
			idFactory: () => "aggregate-2",
		});

		expect(first.results[0].id).toBe("aggregate-1");
		expect(second.results[0].id).toBe("aggregate-1");
		expect(second.aggregate?.deduped).toBe(true);
		const hints = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT hint FROM memory_hints WHERE memory_id = ?").all("aggregate-1") as Array<{ hint: string }>,
		);
		expect(hints.map((hint) => hint.hint)).toEqual(["what happened"]);
	});

	it("runs planned follow-up recalls concurrently", async () => {
		let activeFollowups = 0;
		let maxActiveFollowups = 0;
		const result = await aggregateRecall(
			{
				query: "what happened",
				aggregate: true,
				saveAggregate: false,
				agentId: "agent-a",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			{
				router: new StaticRouter(),
				embedFn: async () => null,
				hybridRecall: async (input: RecallParams) => {
					if (input.query.startsWith("follow up")) {
						activeFollowups += 1;
						maxActiveFollowups = Math.max(maxActiveFollowups, activeFollowups);
						await new Promise((resolve) => setTimeout(resolve, 20));
						activeFollowups -= 1;
					}
					return response(input.query, [row(input.query, `${input.query} evidence`)]);
				},
			},
		);

		expect(result.results).toHaveLength(1);
		expect(maxActiveFollowups).toBe(2);
	});

	it("logs when a saved aggregate memory cannot be embedded", async () => {
		const log = quietLogger();
		const result = await aggregateRecall(
			{
				query: "what happened",
				aggregate: true,
				agentId: "agent-a",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			{
				router: new StaticRouter(),
				logger: log,
				embedFn: async () => {
					throw new Error("embedding provider unavailable");
				},
				now: () => new Date("2026-05-20T12:00:00.000Z"),
				idFactory: () => "aggregate-embed-fail",
				hybridRecall: async (input: RecallParams) => response(input.query, [row("mem-1", "First evidence")]),
			},
		);

		expect(result.aggregate).toMatchObject({
			savedMemoryId: "aggregate-embed-fail",
			saved: true,
			stoppedReason: "complete",
		});
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith(
			"memory",
			"Aggregate recall memory saved without embedding",
			expect.objectContaining({
				memoryId: "aggregate-embed-fail",
				agentId: "agent-a",
				reason: "embedding_exception",
				errorMessage: "embedding provider unavailable",
			}),
		);
	});

	it("returns an unsaved aggregate answer when saving is disabled", async () => {
		const result = await aggregateRecall(
			{
				query: "what happened",
				aggregate: true,
				saveAggregate: false,
				agentId: "agent-a",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			{
				router: new StaticRouter(),
				embedFn: async () => null,
				hybridRecall: async (input: RecallParams) => response(input.query, [row("mem-1", "First evidence")]),
			},
		);

		expect(result.results).toHaveLength(1);
		expect(result.results[0].content).toBe("Aggregate answer from memory evidence.");
		expect(result.aggregate?.saved).toBe(false);
		expect(result.aggregate?.savedMemoryId).toBeNull();
		const count = getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS n FROM memories").get()) as {
			n: number;
		};
		expect(count.n).toBe(0);
	});

	it("returns but does not save insufficient-evidence aggregate answers", async () => {
		const result = await aggregateRecall(
			{
				query: "what is Nicholai's favorite food?",
				aggregate: true,
				agentId: "agent-a",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			{
				router: new StaticRouter(
					"There isn't enough evidence here to determine Nicholai's favorite food. The only explicit preference shown is earl grey tea.",
				),
				embedFn: async () => null,
				logger: quietLogger(),
				idFactory: () => "aggregate-insufficient",
				hybridRecall: async (input: RecallParams) =>
					response(input.query, [row("mem-1", "Nicholai likes earl grey tea.")]),
			},
		);

		expect(result.results).toHaveLength(1);
		expect(result.aggregate).toMatchObject({
			savedMemoryId: null,
			saved: false,
			deduped: false,
			stoppedReason: "complete",
		});
		const count = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id = ?").get("aggregate-insufficient") as { n: number },
		);
		expect(count.n).toBe(0);
		const hints = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) AS n FROM memory_hints").get() as { n: number },
		);
		expect(hints.n).toBe(0);
	});

	it("returns but does not save conversational aggregate answers", async () => {
		const result = await aggregateRecall(
			{
				query: "does Nicholai like danishes?",
				aggregate: true,
				agentId: "agent-a",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			{
				router: new StaticRouter(
					'Yes. The evidence says Nicholai ate two gas station danishes and called them "amazing".',
				),
				embedFn: async () => null,
				logger: quietLogger(),
				idFactory: () => "aggregate-conversational",
				hybridRecall: async (input: RecallParams) =>
					response(input.query, [row("mem-1", 'Nicholai ate two gas station danishes and called them "amazing".')]),
			},
		);

		expect(result.results).toHaveLength(1);
		expect(result.aggregate).toMatchObject({
			savedMemoryId: null,
			saved: false,
			deduped: false,
			stoppedReason: "complete",
		});
		const count = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id = ?").get("aggregate-conversational") as {
					n: number;
				},
		);
		expect(count.n).toBe(0);
	});

	it("saves atomic partial answers when they restate the queried relationship", async () => {
		const result = await aggregateRecall(
			{
				query: "what are the problems going on between Amari and Nicholai?",
				aggregate: true,
				agentId: "agent-a",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			{
				router: new StaticRouter(
					"Nicholai and Amari broke up on March 14, 2026, were still figuring things out on May 12, and by May 20 Nicholai felt ready to move on.",
				),
				embedFn: async () => null,
				logger: quietLogger(),
				now: () => new Date("2026-05-20T12:00:00.000Z"),
				idFactory: () => "aggregate-atomic-partial",
				hybridRecall: async (input: RecallParams) =>
					response(input.query, [
						row("mem-1", "Nicholai and Amari broke up on March 14, 2026; by May 20 Nicholai felt ready to move on."),
					]),
			},
		);

		expect(result.results[0].content).toContain("Nicholai and Amari");
		expect(result.aggregate).toMatchObject({
			savedMemoryId: "aggregate-atomic-partial",
			saved: true,
			stoppedReason: "complete",
		});
	});

	it("does not save global aggregate memories from private evidence", async () => {
		const result = await aggregateRecall(
			{
				query: "private history",
				aggregate: true,
				agentId: "agent-private",
			},
			loadMemoryConfig(dir),
			{
				router: new StaticRouter(),
				embedFn: async () => null,
				logger: quietLogger(),
				idFactory: () => "aggregate-private",
				hybridRecall: async (params: RecallParams) =>
					response(params.query, [row("mem-private", "Private evidence", { visibility: "private" })]),
			},
		);

		expect(result.results[0].id).toStartWith("aggregate-recall:");
		expect(result.aggregate).toMatchObject({
			savedMemoryId: null,
			saved: false,
			deduped: false,
			stoppedReason: "complete",
		});
		const count = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id = ?").get("aggregate-private") as { n: number },
		);
		expect(count.n).toBe(0);
	});

	it("does not save aggregate memories when evidence lacks explicit global scope metadata", async () => {
		const result = await aggregateRecall(
			{
				query: "legacy history",
				aggregate: true,
				agentId: "agent-legacy",
			},
			loadMemoryConfig(dir),
			{
				router: new StaticRouter(),
				embedFn: async () => null,
				logger: quietLogger(),
				idFactory: () => "aggregate-legacy",
				hybridRecall: async (params: RecallParams) =>
					response(params.query, [
						row("mem-legacy", "Legacy evidence without scope metadata", {
							visibility: undefined,
							scope: undefined,
						}),
					]),
			},
		);

		expect(result.results[0].id).toStartWith("aggregate-recall:");
		expect(result.aggregate).toMatchObject({
			savedMemoryId: null,
			saved: false,
			deduped: false,
			stoppedReason: "complete",
		});
		const count = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id = ?").get("aggregate-legacy") as { n: number },
		);
		expect(count.n).toBe(0);
	});

	it("does not link synthesized recall rows as aggregate memory sources", async () => {
		const result = await aggregateRecall(
			{
				query: "what happened",
				aggregate: true,
				agentId: "agent-a",
			},
			loadMemoryConfig(dir),
			{
				router: new StaticRouter(),
				embedFn: async () => null,
				logger: quietLogger(),
				now: () => new Date("2026-05-20T12:00:00.000Z"),
				idFactory: () => "aggregate-sources",
				hybridRecall: async (params: RecallParams) =>
					response(params.query, [
						{
							...row("summary:abc", "Synthetic summary should not be provenance"),
							source: "llm_summary",
							supplementary: true,
						},
						row("mem-1", "Real evidence"),
					]),
			},
		);

		expect(result.aggregate?.sourceMemoryIds).toEqual(["mem-1"]);
		const links = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT source_memory_id FROM aggregate_memory_sources WHERE aggregate_memory_id = ? ORDER BY source_memory_id",
					)
					.all("aggregate-sources") as Array<{ source_memory_id: string }>,
		);
		expect(links.map((link) => link.source_memory_id)).toEqual(["mem-1"]);
	});

	it("returns unsaved aggregate when content hash conflicts with an inaccessible memory", async () => {
		const answer = "Aggregate answer from memory evidence.";
		const normalized = normalizeAndHashContent(answer);
		const now = "2026-05-20T12:00:00.000Z";
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, normalized_content, content_hash, who, project, type,
					agent_id, visibility, created_at, updated_at, updated_by
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"private-duplicate",
				answer,
				normalized.normalizedContent || normalized.hashBasis,
				normalized.contentHash,
				"test",
				"other-project",
				"semantic",
				"agent-a",
				"private",
				now,
				now,
				"test",
			);
		});

		const result = await aggregateRecall(
			{
				query: "what happened",
				aggregate: true,
				agentId: "agent-a",
				readPolicy: "isolated",
				project: "current-project",
			},
			loadMemoryConfig(dir),
			{
				router: new StaticRouter(),
				embedFn: async () => null,
				idFactory: () => "aggregate-conflict",
				hybridRecall: async (input: RecallParams) => response(input.query, [row("mem-1", "First evidence")]),
			},
		);

		expect(result.results).toHaveLength(1);
		expect(result.results[0].id).toStartWith("aggregate-recall:");
		expect(result.aggregate).toMatchObject({
			savedMemoryId: null,
			saved: false,
			deduped: true,
			stoppedReason: "complete",
		});
		const aggregateRows = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id = ?").get("aggregate-conflict"),
		) as { n: number };
		expect(aggregateRows.n).toBe(0);
	});

	it("does not reuse visible ordinary memories as saved aggregate dedupes", async () => {
		const answer = "Aggregate answer from memory evidence.";
		const normalized = normalizeAndHashContent(answer);
		const now = "2026-05-20T12:00:00.000Z";
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, normalized_content, content_hash, who, project, type,
					agent_id, visibility, source_type, created_at, updated_at, updated_by
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"ordinary-duplicate",
				answer,
				normalized.normalizedContent || normalized.hashBasis,
				normalized.contentHash,
				"test",
				"current-project",
				"semantic",
				"agent-a",
				"global",
				"manual",
				now,
				now,
				"test",
			);
		});

		const result = await aggregateRecall(
			{
				query: "what happened",
				aggregate: true,
				agentId: "agent-a",
				readPolicy: "isolated",
				project: "current-project",
			},
			loadMemoryConfig(dir),
			{
				router: new StaticRouter(),
				embedFn: async () => null,
				idFactory: () => "aggregate-visible-conflict",
				hybridRecall: async (input: RecallParams) => response(input.query, [row("mem-1", "First evidence")]),
			},
		);

		expect(result.results).toHaveLength(1);
		expect(result.results[0].id).toStartWith("aggregate-recall:");
		expect(result.results[0].id).not.toBe("ordinary-duplicate");
		expect(result.aggregate).toMatchObject({
			savedMemoryId: null,
			saved: false,
			deduped: true,
			stoppedReason: "complete",
		});
		const rows = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					`SELECT
						(SELECT COUNT(*) FROM memories WHERE id = 'aggregate-visible-conflict') AS aggregate_count,
						(SELECT COUNT(*) FROM aggregate_memory_sources WHERE aggregate_memory_id = 'ordinary-duplicate') AS link_count`,
				)
				.get(),
		) as { aggregate_count: number; link_count: number };
		expect(rows.aggregate_count).toBe(0);
		expect(rows.link_count).toBe(0);
	});

	it("does not reuse ordinary memories with matching aggregate idempotency keys", async () => {
		const content = "Ordinary memory with caller-provided idempotency.";
		const normalized = normalizeAndHashContent(content);
		const now = "2026-05-20T12:00:00.000Z";
		const key = aggregateKeyForTest({
			agentId: "agent-a",
			project: "current-project",
			query: "what happened",
			budget: "small",
			sourceMemoryIds: ["mem-1"],
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, normalized_content, content_hash, idempotency_key,
					who, project, type, agent_id, visibility, source_type,
					created_at, updated_at, updated_by
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"ordinary-idempotency-match",
				content,
				normalized.normalizedContent || normalized.hashBasis,
				normalized.contentHash,
				key,
				"test",
				"current-project",
				"semantic",
				"agent-a",
				"global",
				"manual",
				now,
				now,
				"test",
			);
		});

		const result = await aggregateRecall(
			{
				query: "what happened",
				aggregate: true,
				agentId: "agent-a",
				readPolicy: "isolated",
				project: "current-project",
			},
			loadMemoryConfig(dir),
			{
				router: new StaticRouter(),
				embedFn: async () => null,
				idFactory: () => "aggregate-idempotency-safe",
				hybridRecall: async (input: RecallParams) => response(input.query, [row("mem-1", "First evidence")]),
			},
		);

		expect(result.results).toHaveLength(1);
		expect(result.results[0].id).toStartWith("aggregate-recall:");
		expect(result.results[0].id).not.toBe("ordinary-idempotency-match");
		expect(result.aggregate).toMatchObject({
			savedMemoryId: null,
			saved: false,
			deduped: true,
			stoppedReason: "complete",
		});
		const rows = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					`SELECT
						(SELECT COUNT(*) FROM aggregate_memory_sources WHERE aggregate_memory_id = 'ordinary-idempotency-match') AS ordinary_link_count,
						(SELECT COUNT(*) FROM memories WHERE id = 'aggregate-idempotency-safe') AS aggregate_count,
						(SELECT COUNT(*) FROM aggregate_memory_sources WHERE aggregate_memory_id = 'aggregate-idempotency-safe') AS aggregate_link_count`,
				)
				.get(),
		) as { ordinary_link_count: number; aggregate_count: number; aggregate_link_count: number };
		expect(rows.ordinary_link_count).toBe(0);
		expect(rows.aggregate_count).toBe(0);
		expect(rows.aggregate_link_count).toBe(0);
	});

	it("dedupes when a concurrent aggregate insert wins the content-hash race", async () => {
		let raced = false;
		const result = await aggregateRecall(
			{
				query: "what happened",
				aggregate: true,
				agentId: "agent-a",
				readPolicy: "isolated",
				project: "current-project",
			},
			loadMemoryConfig(dir),
			{
				router: new StaticRouter(),
				embedFn: async () => null,
				idFactory: () => "aggregate-loser",
				hybridRecall: async (input: RecallParams) => response(input.query, [row("mem-1", "First evidence")]),
				ingestEnvelope: (db, mem) => {
					if (!raced) {
						raced = true;
						txIngestEnvelope(db, {
							...mem,
							id: "aggregate-race-winner",
						});
					}
					return txIngestEnvelope(db, mem);
				},
			},
		);

		expect(result.results).toHaveLength(1);
		expect(result.results[0].id).toBe("aggregate-race-winner");
		expect(result.aggregate).toMatchObject({
			savedMemoryId: "aggregate-race-winner",
			saved: true,
			deduped: true,
			stoppedReason: "complete",
		});
		const rows = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					`SELECT
						(SELECT COUNT(*) FROM memories WHERE id = 'aggregate-loser') AS loser_count,
						(SELECT COUNT(*) FROM aggregate_memory_sources WHERE aggregate_memory_id = 'aggregate-race-winner') AS link_count,
						(SELECT COUNT(*) FROM memory_jobs WHERE memory_id = 'aggregate-race-winner' AND job_type = 'extract' AND status = 'pending') AS pending_extract_count`,
				)
				.get(),
		) as { loser_count: number; link_count: number; pending_extract_count: number };
		expect(rows.loser_count).toBe(0);
		expect(rows.link_count).toBe(1);
		expect(rows.pending_extract_count).toBe(1);
	});

	it("returns structured no-hit metadata when synthesis is unavailable", async () => {
		const result = await aggregateRecall(
			{
				query: "what happened",
				aggregate: true,
				agentId: "agent-a",
				readPolicy: "isolated",
			},
			loadMemoryConfig(dir),
			{
				router: null,
				embedFn: async () => null,
				hybridRecall: async (input: RecallParams) => response(input.query, [row("mem-1", "First evidence")]),
			},
		);

		expect(result.results).toEqual([]);
		expect(result.meta.noHits).toBe(true);
		expect(result.aggregate).toMatchObject({
			saved: false,
			savedMemoryId: null,
			stoppedReason: "router_unavailable",
			sourceMemoryIds: ["mem-1"],
		});
		expect(result.meta.timings.stages.map((stage) => stage.name)).toEqual(["aggregate_initial_recall"]);
	});
});
