import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DreamingConfig } from "@signet/core";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor } from "../db-accessor";
import {
	DREAMING_AGENT_PROMPT,
	_testParseEpisodicCursor,
	enqueueDreamingHygieneAttention,
	getDreamingEpisodicTokenBacklog,
	getDreamingPasses,
	getDreamingState,
	getDreamingToolCalls,
	recordDreamingFailure,
	requestDreamingEvidenceRequeue,
	runDreamingAgentPass,
	shouldTriggerDreaming,
} from "./dreaming";
import {
	enqueueDreamingAttentionInTx,
	getDreamingAttention,
	getDreamingAttentionSnapshots,
	resolveDreamingAttentionInTx,
} from "./dreaming-attention";
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

function seedSummary(db: Database, id: string, content: string, tokens: number): void {
	db.prepare(
		`INSERT INTO session_summaries
		 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
		 VALUES (?, ?, ?, ?, 0, 'session', 'summary', datetime('now'), datetime('now'), datetime('now'))`,
	).run(id, AGENT, content, tokens);
}

describe("Dreaming", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = wrapDb(db);
	});

	afterEach(() => db.close());

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

	it("uses the fixed agent prompt and resets the evidence backlog each pass", async () => {
		seedSummary(db, "s1", "durable episodic evidence for the backlog.", 500);
		expect(getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBeGreaterThan(0);
		let prompt = "";
		const result = await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					prompt = input.prompt;
					return { summary: "Done" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			"incremental",
		);
		expect(result.summary).toBe("Done");
		expect(prompt).toBe(DREAMING_AGENT_PROMPT);
		// The evidence queue resets to pass start: the same evidence must not
		// re-trigger the next pass.
		expect(getDreamingEpisodicTokenBacklog(accessor, AGENT)).toBe(0);
	});

	it("uses wall-clock backoff independently of later evidence volume", () => {
		seedSummary(db, "first", "episodic source", 10);
		recordDreamingFailure(accessor, AGENT);
		const failedAt = Date.parse(getDreamingState(accessor, AGENT).lastFailureAt ?? "");
		const cfg = defaultCfg({ tokenThreshold: 1, backfillOnFirstRun: false });
		expect(shouldTriggerDreaming(accessor, cfg, AGENT, failedAt + 10 * 60 * 1000 - 1)).toBe(false);
		seedSummary(db, "later", "episodic source ".repeat(3_000), 3_000);
		expect(shouldTriggerDreaming(accessor, cfg, AGENT, failedAt + 10 * 60 * 1000)).toBe(true);
	});

	it("runs a low-volume episodic backlog once its maximum wait elapses", () => {
		const now = Date.now();
		seedSummary(db, "trickle", "small episodic source", 10);
		accessor.withWriteTx((tx) => {
			tx.prepare(
				`INSERT INTO dreaming_state (agent_id, last_pass_at)
				 VALUES (?, ?)`,
			).run(AGENT, new Date(now - 6 * 60 * 60 * 1_000).toISOString());
		});
		const cfg = defaultCfg({ tokenThreshold: 100_000, maxInterval: 6 * 60 * 60 * 1_000, backfillOnFirstRun: false });
		expect(shouldTriggerDreaming(accessor, cfg, AGENT, now - 1)).toBe(false);
		expect(shouldTriggerDreaming(accessor, cfg, AGENT, now)).toBe(true);
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
		expect(shouldTriggerDreaming(accessor, defaultCfg(), AGENT)).toBe(true);

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
			"incremental",
		);

		expect(result.summary).toBe("Reviewed due claim");
		expect(prompt).toBe(DREAMING_AGENT_PROMPT);
		// Attention is not auto-resolved: the agent consumes it via a flag +
		// archive batch, which is covered by the operations suite.
		expect(getDreamingAttention(accessor, AGENT)).toHaveLength(1);
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
			"incremental",
		);
		expect(prompt).toBe(DREAMING_AGENT_PROMPT);
		expect(toolNames).toEqual(
			expect.arrayContaining(["search_entities", "get_entity", "list_aspect_claims", "walk_links", "attention_list"]),
		);
	});

	it("turns deterministic graph hygiene into scoped attention without episodic evidence", () => {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES ('legacy-husk', 'Legacy Husk', 'legacy husk', 'project', ?, 5, datetime('now'), datetime('now'))`,
		).run(AGENT);
		expect(enqueueDreamingHygieneAttention(accessor, AGENT)).toBeGreaterThan(0);
		expect(getDreamingAttention(accessor, AGENT)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "hygiene",
					subjectRef: "entity:legacy-husk",
					details: expect.objectContaining({ reason: "zero_active_attributes" }),
				}),
			]),
		);
		expect(shouldTriggerDreaming(accessor, defaultCfg(), AGENT)).toBe(true);
		const snapshots = getDreamingAttentionSnapshots(accessor, AGENT);
		accessor.withWriteTx((tx) => resolveDreamingAttentionInTx(tx, AGENT, "pass-hygiene", snapshots));
		enqueueDreamingHygieneAttention(accessor, AGENT);
		expect(getDreamingAttention(accessor, AGENT)).toEqual([]);
		db.prepare("UPDATE entities SET name = 'Renamed legacy husk' WHERE id = 'legacy-husk'").run();
		enqueueDreamingHygieneAttention(accessor, AGENT);
		expect(getDreamingAttention(accessor, AGENT)).toContainEqual(
			expect.objectContaining({
				subjectRef: "entity:legacy-husk",
				details: expect.objectContaining({ name: "Renamed legacy husk" }),
			}),
		);
	});

	it("reopens duplicate hygiene attention when group membership changes", () => {
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
		enqueueDreamingHygieneAttention(accessor, AGENT);
		const snapshots = getDreamingAttentionSnapshots(accessor, AGENT);
		accessor.withWriteTx((tx) => resolveDreamingAttentionInTx(tx, AGENT, "pass-duplicates", snapshots));
		db.prepare("DELETE FROM entities WHERE id = 'acme-b'").run();
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES ('acme-c', 'Acme Inc.', 'acme', 'project', ?, 1, datetime('now'), datetime('now'))`,
		).run(AGENT);
		enqueueDreamingHygieneAttention(accessor, AGENT);
		expect(getDreamingAttention(accessor, AGENT)).toContainEqual(
			expect.objectContaining({ subjectRef: "duplicate:acme", details: expect.objectContaining({ count: "2" }) }),
		);
	});

	it("keeps semantic attention pending when its pass fails", async () => {
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
				"incremental",
			),
		).rejects.toThrow("provider unavailable");
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
			"incremental",
		);

		expect(getDreamingAttention(accessor, AGENT)).toContainEqual(
			expect.objectContaining({ kind: "hygiene", subjectRef: "entity:aster" }),
		);
	});

	it("turns an explicit evidence requeue into scoped semantic attention", () => {
		db.prepare(
			`INSERT INTO dreaming_evidence_exclusions
			 (agent_id, source_kind, source_id, reason, pass_id, excluded_at, requeue_requested_at, resolved_at)
			 VALUES (?, 'summary', 'retry-summary', 'semantic_operation_rejected', 'failed-pass', datetime('now'), NULL, NULL)`,
		).run(AGENT);

		expect(requestDreamingEvidenceRequeue(accessor, AGENT, "summary", "retry-summary")).toBe(true);
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
			"incremental",
		);
		expect(result).toMatchObject({ applied: 1, failed: 0, summary: "Created Aster" });
		expect(
			db.prepare("SELECT proposal_id FROM entities WHERE agent_id = ? AND name = 'Aster'").get(AGENT),
		).toMatchObject({
			proposal_id: expect.any(String),
		});
		const calls = getDreamingToolCalls(accessor, AGENT, result.passId);
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
					const apply = input.tools.find((tool) => tool.name === "apply_ontology_ops");
					if (!apply) throw new Error("Missing apply_ontology_ops");
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
			"incremental",
		);
		expect(result).toMatchObject({ applied: 0, failed: 1 });
	});

	it("records empty and failed bounded-agent passes honestly", async () => {
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
			"incremental",
		);
		expect(empty.summary).toBe("No new episodic evidence or semantic attention to process");
		expect(empty.applied).toBe(0);

		// Seed evidence with a future watermark so it is unambiguously newer
		// than the previous pass's cutoff (same-second seeds are racy).
		db.prepare(
			`INSERT INTO session_summaries
			 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
			 VALUES ('failure', ?, 'Evidence that reaches the agent.', 5, 0, 'session', 'summary',
			         datetime('now', '+1 minute'), datetime('now', '+1 minute'), datetime('now'))`,
		).run(AGENT);
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
				"incremental",
			),
		).rejects.toThrow("agent timeout");
		expect(getDreamingPasses(accessor, AGENT).find((pass) => pass.status === "failed")?.error).toBe("agent timeout");
	});
});
