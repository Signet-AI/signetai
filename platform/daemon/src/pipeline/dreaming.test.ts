import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DreamingConfig } from "@signet/core";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor, ReadDb } from "../db-accessor";
import { type TelemetryCollector, type TelemetryEvent, setActiveTelemetry } from "../telemetry";
import { countTokens, resetTokenizerStats, tokenizerStats } from "../pipeline/tokenizer";
import {
	DREAMING_AGENT_PROMPT,
	DREAMING_CONTENT_AGENT_PROMPT,
	DREAMING_FAILURE_HALT_THRESHOLD,
	DREAMING_HALT_COOLDOWN_MS,
	DREAMING_HYGIENE_AGENT_PROMPT,
	type DreamingState,
	_testParseEpisodicCursor,
	dreamingEarlyExitSummary,
	enqueueDreamingHygieneAttention,
	getDreamingEpisodicTokenBacklog,
	getDreamingEvidenceExclusions,
	getDreamingPasses,
	getDreamingState,
	getDreamingToolCalls,
	isDreamingHaltActive,
	isDreamingScopeHalted,
	recordDreamingFailure,
	requestDreamingEvidenceRequeue,
	runDreamingAgentPass,
	selectDreamingPassMode,
	shouldTriggerDreaming,
} from "./dreaming";
import {
	enqueueDreamingAttentionInTx,
	getDreamingAttention,
	getDreamingAttentionSnapshots,
	resolveDreamingAttentionInTx,
} from "./dreaming-attention";
import { pendingDreamingEvidenceContinuations } from "./dreaming-evidence-consumption";
import { renderDreamingEvidence } from "./dreaming-evidence";
import { searchEpisodicSources } from "../episodic-sources";
import {
	autoRequeueRepairedDreamingEvidence,
	collectRejectedDreamingEvidence,
	resolveRequeuedDreamingEvidenceInTx,
} from "./dreaming-evidence-retry";
import { readDreamingRunbook } from "./dreaming-runbook";

const AGENT = "default";

function defaultCfg(overrides?: Partial<DreamingConfig>): DreamingConfig {
	return {
		tokenThreshold: 100_000,
		maxInterval: 6 * 60 * 60 * 1_000,
		maxInputTokens: 32_000,
		maxOutputTokens: 16_000,
		timeout: 300_000,
		backfillOnFirstRun: true,
		...overrides,
	};
}

function wrapDb(db: Database): DbAccessor {
	return {
		withReadDb<T>(fn: (db: Database) => T): T {
			return fn(db);
		},
		withReadDbAsync<T>(fn: (db: Database) => Promise<T>): Promise<T> {
			return fn(db);
		},
		withWriteTxAsync<T>(fn: (db: Database) => T): Promise<T> {
			return Promise.resolve().then(() => {
				db.exec("BEGIN IMMEDIATE");
				try {
					const result = fn(db);
					db.exec("COMMIT");
					return result;
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			});
		},
		withWriteTx<T>(fn: (db: Database) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db);
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as DbAccessor;
}

function captureTelemetry(): { readonly collector: TelemetryCollector; readonly events: TelemetryEvent[] } {
	const events: TelemetryEvent[] = [];
	const collector: TelemetryCollector = {
		enabled: true,
		record(event, properties): void {
			events.push({ id: "test", event, timestamp: "2026-01-01T00:00:00.000Z", properties });
		},
		async flush(): Promise<void> {},
		start(): void {},
		async stop(): Promise<void> {},
		query(): readonly TelemetryEvent[] {
			return events;
		},
	};
	return { collector, events };
}

function seedTranscript(db: Database, id: string, content: string, capturedAt?: string, agentId = AGENT): void {
	const timestamp = capturedAt ?? (db.prepare("SELECT datetime('now') AS now").get() as { now: string }).now;
	db.prepare(
		`INSERT INTO session_transcripts
		 (session_key, content, agent_id, created_at, updated_at, completed_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	).run(id, content, agentId, timestamp, timestamp, timestamp);
}

function seedArtifact(
	db: Database,
	path: string,
	content: string,
	revision: string,
	capturedAt: string,
	agentId = AGENT,
): void {
	db.prepare(
		`INSERT INTO memory_artifacts
		 (agent_id, source_path, source_sha256, source_kind, session_id, session_key, session_token,
		  captured_at, content, updated_at, is_deleted)
		 VALUES (?, ?, ?, 'source_obsidian_markdown', ?, ?, ?, ?, ?, ?, 0)`,
	).run(
		agentId,
		path,
		revision,
		`session-${path}`,
		`session-${path}`,
		`token-${path}`,
		capturedAt,
		content,
		capturedAt,
	);
}

function seedSummary(db: Database, id: string, content: string, tokens: number, agentId = AGENT): void {
	// Keep a legacy row for explicit provenance-compatibility assertions, but
	// seed the canonical direct transcript path used by Dreaming's default
	// evidence selector.
	const timestamp = (db.prepare("SELECT datetime('now') AS now").get() as { now: string }).now;
	db.prepare(
		`INSERT INTO session_transcripts
		 (session_key, content, agent_id, created_at, updated_at, completed_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	).run(id, content, agentId, timestamp, timestamp, timestamp);
	db.prepare(
		`INSERT INTO session_summaries
		 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
		 VALUES (?, ?, ?, ?, 0, 'session', 'summary', datetime('now'), datetime('now'), datetime('now'))`,
	).run(id, agentId, content, tokens);
}

describe("Dreaming", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = wrapDb(db);
	});

	afterEach(() => {
		setActiveTelemetry(undefined);
		db.close();
	});

	it("round-trips only canonical episodic cursor kinds", () => {
		for (const kind of ["memory", "artifact", "transcript", "summary"] as const) {
			const cursor = { capturedAt: "2026-03-01T00:00:00.000Z", kind, id: `id-${kind}` };
			expect(_testParseEpisodicCursor(JSON.stringify(cursor))).toEqual(cursor);
		}
		expect(_testParseEpisodicCursor(JSON.stringify({ capturedAt: "2026-01-01", kind: "unknown", id: "x" }))).toBeNull();
		expect(
			_testParseEpisodicCursor(
				JSON.stringify({ capturedAt: "2026-03-01T00:00:00.000Z", kind: "summary", id: "fragment", fragmentOffset: 12 }),
			),
		).toEqual({ capturedAt: "2026-03-01T00:00:00.000Z", kind: "summary", id: "fragment", fragmentOffset: 12 });
		expect(
			_testParseEpisodicCursor(
				JSON.stringify({ capturedAt: "2026-03-01T00:00:00.000Z", kind: "summary", id: "fragment", fragmentOffset: -1 }),
			),
		).toEqual({ capturedAt: "2026-03-01T00:00:00.000Z", kind: "summary", id: "fragment" });
	});

	it("keeps backlog checks off the synchronous BPE encoder (#1552)", async () => {
		seedTranscript(
			db,
			"large-backlog",
			"function parseEvidence(input) { return input?.items?.filter((item) => item.active); }\n\n" +
				"The backlog must preserve exact token semantics for operator-tuned thresholds.",
		);
		const source = searchEpisodicSources(db as unknown as ReadDb, {
			agentId: AGENT,
			query: "",
			excludeDelivered: true,
			limit: 50,
		})[0];
		if (source === undefined) throw new Error("test fixture did not create an episodic source");
		const expected = countTokens(renderDreamingEvidence(source));
		resetTokenizerStats();

		expect(await getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBe(expected);
		expect(expected).not.toBe(Math.ceil(renderDreamingEvidence(source).length / 4));
		expect(tokenizerStats.encodeCalls).toBe(0);
		expect(tokenizerStats.encodeChars).toBe(0);
	});

	it("keeps backlog cache entries isolated from colon-containing agent IDs (#1555)", async () => {
		const leftAgent = "cache-collision-left";
		const leftSource = "cache-collision-source";
		const rightAgent = `${leftAgent}:transcript:${leftSource}:0`;
		seedTranscript(db, leftSource, "The left scope has a distinct exact token count.", undefined, leftAgent);
		seedTranscript(
			db,
			"cache-collision-other",
			"The right scope must not overwrite the left scope. ".repeat(10),
			undefined,
			rightAgent,
		);

		const leftInitial = await getDreamingEpisodicTokenBacklog(accessor, leftAgent);
		await getDreamingEpisodicTokenBacklog(accessor, rightAgent);

		expect(rightAgent).toContain(":");
		expect(await getDreamingEpisodicTokenBacklog(accessor, leftAgent)).toBe(leftInitial);
	});

	it("keeps the event loop responsive during a large exact-BPE backlog refresh (#1552, #1543)", async () => {
		for (let i = 0; i < 50; i += 1) {
			seedTranscript(
				db,
				`large-backlog-${i}`,
				`function parseEvidence${i}(input) { return input?.items?.filter((item) => item.active); }\n` +
					"The unreachable provider must not turn exact BPE backlog accounting into a main-thread wedge.\n" +
					"prose ".repeat(2_000),
			);
		}

		const latencies: number[] = [];
		let measuring = true;
		const measureLoop = async (): Promise<void> => {
			while (measuring) {
				const start = performance.now();
				await new Promise<void>((resolve) => setImmediate(resolve));
				latencies.push(performance.now() - start);
			}
		};
		const measurePromise = measureLoop();

		const pass = runDreamingAgentPass(
			accessor,
			{
				async run() {
					throw new Error("provider unavailable");
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental",
		);
		await expect(pass).rejects.toThrow("provider unavailable");
		measuring = false;
		await measurePromise;

		expect(Math.max(...latencies)).toBeLessThan(200);
		expect(latencies.length).toBeGreaterThan(2);
	});

	it("drains oversized evidence only after every delivered fragment completes (#1430)", async () => {
		seedTranscript(db, "s1", "x".repeat(5_000));
		expect(await getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBeGreaterThan(0);
		let prompt = "";
		const run = async () =>
			runDreamingAgentPass(
				accessor,
				{
					async run(input) {
						prompt = input.prompt;
						// The scan-first listing surfaces the pending evidence, so
						// the pass-end watermark legitimately advances to it and
						// the same evidence must not re-trigger the next pass.
						const search = input.tools.find((tool) => tool.name === "search_evidence");
						if (!search) throw new Error("Missing search_evidence");
						await search.execute("call", { agentId: AGENT }, undefined, undefined, {} as never);
						return { summary: "Done" };
					},
				},
				defaultCfg(),
				"/tmp",
				AGENT,
				[AGENT],
				"incremental",
			);
		const result = await run();
		expect(result.summary).toBe("Done");
		expect(prompt).toBe(DREAMING_AGENT_PROMPT);
		const firstDelivery = (await getDreamingToolCalls(accessor, AGENT, result.passId)).find(
			(call) => call.toolName === "search_evidence",
		);
		expect(firstDelivery?.output).toMatchObject({
			items: [expect.objectContaining({ sourceRef: "transcript:s1", contentOffset: 0, contentLength: 5_000 })],
		});
		const partial = db
			.prepare(
				"SELECT delivered_offset AS offset, source_length AS length FROM dreaming_evidence_consumption WHERE source_id = ?",
			)
			.get("s1") as { offset: number; length: number } | null;
		expect(partial).toEqual(expect.objectContaining({ length: 5_000 }));
		expect(partial?.offset).toBeGreaterThan(0);
		expect(partial?.offset).toBeLessThan(partial?.length ?? 0);
		expect(await getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBeGreaterThan(0);

		const second = await run();
		const secondDelivery = (await getDreamingToolCalls(accessor, AGENT, second.passId)).find(
			(call) => call.toolName === "search_evidence",
		);
		expect(secondDelivery?.output).toMatchObject({
			items: [expect.objectContaining({ sourceRef: "transcript:s1", contentOffset: 2_000, contentLength: 5_000 })],
		});
		// The second pass records the next contiguous fragment; the final
		// 1,000-character fragment remains pending until a third pass.
		expect(await getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBeGreaterThan(0);
		await run();
		expect(await getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBe(0);
	}, 15_000);

	it("does not consume evidence delivered by a failed pass (#1430)", async () => {
		seedTranscript(db, "failed-delivery", "Evidence must survive an interrupted pass.");
		await expect(
			runDreamingAgentPass(
				accessor,
				{
					async run(input) {
						const search = input.tools.find((tool) => tool.name === "search_evidence");
						if (!search) throw new Error("Missing search_evidence");
						await search.execute("call", { agentId: AGENT }, undefined, undefined, {} as never);
						throw new Error("interrupted after delivery");
					},
				},
				defaultCfg(),
				"/tmp",
				AGENT,
				[AGENT],
				"incremental-content",
			),
		).rejects.toThrow("interrupted after delivery");
		expect(
			(
				db
					.prepare("SELECT COUNT(*) AS count FROM dreaming_evidence_consumption WHERE source_id = ?")
					.get("failed-delivery") as {
					count: number;
				}
			).count,
		).toBe(0);
		expect(await getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBeGreaterThan(0);
	});

	it("does not acknowledge an artifact revision replaced during a pass (#1430)", async () => {
		const capturedAt = "2026-08-11T00:00:00.000Z";
		seedArtifact(db, "sources/revised.md", "The old revision was delivered.", "sha-old", capturedAt);
		await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const search = input.tools.find((tool) => tool.name === "search_evidence");
					if (!search) throw new Error("Missing search_evidence");
					await search.execute("call", { agentId: AGENT }, undefined, undefined, {} as never);
					db.prepare("UPDATE memory_artifacts SET content = ?, source_sha256 = ? WHERE source_path = ?").run(
						"The replacement revision must be delivered again.",
						"sha-new",
						"sources/revised.md",
					);
					return { summary: "Source changed while this pass ran" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental-content",
		);
		expect(
			(
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM dreaming_evidence_consumption WHERE source_id = ? AND source_revision = ?",
					)
					.get("sources/revised.md", "sha-new") as { count: number }
			).count,
		).toBe(0);
		expect(await getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBeGreaterThan(0);
	});

	it("keeps deferred delivery pending in its owning agent scope (#1430)", async () => {
		const otherAgent = "other";
		seedTranscript(db, "deferred-delivery", "Default scope may acknowledge the matching ref.", undefined, AGENT);
		seedTranscript(db, "deferred-delivery", "Evidence the agent names as deferred.", undefined, otherAgent);
		await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const search = input.tools.find((tool) => tool.name === "search_evidence");
					const write = input.tools.find((tool) => tool.name === "runbook_write");
					if (!search || !write) throw new Error("Missing Dreaming delivery tools");
					await search.execute("call", { agentId: AGENT }, undefined, undefined, {} as never);
					await search.execute("call", { agentId: otherAgent }, undefined, undefined, {} as never);
					await write.execute(
						"call",
						{
							summary: "## Deferred\n- transcript:deferred-delivery remains mid-stream",
							deferredEvidence: [{ agentId: otherAgent, sourceRef: "transcript:deferred-delivery" }],
						},
						undefined,
						undefined,
						{} as never,
					);
					return { summary: "Deferred source" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT, otherAgent],
			"incremental-content",
		);
		expect(
			(
				db
					.prepare("SELECT COUNT(*) AS count FROM dreaming_evidence_consumption WHERE agent_id = ?")
					.get(otherAgent) as {
					count: number;
				}
			).count,
		).toBe(0);
		expect(
			(
				db.prepare("SELECT COUNT(*) AS count FROM dreaming_evidence_consumption WHERE agent_id = ?").get(AGENT) as {
					count: number;
				}
			).count,
		).toBe(1);
		expect(await getDreamingEpisodicTokenBacklog(accessor, otherAgent)).toBeGreaterThan(0);
	});

	it("replaces a historical summary DAG row with the direct transcript projection", async () => {
		const capturedAt = "2026-08-06T12:00:00.000Z";
		seedTranscript(
			db,
			"legacy-session",
			"User: inspect it\nAssistant: [tool call: git]\nTool output: secret",
			capturedAt,
		);
		db.prepare(
			`INSERT INTO session_summaries
			 (id, agent_id, content, token_count, depth, kind, session_key, source_type, earliest_at, latest_at, created_at)
			 VALUES (?, ?, ?, ?, 0, 'session', ?, 'summary', ?, ?, ?)`,
		).run("legacy-summary-node", AGENT, "old derived summary", 3, "legacy-session", capturedAt, capturedAt, capturedAt);
		db.prepare(
			`INSERT INTO session_summaries
			 (id, agent_id, content, token_count, depth, kind, session_key, source_type, earliest_at, latest_at, created_at)
			 VALUES (?, ?, ?, ?, 0, 'session', ?, 'compaction', ?, ?, ?)`,
		).run("compaction-node", AGENT, "compaction evidence", 2, "legacy-session", capturedAt, capturedAt, capturedAt);

		await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const search = input.tools.find((tool) => tool.name === "search_evidence");
					if (!search) throw new Error("Missing search_evidence");
					await search.execute("call", { agentId: AGENT }, undefined, undefined, {} as never);
					return { summary: "Projected transcript" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental",
		);

		const nodes = db
			.prepare(
				"SELECT id, source_type, content, meta_json FROM session_summaries WHERE agent_id = ? AND session_key = ? AND depth = 0 ORDER BY id",
			)
			.all(AGENT, "legacy-session") as Array<{ id: string; source_type: string; content: string; meta_json: string }>;
		const node = nodes.find((candidate) => candidate.id === "legacy-summary-node");
		expect(node).toMatchObject({ id: "legacy-summary-node", source_type: "transcript" });
		expect(node?.content).toContain("[tool call: git]");
		expect(node?.content).not.toContain("secret");
		expect(JSON.parse(node?.meta_json ?? "{}")).toMatchObject({ source: "dreaming-content-pass" });
		expect(nodes.find((candidate) => candidate.id === "compaction-node")).toMatchObject({
			source_type: "compaction",
			content: "compaction evidence",
		});
		expect(nodes).toHaveLength(2);
		const threadHead = db
			.prepare(
				"SELECT node_id, source_type, source_ref FROM memory_thread_heads WHERE agent_id = ? AND session_key = ?",
			)
			.get(AGENT, "legacy-session") as { node_id: string; source_type: string; source_ref: string } | null;
		expect(threadHead).toEqual({
			node_id: "legacy-summary-node",
			source_type: "transcript",
			source_ref: "legacy-session",
		});
	});

	it("uses wall-clock backoff independently of later evidence volume", async () => {
		seedSummary(db, "first", "episodic source", 10);
		await recordDreamingFailure(accessor, AGENT);
		const failedAt = Date.parse((await getDreamingState(accessor, AGENT)).lastFailureAt ?? "");
		const cfg = defaultCfg({ tokenThreshold: 1, backfillOnFirstRun: false });
		expect(await shouldTriggerDreaming(accessor, cfg, AGENT, failedAt + 10 * 60 * 1000 - 1)).toBe(false);
		seedSummary(db, "later", "episodic source ".repeat(3_000), 3_000);
		expect(await shouldTriggerDreaming(accessor, cfg, AGENT, failedAt + 10 * 60 * 1000)).toBe(true);
	});

	it("halts automatic scheduling after repeated consecutive failures", async () => {
		seedSummary(db, "first", "episodic source", 10);
		for (let i = 0; i < DREAMING_FAILURE_HALT_THRESHOLD; i += 1) {
			await recordDreamingFailure(accessor, AGENT);
		}
		const failedAt = Date.parse((await getDreamingState(accessor, AGENT)).lastFailureAt ?? "");
		const cfg = defaultCfg({ tokenThreshold: 1, backfillOnFirstRun: false });
		// Halted: a large backlog and fresh attention must not trigger a pass
		// inside the cooldown window.
		seedSummary(db, "later", "episodic source ".repeat(3_000), 3_000);
		expect(await shouldTriggerDreaming(accessor, cfg, AGENT, failedAt + 60 * 1000)).toBe(false);
		// Cooldown elapsed: scheduling resumes (the next failure re-halts).
		expect(await shouldTriggerDreaming(accessor, cfg, AGENT, failedAt + DREAMING_HALT_COOLDOWN_MS + 1_000)).toBe(true);
	});

	it("isDreamingScopeHalted gates on the failure threshold and cooldown", () => {
		const base = (overrides: Partial<DreamingState>): DreamingState => ({
			consecutiveFailures: 0,
			lastFailureAt: null,
			lastPassAt: null,
			evidenceCursor: null,
			lastPassId: null,
			lastPassMode: null,
			...overrides,
		});
		const fresh = { lastFailureAt: "2026-08-05 12:00:00" };
		expect(
			isDreamingScopeHalted(
				base({ ...fresh, consecutiveFailures: DREAMING_FAILURE_HALT_THRESHOLD - 1 }),
				Date.parse("2026-08-05 12:30:00"),
			),
		).toBe(false);
		expect(
			isDreamingScopeHalted(
				base({ ...fresh, consecutiveFailures: DREAMING_FAILURE_HALT_THRESHOLD }),
				Date.parse("2026-08-05 12:30:00"),
			),
		).toBe(true);
		expect(
			isDreamingScopeHalted(
				base({ ...fresh, consecutiveFailures: DREAMING_FAILURE_HALT_THRESHOLD }),
				Date.parse("2026-08-05 12:00:00") + DREAMING_HALT_COOLDOWN_MS + 1_000,
			),
		).toBe(false);
		expect(
			isDreamingScopeHalted(base({ lastFailureAt: null, consecutiveFailures: 99 }), Date.parse("2026-08-05 12:30:00")),
		).toBe(false);
	});

	it("isDreamingHaltActive reads the halt state through the accessor", async () => {
		for (let i = 0; i < DREAMING_FAILURE_HALT_THRESHOLD - 1; i += 1) {
			await recordDreamingFailure(accessor, AGENT);
		}
		expect(await isDreamingHaltActive(accessor, AGENT)).toBe(false);
		await recordDreamingFailure(accessor, AGENT);
		expect(await isDreamingHaltActive(accessor, AGENT)).toBe(true);
	});

	it("schedules a near-term continuation only after the latest capped content delivery (#1430)", async () => {
		const now = Date.now();
		const capturedAt = new Date(now).toISOString();
		const passId = "partial-content-pass";
		seedTranscript(db, "continuation-transcript", "x".repeat(5_000), capturedAt);
		accessor.withWriteTx((tx) => {
			tx.prepare(
				`INSERT INTO dreaming_state (agent_id, last_pass_at, last_pass_id, last_pass_mode)
				 VALUES (?, ?, ?, 'incremental-content')`,
			).run(AGENT, capturedAt, passId);
			tx.prepare(
				`INSERT INTO dreaming_evidence_consumption
				 (agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision,
				  delivered_offset, source_length, pass_id, updated_at)
				 VALUES (?, 'transcript', 'continuation-transcript', ?, '', ?, 2_000, 5_000, ?, ?)`,
			).run(AGENT, capturedAt, capturedAt, passId, capturedAt);
		});
		const cfg = defaultCfg({ tokenThreshold: 100_000, backfillOnFirstRun: false });
		expect(await shouldTriggerDreaming(accessor, cfg, AGENT, now)).toBe(true);

		// A subsequent no-progress pass gets a new id. It may be retried later
		// through the normal threshold/interval policy, but it cannot spin here.
		accessor.withWriteTx((tx) => {
			tx.prepare("UPDATE dreaming_state SET last_pass_id = ? WHERE agent_id = ?").run("no-progress-pass", AGENT);
		});
		expect(await shouldTriggerDreaming(accessor, cfg, AGENT, now)).toBe(false);

		// Completion clears the continuation even when it was the latest pass.
		accessor.withWriteTx((tx) => {
			tx.prepare("UPDATE dreaming_state SET last_pass_id = ? WHERE agent_id = ?").run(passId, AGENT);
			tx.prepare("UPDATE dreaming_evidence_consumption SET delivered_offset = source_length WHERE pass_id = ?").run(
				passId,
			);
		});
		expect(await shouldTriggerDreaming(accessor, cfg, AGENT, now)).toBe(false);

		// Scheduler failure backoff gates a partial continuation like every other
		// automatic pass. It cannot bypass error recovery or the failure halt.
		accessor.withWriteTx((tx) => {
			tx.prepare("UPDATE dreaming_evidence_consumption SET delivered_offset = 2_000 WHERE pass_id = ?").run(passId);
		});
		await recordDreamingFailure(accessor, AGENT);
		expect(await shouldTriggerDreaming(accessor, cfg, AGENT, now)).toBe(false);
	});

	it("pins a capped frontier ahead of newer evidence on its next pass (#1430)", async () => {
		const now = Date.now();
		const cfg = defaultCfg({ tokenThreshold: 100_000, backfillOnFirstRun: false });
		seedTranscript(db, "partial-frontier", "x".repeat(5_000), new Date(now).toISOString());
		const run = async () =>
			runDreamingAgentPass(
				accessor,
				{
					async run(input) {
						const search = input.tools.find((tool) => tool.name === "search_evidence");
						if (!search) throw new Error("Missing search_evidence");
						await search.execute("call", { agentId: AGENT }, undefined, undefined, {} as never);
						return { summary: "Delivered current evidence page" };
					},
				},
				cfg,
				"/tmp",
				AGENT,
				[AGENT],
				"incremental-content",
			);

		const first = await run();
		for (let index = 0; index < 20; index += 1) {
			seedTranscript(
				db,
				`newer-${index}`,
				"New evidence that would fill the ordinary newest-first page.",
				new Date(now + (index + 1) * 1_000).toISOString(),
			);
		}
		expect(await shouldTriggerDreaming(accessor, cfg, AGENT, now + 21_000)).toBe(true);

		const second = await run();
		const delivery = (await getDreamingToolCalls(accessor, AGENT, second.passId)).find(
			(call) => call.toolName === "search_evidence",
		);
		expect(delivery?.output).toMatchObject({
			items: [expect.objectContaining({ sourceRef: "transcript:partial-frontier", contentOffset: 2_000 })],
		});
		expect(
			db
				.prepare(
					"SELECT pass_id AS passId, delivered_offset AS offset FROM dreaming_evidence_consumption WHERE source_id = ?",
				)
				.get("partial-frontier"),
		).toEqual({ passId: second.passId, offset: 4_000 });
		// The progression moved to the second pass, so the final page remains a
		// bounded continuation rather than falling behind the newer evidence.
		expect(second.passId).not.toBe(first.passId);
		expect(await shouldTriggerDreaming(accessor, cfg, AGENT, now + 21_000)).toBe(true);
	}, 15_000);

	it("rotates every capped partial frontier before revisiting a newer subset (#1430)", async () => {
		// Regression for #1434: when 50 source revisions were partial and a
		// 20-source page advanced, selecting only last_pass_id made the other
		// 30 older rows unreachable. The scan must choose an unadvanced prior
		// subset even while the newer partial rows still exist.
		const capturedAt = "2026-08-11T00:00:00.000Z";
		const priorPassId = "prior-partial-pass";
		const newerPassId = "newer-partial-pass";
		accessor.withWriteTx((tx) => {
			tx.prepare(
				"INSERT INTO dreaming_passes (id, agent_id, mode, status) VALUES (?, ?, 'incremental-content', 'completed')",
			).run(priorPassId, AGENT);
			tx.prepare(
				"INSERT INTO dreaming_passes (id, agent_id, mode, status) VALUES (?, ?, 'incremental-content', 'completed')",
			).run(newerPassId, AGENT);
			tx.prepare("INSERT INTO dreaming_state (agent_id, last_pass_at, last_pass_id) VALUES (?, ?, ?)").run(
				AGENT,
				capturedAt,
				newerPassId,
			);
			const insertConsumption = tx.prepare(
				`INSERT INTO dreaming_evidence_consumption
				 (agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision,
				  delivered_offset, source_length, pass_id, updated_at)
				 VALUES (?, 'transcript', ?, ?, '', ?, 10, 100, ?, ?)`,
			);
			for (let index = 0; index < 50; index += 1) {
				const id = `${index < 20 ? "newer" : "prior"}-partial-${index.toString().padStart(2, "0")}`;
				seedTranscript(db, id, "x".repeat(100), capturedAt);
				insertConsumption.run(AGENT, id, capturedAt, capturedAt, index < 20 ? newerPassId : priorPassId, capturedAt);
			}
		});

		const result = await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const search = input.tools.find((tool) => tool.name === "search_evidence");
					if (!search) throw new Error("Missing search_evidence");
					await search.execute("call", { agentId: AGENT, limit: 20 }, undefined, undefined, {} as never);
					return { summary: "Rotated capped evidence frontiers" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental-content",
		);
		const delivery = (await getDreamingToolCalls(accessor, AGENT, result.passId)).find(
			(call) => call.toolName === "search_evidence",
		);
		const refs = ((delivery?.output as { items?: Array<{ sourceRef?: string }> } | undefined)?.items ?? []).map(
			(item) => item.sourceRef,
		);
		expect(refs).toHaveLength(20);
		expect(refs.every((ref) => ref?.startsWith("transcript:prior-partial-"))).toBe(true);
		expect(refs).not.toContain("transcript:newer-partial-00");
	}, 15_000);

	it("keeps continuation selection SQL-bounded while skipping stale revisions (#1434)", () => {
		const capturedAt = "2026-08-11T00:00:00.000Z";
		const stalePassId = "stale-partial-pass";
		const priorPassId = "prior-partial-pass";
		const newerPassId = "newer-partial-pass";
		accessor.withWriteTx((tx) => {
			for (const passId of [stalePassId, priorPassId, newerPassId]) {
				tx.prepare(
					"INSERT INTO dreaming_passes (id, agent_id, mode, status) VALUES (?, ?, 'incremental-content', 'completed')",
				).run(passId, AGENT);
			}
			const insertConsumption = tx.prepare(
				`INSERT INTO dreaming_evidence_consumption
				 (agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision,
				  delivered_offset, source_length, pass_id, updated_at)
				 VALUES (?, 'transcript', ?, ?, '', ?, 10, 100, ?, ?)`,
			);
			for (let index = 0; index < 200; index += 1) {
				insertConsumption.run(AGENT, `stale-partial-${index}`, capturedAt, capturedAt, stalePassId, capturedAt);
			}
			for (let index = 0; index < 30; index += 1) {
				const id = `prior-partial-${index.toString().padStart(2, "0")}`;
				seedTranscript(db, id, "x".repeat(100), capturedAt);
				insertConsumption.run(AGENT, id, capturedAt, capturedAt, priorPassId, capturedAt);
			}
			for (let index = 0; index < 20; index += 1) {
				const id = `newer-partial-${index.toString().padStart(2, "0")}`;
				seedTranscript(db, id, "x".repeat(100), capturedAt);
				insertConsumption.run(AGENT, id, capturedAt, capturedAt, newerPassId, capturedAt);
			}
		});

		const continuationQueries: string[] = [];
		const continuationArgs: unknown[][] = [];
		const tracedDb = {
			prepare(sql: string) {
				const statement = db.prepare(sql);
				if (!sql.includes("FROM dreaming_evidence_consumption dec")) return statement;
				continuationQueries.push(sql);
				return new Proxy(statement, {
					get(target, property, receiver) {
						const value = Reflect.get(target, property, receiver);
						if (property === "all") {
							return (...args: unknown[]) => {
								continuationArgs.push(args);
								return Reflect.apply(target.all, target, args);
							};
						}
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			},
		} as unknown as ReadDb;
		const first = pendingDreamingEvidenceContinuations(tracedDb, AGENT, 20);
		expect(continuationQueries).toHaveLength(1);
		expect(continuationQueries[0]).toContain("LIMIT ?");
		expect(continuationArgs).toEqual([[AGENT, null, null, 20]]);
		expect(first.map((source) => source.id)).toEqual(
			Array.from({ length: 20 }, (_, index) => `prior-partial-${index.toString().padStart(2, "0")}`),
		);

		accessor.withWriteTx((tx) => {
			tx.prepare(
				"UPDATE dreaming_evidence_consumption SET delivered_offset = source_length WHERE pass_id = ? AND source_id < ?",
			).run(priorPassId, "prior-partial-20");
		});
		const second = pendingDreamingEvidenceContinuations(db as unknown as ReadDb, AGENT, 20);
		expect(second.map((source) => source.id)).toEqual([
			...Array.from({ length: 10 }, (_, index) => `prior-partial-${(index + 20).toString().padStart(2, "0")}`),
			...Array.from({ length: 10 }, (_, index) => `newer-partial-${index.toString().padStart(2, "0")}`),
		]);
	});

	it("indexes continuation lookup by agent and pass (#1430)", () => {
		const plan = db
			.prepare(
				`EXPLAIN QUERY PLAN SELECT 1 FROM dreaming_evidence_consumption
				 WHERE agent_id = ? AND pass_id = ?
				   AND delivered_offset > 0 AND delivered_offset < source_length
				 LIMIT 1`,
			)
			.all(AGENT, "partial-content-pass") as Array<{ detail: string }>;
		expect(plan.map((row) => row.detail).join("\n")).toContain("idx_dreaming_evidence_consumption_continuation");
	});

	it("runs a low-volume episodic backlog once its maximum wait elapses", async () => {
		const now = Date.now();
		seedSummary(db, "trickle", "small episodic source", 10);
		accessor.withWriteTx((tx) => {
			tx.prepare(
				`INSERT INTO dreaming_state (agent_id, last_pass_at)
				 VALUES (?, ?)`,
			).run(AGENT, new Date(now - 6 * 60 * 60 * 1_000).toISOString());
		});
		const cfg = defaultCfg({ tokenThreshold: 100_000, maxInterval: 6 * 60 * 60 * 1_000, backfillOnFirstRun: false });
		expect(await shouldTriggerDreaming(accessor, cfg, AGENT, now - 1)).toBe(false);
		expect(await shouldTriggerDreaming(accessor, cfg, AGENT, now)).toBe(true);
	});

	it("counts the full scan-first episodic backlog beyond one search page (#1559)", async () => {
		const contents = Array.from({ length: 51 }, (_, index) => `pending episodic source ${index}`);
		for (const [index, content] of contents.entries()) {
			seedArtifact(db, `imports/pending-${index}.md`, content, `revision-${index}`, "2026-08-01T00:00:00.000Z");
		}
		const expected = contents.reduce((total, content) => total + countTokens(content), 0);
		const backlog = await getDreamingEpisodicTokenBacklog(accessor, AGENT);

		expect(backlog).toBe(expected);
		expect(
			await shouldTriggerDreaming(accessor, defaultCfg({ tokenThreshold: expected, backfillOnFirstRun: false }), AGENT),
		).toBe(true);
	});

	it("runs a pass when attention is pending and leaves it for the agent to consume", async () => {
		accessor.withWriteTx((tx) => {
			enqueueDreamingAttentionInTx(tx, {
				agentId: AGENT,
				kind: "review_due",
				subjectRef: "entity:aster",
				details: { reason: "review_after reached" },
				priority: 90,
			});
		});
		expect(await shouldTriggerDreaming(accessor, defaultCfg(), AGENT)).toBe(true);

		let prompt = "";
		const result = await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					prompt = input.prompt;
					return { summary: "Reviewed due claim" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental",
		);

		expect(result.summary).toBe("Reviewed due claim");
		expect(prompt).toBe(DREAMING_AGENT_PROMPT);
		// Attention is not auto-resolved: the agent consumes it via a flag +
		// archive batch, which is covered by the operations suite.
		expect(getDreamingAttention(accessor, AGENT)).toHaveLength(1);
	});

	it("resolves attention the agent explicitly declined with decline_attention (#1185)", async () => {
		let attentionId = "";
		accessor.withWriteTx((tx) => {
			attentionId = enqueueDreamingAttentionInTx(tx, {
				agentId: AGENT,
				kind: "hygiene",
				subjectRef: "entity:aster",
				details: { reason: "flagged for archive review" },
				priority: 90,
			});
		});
		expect(await shouldTriggerDreaming(accessor, defaultCfg(), AGENT)).toBe(true);

		const result = await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					// The agent surfaces the flag via attention_list, inspects
					// the target, and judges it a deliberate keep — the
					// affirmative decline closes the record.
					const apply = input.tools.find((tool) => tool.name === "apply_ontology_ops");
					if (!apply) throw new Error("Missing apply_ontology_ops");
					const out = (await apply.execute(
						"call",
						{
							agentId: AGENT,
							operations: [{ operation: "decline_attention", payload: { attentionId } }],
						},
						undefined,
						undefined,
						{} as never,
					)) as { content?: Array<{ text?: string }> };
					const parsed = JSON.parse(out.content?.[0]?.text ?? "") as { ok: boolean };
					if (!parsed.ok) throw new Error(`decline_attention failed: ${out.content?.[0]?.text}`);
					return { summary: "Reviewed and kept" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental",
		);

		expect(result.summary).toBe("Reviewed and kept");
		// The agent judged the flag and kept the target: the explicit decline
		// closes it, so declined work stops re-triggering passes.
		expect(getDreamingAttention(accessor, AGENT)).toHaveLength(0);
	});

	it("leaves listed-but-unfinished attention pending when the pass defers it (over-resolution regression)", async () => {
		const ids: string[] = [];
		accessor.withWriteTx((tx) => {
			for (const subject of ["entity:aster", "entity:birch", "entity:cedar"]) {
				ids.push(
					enqueueDreamingAttentionInTx(tx, {
						agentId: AGENT,
						kind: "hygiene",
						subjectRef: subject,
						details: { reason: "flagged for archive review" },
						priority: 90,
					}),
				);
			}
		});
		expect(await shouldTriggerDreaming(accessor, defaultCfg(), AGENT)).toBe(true);

		await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					// The agent works the queue, closes one flag it judged to
					// keep, and defers the rest with reasons in the pass log —
					// the runbook-sanctioned state. Mere listing must not
					// resolve the deferred records.
					const apply = input.tools.find((tool) => tool.name === "apply_ontology_ops");
					if (!apply) throw new Error("Missing apply_ontology_ops");
					const out = (await apply.execute(
						"call",
						{
							agentId: AGENT,
							operations: [{ operation: "decline_attention", payload: { attentionId: ids[0] } }],
						},
						undefined,
						undefined,
						{} as never,
					)) as { content?: Array<{ text?: string }> };
					const parsed = JSON.parse(out.content?.[0]?.text ?? "") as { ok: boolean };
					if (!parsed.ok) throw new Error(`decline_attention failed: ${out.content?.[0]?.text}`);
					return { summary: "Declined aster; deferred birch and cedar in the pass log" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental",
		);

		// Exactly the declined record resolves; the deferred two stay pending
		// for a later pass instead of being silently dropped.
		expect(getDreamingAttention(accessor, AGENT)).toHaveLength(2);
	});

	it("navigates semantic state through scoped tools instead of a partial graph snapshot", async () => {
		const evidence = "The deployment is now handled by Aster.";
		seedSummary(db, "navigation-summary", evidence, 8);
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at)
			 VALUES ('snapshot-sentinel', 'Static Snapshot Sentinel', 'static snapshot sentinel', 'project', ?, 1, 0, datetime('now'), datetime('now'))`,
		).run(AGENT);
		let prompt = "";
		let toolNames: readonly string[] = [];
		await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					prompt = input.prompt;
					toolNames = input.tools.map((tool) => tool.name);
					return { summary: "Navigated graph through tools" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental",
		);
		expect(prompt).toBe(DREAMING_AGENT_PROMPT);
		expect(toolNames).toEqual(
			expect.arrayContaining(["search_entities", "get_entity", "list_aspect_claims", "walk_links", "attention_list"]),
		);
	});

	it("turns deterministic graph hygiene into scoped attention without episodic evidence", async () => {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES ('legacy-husk', 'Legacy Husk', 'legacy husk', 'project', ?, 5, datetime('now'), datetime('now'))`,
		).run(AGENT);
		expect(await enqueueDreamingHygieneAttention(accessor, AGENT)).toBeGreaterThan(0);
		expect(getDreamingAttention(accessor, AGENT)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "hygiene",
					subjectRef: "entity:legacy-husk",
					details: expect.objectContaining({ reason: "zero_active_attributes" }),
				}),
			]),
		);
		expect(await shouldTriggerDreaming(accessor, defaultCfg(), AGENT)).toBe(true);
		const snapshots = getDreamingAttentionSnapshots(accessor, AGENT);
		accessor.withWriteTx((tx) => resolveDreamingAttentionInTx(tx, AGENT, "pass-hygiene", snapshots));
		await enqueueDreamingHygieneAttention(accessor, AGENT);
		expect(getDreamingAttention(accessor, AGENT)).toEqual([]);
		db.prepare("UPDATE entities SET name = 'Renamed legacy husk' WHERE id = 'legacy-husk'").run();
		await enqueueDreamingHygieneAttention(accessor, AGENT);
		expect(getDreamingAttention(accessor, AGENT)).toContainEqual(
			expect.objectContaining({
				subjectRef: "entity:legacy-husk",
				details: expect.objectContaining({ name: "Renamed legacy husk" }),
			}),
		);
	});

	it("enqueues over-cap attention rows when caps are supplied (#1138)", async () => {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES ('fat-entity', 'Fat Entity', 'fat entity', 'project', ?, 5, datetime('now'), datetime('now'))`,
		).run(AGENT);
		db.prepare(
			`INSERT INTO entity_aspects
			 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES ('fat-aspect', 'fat-entity', ?, 'status_history', 'status_history', 0.5, datetime('now'), datetime('now'))`,
		).run(AGENT);
		for (let i = 0; i < 7; i++) {
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance,
				  status, group_key, claim_key, version, created_at, updated_at)
				 VALUES (?, 'fat-aspect', ?, 'fact', ?, ?, 0.9, 0.5, 'active', 'general', ?, 1, datetime('now'), datetime('now'))`,
			).run(`attr-${i}`, AGENT, `content ${i}`, `content ${i}`, `key-${i}`);
		}

		const caps = { maxAspectsPerEntity: 20, maxAttributesPerAspect: 5 };
		await enqueueDreamingHygieneAttention(accessor, AGENT, 50, caps);
		expect(getDreamingAttention(accessor, AGENT)).toContainEqual(
			expect.objectContaining({
				kind: "hygiene",
				subjectRef: "aspect:fat-aspect",
				details: expect.objectContaining({
					reason: "attribute_over_cap",
					attributeCount: "7",
					maxAttributesPerAspect: "5",
				}),
			}),
		);
	});

	it("reopens duplicate hygiene attention when group membership changes", async () => {
		for (const [id, name] of [
			["acme-a", "Acme"],
			["acme-b", "ACME"],
		] as const) {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, 'acme', 'project', ?, 1, datetime('now'), datetime('now'))`,
			).run(id, name, AGENT);
		}
		await enqueueDreamingHygieneAttention(accessor, AGENT);
		const snapshots = getDreamingAttentionSnapshots(accessor, AGENT);
		accessor.withWriteTx((tx) => resolveDreamingAttentionInTx(tx, AGENT, "pass-duplicates", snapshots));
		db.prepare("DELETE FROM entities WHERE id = 'acme-b'").run();
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES ('acme-c', 'Acme Inc.', 'acme', 'project', ?, 1, datetime('now'), datetime('now'))`,
		).run(AGENT);
		await enqueueDreamingHygieneAttention(accessor, AGENT);
		expect(getDreamingAttention(accessor, AGENT)).toContainEqual(
			expect.objectContaining({ subjectRef: "duplicate:acme", details: expect.objectContaining({ count: "2" }) }),
		);
	});

	it("keeps semantic attention pending when its pass fails", async () => {
		const telemetry = captureTelemetry();
		setActiveTelemetry(telemetry.collector);
		accessor.withWriteTx((tx) => {
			enqueueDreamingAttentionInTx(tx, {
				agentId: AGENT,
				kind: "contested_claim",
				subjectRef: "claim:aster:owner",
				details: { reason: "conflicting evidence" },
			});
		});

		await expect(
			runDreamingAgentPass(
				accessor,
				{
					async run() {
						throw new Error("provider unavailable");
					},
				},
				defaultCfg(),
				"/tmp",
				AGENT,
				[AGENT],
				"incremental",
			),
		).rejects.toThrow("provider unavailable");
		expect(telemetry.events).toContainEqual(
			expect.objectContaining({
				event: "pipeline.error",
				properties: { stage: "decision", code: "DECISION_INVALID" },
			}),
		);
		expect(getDreamingAttention(accessor, AGENT)).toContainEqual(
			expect.objectContaining({ kind: "contested_claim", subjectRef: "claim:aster:owner" }),
		);
	});

	it("keeps a same-subject requeue made during a pass for the next pass", async () => {
		accessor.withWriteTx((tx) => {
			enqueueDreamingAttentionInTx(tx, {
				agentId: AGENT,
				kind: "hygiene",
				subjectRef: "entity:aster",
			});
		});

		await runDreamingAgentPass(
			accessor,
			{
				async run() {
					accessor.withWriteTx((tx) => {
						enqueueDreamingAttentionInTx(tx, {
							agentId: AGENT,
							kind: "hygiene",
							subjectRef: "entity:aster",
						});
					});
					return { summary: "Reviewed once" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental",
		);

		expect(getDreamingAttention(accessor, AGENT)).toContainEqual(
			expect.objectContaining({ kind: "hygiene", subjectRef: "entity:aster" }),
		);
	});

	it("turns an explicit evidence requeue into scoped semantic attention", async () => {
		db.prepare(
			`INSERT INTO dreaming_evidence_exclusions
			 (agent_id, source_kind, source_id, reason, pass_id, excluded_at, requeue_requested_at, resolved_at)
			 VALUES (?, 'summary', 'retry-summary', 'semantic_operation_rejected', 'failed-pass', datetime('now'), NULL, NULL)`,
		).run(AGENT);

		expect(await requestDreamingEvidenceRequeue(accessor, AGENT, "summary", "retry-summary")).toBe(true);
		const attention = getDreamingAttention(accessor, AGENT);
		expect(attention).toEqual([
			expect.objectContaining({
				kind: "evidence_requeue",
				subjectRef: "summary:retry-summary",
				details: { sourceKind: "summary", sourceId: "retry-summary" },
			}),
		]);
		expect(Object.keys(attention[0] ?? {})).not.toContain("detailsJson");
	});

	it("classifies rejected evidence by the repair that can make it retryable", () => {
		const timestamp = "2026-08-10T12:00:00.000Z";
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, content, agent_id, created_at, updated_at, completed_at)
			 VALUES ('incomplete', 'still running', ?, ?, ?, NULL)`,
		).run(AGENT, timestamp, timestamp);
		seedTranscript(db, "quote-changed", "The repaired source has new wording.", timestamp);
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, content, agent_id, created_at, updated_at, completed_at)
			 VALUES ('other-scope', 'private evidence', 'other-agent', ?, ?, ?)`,
		).run(timestamp, timestamp, timestamp);

		const operations = [
			{ evidence: [{ source_ref: "transcript:incomplete", quote: "still running" }] },
			{ evidence: [{ source_ref: "transcript:quote-changed", quote: "The old wording." }] },
			{ evidence: [{ source_ref: "transcript:missing", quote: "projected later" }] },
			{ evidence: [{ source_ref: "transcript:other-scope", quote: "private evidence" }] },
		] as const;
		const rejected = collectRejectedDreamingEvidence(
			accessor,
			AGENT,
			{
				ok: false,
				items: operations.map((_operation, index) => ({ index, ok: false })),
			},
			operations,
		);

		expect(rejected).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ sourceId: "incomplete", failureClass: "incomplete_transcript" }),
				expect.objectContaining({ sourceId: "quote-changed", failureClass: "quote_mismatch" }),
				expect.objectContaining({ sourceId: "missing", failureClass: "source_projection" }),
				expect.objectContaining({ sourceId: "other-scope", failureClass: "scope_mismatch" }),
			]),
		);
		expect(rejected).toHaveLength(4);
	});

	it("requeues repaired quarantines once, within budget, without deleting the audit row", () => {
		const timestamp = "2026-08-10T12:00:00.000Z";
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, content, agent_id, created_at, updated_at, completed_at)
			 VALUES ('incomplete', 'now complete', ?, ?, ?, NULL)`,
		).run(AGENT, timestamp, timestamp);
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, content, agent_id, created_at, updated_at, completed_at)
			 VALUES ('scope-repaired', 'returned to the scope', ?, ?, ?, ?)`,
		).run("other-agent", timestamp, timestamp, timestamp);
		seedTranscript(db, "quote-repaired", "new rendered quote", timestamp);

		const exclusions = [
			["incomplete", "incomplete_transcript", null],
			["projected", "source_projection", null],
			["scope-repaired", "scope_mismatch", null],
			["quote-repaired", "quote_mismatch", "old-fingerprint"],
		] as const;
		for (const [sourceId, failureClass, fingerprint] of exclusions) {
			db.prepare(
				`INSERT INTO dreaming_evidence_exclusions
				 (agent_id, source_kind, source_id, reason, pass_id, excluded_at, requeue_requested_at, resolved_at,
				  failure_class, source_fingerprint, retry_count, last_requeued_at)
				 VALUES (?, 'transcript', ?, 'semantic_operation_rejected', 'failed-pass', ?, NULL, NULL, ?, ?, 0, NULL)`,
			).run(AGENT, sourceId, timestamp, failureClass, fingerprint);
		}

		// The incomplete transcript, absent projection, and scope mismatch
		// remain quarantined; only the changed rendered source is retryable.
		expect(
			autoRequeueRepairedDreamingEvidence(
				accessor,
				{ cooldownMs: 0, hourlyBudget: 10, maxAttempts: 3 },
				Date.parse(timestamp),
			),
		).toBe(1);
		// Repair the remaining three sources, including the scope that was
		// temporarily owned by another agent.
		seedTranscript(db, "projected", "projected later", timestamp);
		seedTranscript(db, "scope-repaired", "returned to the scope", timestamp);
		db.prepare("UPDATE session_transcripts SET completed_at = ? WHERE agent_id = ? AND session_key = 'incomplete'").run(
			timestamp,
			AGENT,
		);
		expect(
			autoRequeueRepairedDreamingEvidence(
				accessor,
				{ cooldownMs: 0, hourlyBudget: 10, maxAttempts: 3 },
				Date.parse(timestamp) + 1_000,
			),
		).toBe(3);
		// A requested repair is not re-enqueued on every sweep.
		expect(
			autoRequeueRepairedDreamingEvidence(
				accessor,
				{ cooldownMs: 0, hourlyBudget: 10, maxAttempts: 3 },
				Date.parse(timestamp) + 2_000,
			),
		).toBe(0);

		const rows = db
			.prepare(
				`SELECT source_id AS sourceId, retry_count AS retryCount, requeue_requested_at AS requestedAt,
				        resolved_at AS resolvedAt
				 FROM dreaming_evidence_exclusions WHERE agent_id = ? ORDER BY source_id`,
			)
			.all(AGENT) as Array<{
			sourceId: string;
			retryCount: number;
			requestedAt: string | null;
			resolvedAt: string | null;
		}>;
		expect(rows).toHaveLength(4);
		expect(rows.every((row) => row.retryCount === 1 && row.requestedAt !== null && row.resolvedAt === null)).toBe(true);
		expect(getDreamingAttention(accessor, AGENT).filter((item) => item.kind === "evidence_requeue")).toHaveLength(4);

		accessor.withWriteTx((tx) =>
			resolveRequeuedDreamingEvidenceInTx(tx, AGENT, "repair-pass", { ok: true, items: [{ index: 0, ok: true }] }, [
				{ evidence: [{ source_ref: "transcript:incomplete", quote: "now complete" }] },
			]),
		);
		expect(
			db
				.prepare(
					"SELECT resolved_at AS resolvedAt FROM dreaming_evidence_exclusions WHERE agent_id = ? AND source_id = 'incomplete'",
				)
				.get(AGENT),
		).toMatchObject({ resolvedAt: expect.any(String) });
		expect(getDreamingAttention(accessor, AGENT).filter((item) => item.kind === "evidence_requeue")).toHaveLength(3);
	});

	it("records the repair classification under the operation's target scope when pre-apply validation fails", async () => {
		accessor.withWriteTx((tx) => {
			enqueueDreamingAttentionInTx(tx, {
				agentId: AGENT,
				kind: "review_due",
				subjectRef: "entity:rejected-citation",
				details: { reason: "force the apply path for scope attribution" },
				priority: 90,
			});
		});
		seedSummary(db, "rejected-citation", "The canonical source says the deployment is local.", 12, "other-agent");
		const result = await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const apply = input.tools.find((tool) => tool.name === "apply_ontology_ops");
					if (!apply) throw new Error("Missing apply_ontology_ops");
					await apply.execute(
						"call",
						{
							agentId: "other-agent",
							operations: [
								{
									evidence: [{ source_ref: "summary:rejected-citation", quote: "the deployment is remote" }],
								},
							],
						},
						undefined,
						undefined,
						{} as never,
					);
					return { summary: "Rejected citation" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental",
		);

		expect(result.summary).toBe("Rejected citation");
		expect(await getDreamingEvidenceExclusions(accessor, "other-agent")).toContainEqual(
			expect.objectContaining({
				sourceKind: "summary",
				sourceId: "rejected-citation",
				failureClass: "quote_mismatch",
				retryCount: 0,
			}),
		);
		expect(await getDreamingEvidenceExclusions(accessor, AGENT)).toEqual([]);
	});

	it("applies cited operations only through the daemon-owned tool surface", async () => {
		const evidence = "Aster is the project that owns the edge deployment.";
		seedSummary(db, "agentic-summary", evidence, 12);
		const result = await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const apply = input.tools.find((tool) => tool.name === "apply_ontology_ops");
					if (!apply) throw new Error("Missing apply_ontology_ops");
					await apply.execute(
						"call",
						{
							agentId: AGENT,
							operations: [
								{
									operation: "create_entity",
									payload: { name: "Aster", type: "project" },
									reason: "The evidence names a durable project.",
									evidence: [
										{
											source_ref: "summary:agentic-summary",
											source_kind: "summary",
											source_id: "agentic-summary",
											quote: evidence,
										},
									],
								},
							],
						},
						undefined,
						undefined,
						{} as never,
					);
					return { summary: "Created Aster" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental",
		);
		expect(result).toMatchObject({ applied: 1, failed: 0, summary: "Created Aster" });
		expect(
			db.prepare("SELECT proposal_id FROM entities WHERE agent_id = ? AND name = 'Aster'").get(AGENT),
		).toMatchObject({
			proposal_id: expect.any(String),
		});
		const calls = await getDreamingToolCalls(accessor, AGENT, result.passId);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			passId: result.passId,
			sequence: 1,
			toolName: "apply_ontology_ops",
			success: true,
			input: { operations: expect.any(Array) },
			output: { tool: "apply_ontology_ops", ok: true },
		});
		expect(readDreamingRunbook(accessor, AGENT)[0]).toMatchObject({
			passId: result.passId,
			operations: [{ operation: "create_entity", ok: true, error: null }],
		});
	});

	it("carries scoped runbook history into a later pass", async () => {
		seedSummary(db, "runbook-summary", "The deployment review is deferred pending an owner.", 10);
		const first = await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const write = input.tools.find((tool) => tool.name === "runbook_write");
					if (!write) throw new Error("Missing runbook_write");
					await write.execute(
						"runbook",
						{
							summary: "Deferred deployment review",
							openQuestions: ["Who owns the review?"],
							deferred: ["Link owner after confirmation"],
						},
						undefined,
						undefined,
						{} as never,
					);
					return { summary: "Recorded deferred review" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental",
		);
		const stored = db.prepare("SELECT runbook_json FROM dreaming_passes WHERE id = ?").get(first.passId) as {
			runbook_json: string;
		};
		expect(JSON.parse(stored.runbook_json)).toMatchObject({ openQuestions: ["Who owns the review?"] });

		let prompt = "";
		await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					prompt = input.prompt;
					return { summary: "Reviewed prior runbook" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"compact",
		);
		// The pass prompt is fixed; the agent reads prior notes via runbook_read.
		expect(prompt).toBe(DREAMING_AGENT_PROMPT);
	});

	it("reports a rejected unsupported operation as a failed mutation", async () => {
		const evidence = "Briar owns the release process.";
		seedSummary(db, "rejected-summary", evidence, 8);
		const result = await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const search = input.tools.find((tool) => tool.name === "search_evidence");
					const apply = input.tools.find((tool) => tool.name === "apply_ontology_ops");
					if (!search || !apply) throw new Error("Missing Dreaming delivery tools");
					await search.execute("call", { agentId: AGENT }, undefined, undefined, {} as never);
					await apply.execute(
						"call",
						{
							operations: [
								{
									operation: "not_an_ontology_operation",
									payload: {},
								},
							],
						},
						undefined,
						undefined,
						{} as never,
					);
					return { summary: "Rejected unsupported operation" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental",
		);
		expect(result).toMatchObject({ applied: 0, failed: 1 });
		expect(
			(
				db
					.prepare("SELECT COUNT(*) AS count FROM dreaming_evidence_consumption WHERE source_id = ?")
					.get("rejected-summary") as {
					count: number;
				}
			).count,
		).toBe(0);
	});

	it("records empty and failed bounded-agent passes honestly", async () => {
		const telemetry = captureTelemetry();
		setActiveTelemetry(telemetry.collector);
		const empty = await runDreamingAgentPass(
			accessor,
			{
				async run() {
					throw new Error("agent should not be invoked for an empty pass");
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental",
		);
		expect(empty.summary).toBe("No new episodic evidence or semantic attention to process");
		expect(empty.applied).toBe(0);
		expect(telemetry.events).toContainEqual(
			expect.objectContaining({
				event: "dreaming.pass",
				properties: expect.objectContaining({ outcome: "no-op", outcomeCode: "no_work" }),
			}),
		);

		seedTranscript(db, "attributed", "Evidence for an attributed pass.", new Date(Date.now() + 60_000).toISOString());
		await runDreamingAgentPass(
			accessor,
			{
				async run() {
					return {
						summary: "Attributed pass",
						attribution: { executor: "ollama", provider: "ollama", model: "gemma4", locality: "local" },
					};
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental",
		);
		expect(telemetry.events).toContainEqual(
			expect.objectContaining({
				event: "dreaming.pass",
				properties: expect.objectContaining({
					outcome: "no-op",
					provider: "ollama",
					model: "gemma4",
				}),
			}),
		);

		// Seed evidence with a future watermark so it is unambiguously newer
		// than the previous pass's cutoff (same-second seeds are racy).
		seedTranscript(db, "failure", "Evidence that reaches the agent.", new Date(Date.now() + 60_000).toISOString());
		await expect(
			runDreamingAgentPass(
				accessor,
				{
					async run() {
						throw new Error("agent timeout");
					},
				},
				defaultCfg(),
				"/tmp",
				AGENT,
				[AGENT],
				"incremental",
			),
		).rejects.toThrow("agent timeout");
		expect((await getDreamingPasses(accessor, AGENT)).find((pass) => pass.status === "failed")?.error).toBe(
			"agent timeout",
		);
		expect(telemetry.events).toContainEqual(
			expect.objectContaining({
				event: "dreaming.pass",
				properties: expect.objectContaining({ outcome: "failed", outcomeCode: "timeout" }),
			}),
		);
	});

	it("selects the focused runbook, alternating when both kinds of work are pending (#1098)", () => {
		// Regression for #1098: with the hygiene queue perpetually full, the
		// old worker ran the combined runbook hygiene-first every pass and
		// content ingestion never got budget. With both kinds of work
		// pending, the worker must alternate so content gets a guaranteed
		// turn.
		expect(selectDreamingPassMode(null, true, true)).toBe("incremental-hygiene");
		expect(selectDreamingPassMode("hygiene", true, true)).toBe("incremental-content");
		expect(selectDreamingPassMode("content", true, true)).toBe("incremental-hygiene");
		// Only one kind pending: run that kind directly, no alternation.
		expect(selectDreamingPassMode("content", true, false)).toBe("incremental-hygiene");
		expect(selectDreamingPassMode("hygiene", false, true)).toBe("incremental-content");
		expect(selectDreamingPassMode(null, false, false, true)).toBe("incremental-content");
		expect(selectDreamingPassMode(null, true, false, true)).toBe("incremental-hygiene");
		expect(selectDreamingPassMode("hygiene", true, false, true)).toBe("incremental-content");
	});

	it("early-exits each focused pass mode on its own empty work (#1098)", () => {
		// Hygiene exits on an empty attention queue even while evidence is
		// pending; content exits on an empty backlog even while attention is
		// pending; combined modes need both empty; compact never exits.
		expect(dreamingEarlyExitSummary("incremental-hygiene", false, 100)).toBe("No hygiene attention to process");
		expect(dreamingEarlyExitSummary("incremental-hygiene", true, 0)).toBeNull();
		expect(dreamingEarlyExitSummary("incremental-content", true, 0)).toBe("No new episodic evidence to process");
		expect(dreamingEarlyExitSummary("incremental-content", false, 0, true)).toBeNull();
		expect(dreamingEarlyExitSummary("incremental-content", false, 1)).toBeNull();
		expect(dreamingEarlyExitSummary("incremental", false, 0)).toBe(
			"No new episodic evidence or semantic attention to process",
		);
		expect(dreamingEarlyExitSummary("incremental", false, 0, true)).toBeNull();
		expect(dreamingEarlyExitSummary("incremental", true, 0)).toBeNull();
		expect(dreamingEarlyExitSummary("compact", false, 0)).toBeNull();
	});

	it("uses the mode-specific runbook prompt for focused passes (#1098)", async () => {
		accessor.withWriteTx((tx) => {
			enqueueDreamingAttentionInTx(tx, {
				agentId: AGENT,
				kind: "hygiene",
				subjectRef: "entity:legacy-husk",
			});
		});
		let hygienePrompt = "";
		await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					hygienePrompt = input.prompt;
					return { summary: "Archived flagged husks" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental-hygiene",
		);
		expect(hygienePrompt).toBe(DREAMING_HYGIENE_AGENT_PROMPT);
		expect(hygienePrompt).not.toContain("find new evidence since the cutoff");

		seedSummary(db, "content-prompt", "New evidence for the content runbook.", 8);
		let contentPrompt = "";
		await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					contentPrompt = input.prompt;
					return { summary: "Extracted claims" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental-content",
		);
		expect(contentPrompt).toBe(DREAMING_CONTENT_AGENT_PROMPT);
		expect(contentPrompt).not.toContain("Process ALL pending hygiene records");
		expect(contentPrompt).toContain("kind=surprisal");
		expect(contentPrompt).toContain("never cite attention:<id>");
	});

	it("does not advance the evidence cursor for a surprisal-only content pass", async () => {
		const cursor = JSON.stringify({
			capturedAt: "2026-01-01T00:00:00.000Z",
			kind: "transcript",
			id: "already-surfaced",
		});
		accessor.withWriteTx((tx) => {
			tx.prepare(
				`INSERT INTO dreaming_state (agent_id, last_pass_at, evidence_cursor)
				 VALUES (?, ?, ?)`,
			).run(AGENT, "2026-01-01T00:00:00.000Z", cursor);
			enqueueDreamingAttentionInTx(tx, {
				agentId: AGENT,
				kind: "surprisal",
				subjectRef: "memory:semantic-outlier",
				details: { selector: "embedding-surprisal-v1" },
			});
		});

		await runDreamingAgentPass(
			accessor,
			{
				async run() {
					return { summary: "Inspected surprisal hint" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental-content",
		);

		expect(
			db.prepare("SELECT last_pass_at, evidence_cursor FROM dreaming_state WHERE agent_id = ?").get(AGENT),
		).toEqual({
			last_pass_at: "2026-01-01T00:00:00.000Z",
			evidence_cursor: cursor,
		});
	});

	it("requires bounded Markdown runbook summaries in every pass mode (#1226)", () => {
		for (const prompt of [DREAMING_AGENT_PROMPT, DREAMING_HYGIENE_AGENT_PROMPT, DREAMING_CONTENT_AGENT_PROMPT]) {
			expect(prompt).toContain("specific entity-named change manifest");
			expect(prompt).toContain("## Updated, ## Created, ## Deferred, ## No-op");
			expect(prompt).toContain("exact change");
			expect(prompt).toContain("source or provenance reference");
			expect(prompt).toContain("specific blocker or reason");
			expect(prompt).toContain("never use generic categories");
			expect(prompt).toContain("max 2000 chars");
		}
		expect(DREAMING_AGENT_PROMPT).toContain("kind=surprisal");
		expect(DREAMING_HYGIENE_AGENT_PROMPT).toContain("Leave kind=surprisal records pending");
	});

	it("does not advance the evidence watermark for hygiene-only work (#1098)", async () => {
		// Regression for #1098: a pass that only processed hygiene used to
		// reset the evidence cursor anyway, so the unprocessed episodic
		// backlog no longer counted as new and content ingestion never got
		// budget. A hygiene pass must leave the watermark untouched so the
		// next content pass still sees the backlog.
		seedSummary(db, "starved-evidence", "New transcript evidence that content passes never reached.", 8);
		accessor.withWriteTx((tx) => {
			enqueueDreamingAttentionInTx(tx, {
				agentId: AGENT,
				kind: "hygiene",
				subjectRef: "entity:legacy-husk",
			});
		});
		expect(await getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBeGreaterThan(0);

		await runDreamingAgentPass(
			accessor,
			{
				async run() {
					return { summary: "Archived flagged husks" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental-hygiene",
		);
		// The hygiene pass consumed no evidence: the backlog still counts as
		// new, so the next scheduled content pass gets it.
		expect(await getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBeGreaterThan(0);

		await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					// The content pass surfaces the starved evidence through
					// the scan-first listing, so the watermark legitimately
					// advances to it and the backlog drains.
					const search = input.tools.find((tool) => tool.name === "search_evidence");
					if (!search) throw new Error("Missing search_evidence");
					await search.execute("call", { agentId: AGENT }, undefined, undefined, {} as never);
					return { summary: "Extracted claims" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental-content",
		);
		expect(await getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBe(0);
	});

	it("acknowledges evidence that arrives during a content-attention pass without advancing the watermark (#1430)", async () => {
		accessor.withWriteTx((tx) => {
			enqueueDreamingAttentionInTx(tx, {
				agentId: AGENT,
				kind: "surprisal",
				subjectRef: "memory:mid-pass-arrival",
			});
		});

		await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					seedTranscript(db, "mid-pass-arrival", "Evidence arrived while this content pass was already running.");
					const search = input.tools.find((tool) => tool.name === "search_evidence");
					if (!search) throw new Error("Missing search_evidence");
					await search.execute("call", { agentId: AGENT }, undefined, undefined, {} as never);
					return { summary: "Reviewed late evidence" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental-content",
		);

		// The time watermark remains a pass-start discovery boundary, but the
		// returned late source is durably consumed and leaves no episodic backlog.
		expect((await getDreamingState(accessor, AGENT)).lastPassAt).toBeNull();
		expect(
			(
				db
					.prepare("SELECT COUNT(*) AS count FROM dreaming_evidence_consumption WHERE source_id = ?")
					.get("mid-pass-arrival") as {
					count: number;
				}
			).count,
		).toBe(1);
		expect(await getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBe(0);
	});

	it("does not advance the evidence watermark past evidence a content pass never surfaced (#1149)", async () => {
		// Regression for #1149: a content pass that completes without ever
		// surfacing the pending evidence used to reset the watermark to
		// pass-start anyway, so the un-surfaced window was counted as processed
		// and the next scan-first search never re-listed it. A pass that
		// surfaced nothing must leave the watermark untouched so the evidence
		// stays pending.
		seedSummary(db, "unread-evidence", "Evidence that a 0/0 content pass never surfaced.", 8);
		await runDreamingAgentPass(
			accessor,
			{
				async run() {
					// The agent spent its budget elsewhere: no search_evidence
					// call, so nothing was surfaced this pass.
					return { summary: "Reviewed due claims only" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental-content",
		);
		expect((await getDreamingState(accessor, AGENT)).lastPassAt).toBeNull();
		expect(await getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBeGreaterThan(0);
	});

	it("advances the evidence watermark only to the evidence the pass surfaced (#1149)", async () => {
		// Regression for #1149: the watermark must move to the newest source the
		// pass actually surfaced, never to pass-start. Evidence captured after
		// the surfaced frontier stays pending for the next scan-first search.
		const seed = (id: string, latestAt: string): void => {
			seedTranscript(db, id, `Transcript evidence for ${id}.`, latestAt);
		};
		accessor.withWriteTx((tx) => {
			tx.prepare("INSERT INTO dreaming_state (agent_id, last_pass_at) VALUES (?, ?)").run(
				AGENT,
				"2026-08-05T00:00:00.000Z",
			);
		});
		seed("surfaced-old", "2026-08-06T00:00:00.000Z");
		seed("surfaced-new", "2026-08-06T12:00:00.000Z");
		seed("gap-evidence", "2026-08-07T00:00:00.000Z");

		await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const search = input.tools.find((tool) => tool.name === "search_evidence");
					if (!search) throw new Error("Missing search_evidence");
					// The listing is bounded below the gap evidence: only the two
					// surfaced transcript projections are returned to the pass.
					await search.execute(
						"call",
						{ agentId: AGENT, since: "2026-08-05T00:00:00.000Z", before: "2026-08-06T12:00:00.000Z" },
						undefined,
						undefined,
						{} as never,
					);
					return { summary: "Filed surfaced summaries" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental-content",
		);
		// The watermark advanced to the newest surfaced source, not pass-start.
		expect((await getDreamingState(accessor, AGENT)).lastPassAt).toBe("2026-08-06T12:00:00.000Z");
		// The gap evidence (captured after the surfaced frontier, before pass
		// start) remains pending for the next scan-first search.
		expect(await getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBeGreaterThan(0);
		const manifestNodes = accessor.withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT id, source_type FROM session_summaries WHERE agent_id = ? AND source_type = 'transcript' ORDER BY id",
					)
					.all(AGENT) as Array<{ id: string; source_type: string }>,
		);
		expect(manifestNodes).toEqual([
			{ id: "transcript:default:surfaced-new", source_type: "transcript" },
			{ id: "transcript:default:surfaced-old", source_type: "transcript" },
		]);
	});

	it("does not advance the watermark on a fragment read of an already-listed source (#1149)", async () => {
		// Regression for #1149 (adversarial review F4): paging a sourceRef
		// fragment is a content read of a source the listing already surfaced;
		// it must not advance the frontier past the unread remainder.
		seedTranscript(db, "frag-source", "Fragment evidence for frontier checks.", "2026-08-06T12:00:00.000Z");
		accessor.withWriteTx((tx) => {
			tx.prepare("INSERT INTO dreaming_state (agent_id, last_pass_at) VALUES (?, ?)").run(
				AGENT,
				"2026-08-05T00:00:00.000Z",
			);
		});

		await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const search = input.tools.find((tool) => tool.name === "search_evidence");
					if (!search) throw new Error("Missing search_evidence");
					await search.execute(
						"call",
						{ agentId: AGENT, sourceRef: "transcript:frag-source", offset: 0, chunkSize: 10 },
						undefined,
						undefined,
						{} as never,
					);
					return { summary: "Paged one fragment" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental-content",
		);
		expect((await getDreamingState(accessor, AGENT)).lastPassAt).toBe("2026-08-05T00:00:00.000Z");
	});

	it("does not advance the evidence watermark when a hygiene pass early-exits (#1098, #1149)", async () => {
		// Regression for #1149 (adversarial review F5): a hygiene pass that
		// early-exits on an empty queue used to advance the watermark to
		// pass-start anyway, violating the hygiene-never-advances contract
		// and skipping evidence indexed in the TOCTOU gap.
		await runDreamingAgentPass(
			accessor,
			{
				async run() {
					throw new Error("agent should not be invoked for an empty hygiene pass");
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental-hygiene",
		);
		expect((await getDreamingState(accessor, AGENT)).lastPassAt).toBeNull();
	});
});

describe("Dreaming runbook structure (#1211)", () => {
	// The runbook is served to whatever model the inference route resolves,
	// from local 26B to large hosted models. #1211 pins the structure that
	// keeps both ends working: a load-bearing numbered process, completion
	// criteria that define done, and narrow "You may not" prohibitions
	// instead of category-level safe/unsafe lists (which small models read
	// as blanket caution and generalize into inaction — #1208).
	const runbooks = [
		["combined", DREAMING_AGENT_PROMPT],
		["hygiene", DREAMING_HYGIENE_AGENT_PROMPT],
		["content", DREAMING_CONTENT_AGENT_PROMPT],
	] as const;

	for (const [name, prompt] of runbooks) {
		it(`${name} runbook defines completion criteria and narrow must-nots (#1211)`, () => {
			// Completion criteria: what "done" looks like (flags resolved or
			// blocker-named, claims complete, pass log written).
			expect(prompt).toContain("### Done");
			expect(prompt).toContain("The pass is done when");
			// Narrow must-nots: every prohibition is finite and specific
			// ("You may not ..."), never a category-level list.
			const mustNot = prompt.split("### Must not")[1]?.split("### Done")[0] ?? "";
			const prohibitions = mustNot.split("\n").filter((line) => line.trim().startsWith("- "));
			expect(prohibitions.length).toBeGreaterThan(3);
			for (const prohibition of prohibitions) {
				expect(prohibition.trim()).toMatch(/^- You may not /);
			}
			// No category-level "unsafe" list remains.
			expect(prompt).not.toContain("### Unsafe");
			expect(prompt).not.toContain("### Safe");
			// Deferral is not an escape hatch: it needs a named blocker,
			// never the same blocker twice in a row.
			expect(prompt).toContain("named blocker");
			expect(prompt).toContain("not the same blocker twice in a row");
			// Deferral is not a close: deferred records stay pending and are
			// re-examined next pass.
			expect(prompt).toContain("Deferred records stay pending");
		});
	}

	it("rejects fragment claims wherever claims are filed (#1210)", () => {
		// The content and combined runbooks reach claim filing; both must
		// carry the complete-statement standard with the concrete
		// anti-examples the local model filed as durable knowledge.
		for (const prompt of [DREAMING_AGENT_PROMPT, DREAMING_CONTENT_AGENT_PROMPT]) {
			expect(prompt).toContain("complete statement");
			expect(prompt).toContain("SHIP-WITH-FIXES");
			expect(prompt).toContain("Root cause confirmed.");
		}
	});

	it("keeps the focused-mode boundaries and names the mid-stream blocker (#1098, #1140)", () => {
		// Focused modes own disjoint work: hygiene never ingests evidence,
		// content never processes the hygiene queue.
		expect(DREAMING_HYGIENE_AGENT_PROMPT).not.toContain("find new evidence since the cutoff");
		expect(DREAMING_CONTENT_AGENT_PROMPT).not.toContain("Process ALL pending hygiene records");
		expect(DREAMING_AGENT_PROMPT).toContain("find new evidence since the cutoff");
		expect(DREAMING_AGENT_PROMPT).toContain("Process ALL pending hygiene records");
		// The mid-stream deferral carries a named blocker that survives
		// re-checking — a still-active session is a re-verified blocker,
		// not a repeated one, so #1140 does not collide with the
		// same-blocker-twice rule.
		for (const prompt of [DREAMING_AGENT_PROMPT, DREAMING_CONTENT_AGENT_PROMPT]) {
			expect(prompt).toContain("transcript still mid-stream");
			expect(prompt).toContain("re-verified blocker");
		}
	});
});
