import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { type WriteDb, closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { getDreamingToolCalls, runDreamingAgentPass } from "../pipeline/dreaming";
import { createDreamingCapabilities } from "../pipeline/dreaming-capabilities";
import { registerPipelineRoutes } from "./pipeline-routes";

describe("POST /api/dream/tools/:capability", () => {
	let agentsDir = "";

	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "signet-dreaming-tools-route-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		initDbAccessor(join(agentsDir, "memory", "memories.db"), { agentsDir });
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(agentsDir, { recursive: true, force: true });
	});

	it("returns a retryable 503 with the committed prefix after a writer failure (#1414)", async () => {
		const accessor = getDbAccessor();
		accessor.withWriteTx((db) => {
			for (let index = 0; index < 25; index += 1) {
				db.prepare(
					`INSERT INTO memories
					 (id, content, source_type, memory_kind, visibility, agent_id, created_at, updated_at)
					 VALUES (?, ?, 'manual', 'episodic', 'normal', 'agent-a', datetime('now'), datetime('now'))`,
				).run(`m-route-1414-${index}`, `Route retry evidence ${index}.`);
			}
		});
		const enqueue = accessor.withWriteTxAsync;
		if (!enqueue) throw new Error("async write API is unavailable");
		let transactions = 0;
		const injectable = accessor as {
			withWriteTxAsync: <T>(fn: (db: WriteDb) => T) => Promise<T>;
		};
		injectable.withWriteTxAsync = (fn) => {
			transactions += 1;
			if (transactions === 3) return Promise.reject(new Error("injected route writer rejection"));
			return enqueue(fn);
		};
		const app = new Hono();
		registerPipelineRoutes(app);

		try {
			const response = await app.request("/api/dream/tools/apply_ontology_ops", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					agentId: "agent-a",
					input: {
						operations: Array.from({ length: 25 }, (_, index) => ({
							operation: "create_entity",
							payload: { name: `Route retry entity ${index}`, type: "project" },
							evidence: [
								{
									source_ref: `memory:m-route-1414-${index}`,
									source_kind: "manual",
									source_id: `m-route-1414-${index}`,
									quote: `Route retry evidence ${index}.`,
								},
							],
						})),
					},
				}),
			});

			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				tool: "apply_ontology_ops",
				ok: false,
				retryable: true,
				retryFrom: 20,
				error: "injected route writer rejection",
				agentId: "agent-a",
				items: Array.from({ length: 20 }, (_, index) => ({ index, ok: true })),
			});
		} finally {
			injectable.withWriteTxAsync = enqueue;
		}
	});

	it("records ACPX transport tool calls for the active Dreaming pass", async () => {
		const accessor = getDbAccessor();
		accessor.withWriteTx((db) => {
			db.prepare(
				`INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at)
				 VALUES ('pass-acpx-trace', 'agent-a', 'incremental', 'running', datetime('now'), datetime('now'))`,
			).run();
		});
		const app = new Hono();
		registerPipelineRoutes(app);

		for (const capability of ["runbook_read", "attention_list"]) {
			const response = await app.request(`/api/dream/tools/${capability}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					agentId: "agent-a",
					passId: "pass-acpx-trace",
					actor: "dreaming-acpx",
					input: capability === "attention_list" ? { kind: "hygiene" } : {},
				}),
			});
			expect(response.status).toBe(200);
		}
		const rejected = await app.request("/api/dream/tools/search_evidence", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-a",
				passId: "pass-acpx-trace",
				actor: "dreaming-acpx",
				input: { agentId: "main" },
			}),
		});
		expect(rejected.status).toBe(403);
		const rejectedPass = await app.request("/api/dream/tools/runbook_read", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-a",
				passId: "pass-acpx-trace",
				actor: "dreaming-acpx",
				input: { passId: "foreign-pass" },
			}),
		});
		expect(rejectedPass.status).toBe(403);

		const trace = await app.request("/api/dream/passes/pass-acpx-trace/tools?agentId=agent-a");
		expect(trace.status).toBe(200);
		expect(await trace.json()).toMatchObject({
			agentId: "agent-a",
			passId: "pass-acpx-trace",
			items: [
				{ sequence: 1, toolName: "runbook_read", success: true },
				{ sequence: 2, toolName: "attention_list", success: true },
				{ sequence: 3, toolName: "search_evidence", success: false },
				{ sequence: 4, toolName: "runbook_read", success: false },
			],
		});
	});

	it("feeds ACPX tool results through the active pass accounting callbacks", async () => {
		const accessor = getDbAccessor();
		const evidence = "Atlas is the durable ACPX accounting project.";
		accessor.withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, agent_id, content, harness, created_at, updated_at, completed_at)
				 VALUES ('acpx-accounting', 'agent-a', ?, 'codex', datetime('now'), datetime('now'), datetime('now'))`,
			).run(evidence);
		});
		const app = new Hono();
		registerPipelineRoutes(app);

		const result = await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const search = await app.request("/api/dream/tools/search_evidence", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							agentId: "agent-a",
							passId: input.passId,
							toolCallId: "mcp-search-1",
							input: { kind: "transcript" },
						}),
					});
					expect(search.status).toBe(200);
					const apply = await app.request("/api/dream/tools/apply_ontology_ops", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							agentId: "agent-a",
							passId: input.passId,
							toolCallId: "mcp-apply-1",
							input: {
								operations: [
									{
										operation: "create_entity",
										payload: { name: "Atlas", type: "project" },
										reason: "The transcript establishes the project.",
										evidence: [
											{
												source_ref: "transcript:acpx-accounting",
												source_kind: "transcript",
												source_id: "acpx-accounting",
												quote: evidence,
											},
										],
									},
								],
							},
						}),
					});
					expect(apply.status).toBe(200);
					return { summary: "Applied through ACPX" };
				},
			},
			{
				enabled: true,
				tokenThreshold: 1,
				maxInterval: 1,
				maxInputTokens: 32_000,
				maxOutputTokens: 16_000,
				timeout: 30_000,
				backfillOnFirstRun: true,
			},
			agentsDir,
			"agent-a",
			["agent-a"],
			"incremental",
		);

		expect(result).toMatchObject({ applied: 1, failed: 0 });
		expect(
			accessor.withReadDb((db) =>
				db
					.prepare("SELECT mutations_applied AS applied, mutations_failed AS failed FROM dreaming_passes WHERE id = ?")
					.get(result.passId),
			),
		).toEqual({ applied: 1, failed: 0 });
		const calls = await getDreamingToolCalls(accessor, "agent-a", result.passId);
		expect(calls.map((call) => call.toolCallId)).toEqual(["mcp-search-1", "mcp-apply-1"]);
		expect(calls[0]?.input).toMatchObject({ agentId: "agent-a", passId: result.passId, kind: "transcript" });
		expect(
			accessor.withReadDb((db) =>
				db
					.prepare("SELECT COUNT(*) AS count FROM session_summaries WHERE source_type = 'transcript' AND agent_id = ?")
					.get("agent-a"),
			),
		).toEqual({ count: 1 });
	});

	it("resolves content-only capabilities from the active pass mode", async () => {
		const accessor = getDbAccessor();
		accessor.withWriteTx((db) => {
			db.prepare(
				`INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at)
				 VALUES ('pass-content-mode', 'agent-a', 'incremental-content', 'running', datetime('now'), datetime('now'))`,
			).run();
		});
		const app = new Hono();
		registerPipelineRoutes(app);
		const response = await app.request("/api/dream/tools/curate_memory_head", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agentId: "agent-a", passId: "pass-content-mode", input: {} }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ tool: "curate_memory_head", ok: false });
	});

	it("counts a rejected ACPX apply and does not acknowledge its surfaced evidence", async () => {
		const accessor = getDbAccessor();
		accessor.withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, agent_id, content, harness, created_at, updated_at, completed_at)
				 VALUES ('acpx-rejected', 'agent-a', 'Rejected ACPX evidence.', 'codex', datetime('now'), datetime('now'), datetime('now'))`,
			).run();
		});
		const app = new Hono();
		registerPipelineRoutes(app);
		const result = await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const search = await app.request("/api/dream/tools/search_evidence", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ agentId: "agent-a", passId: input.passId, input: { kind: "transcript" } }),
					});
					expect(search.status).toBe(200);
					const apply = await app.request("/api/dream/tools/apply_ontology_ops", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							agentId: "agent-a",
							passId: input.passId,
							input: { operations: [{ operation: "unsupported", evidence: [] }] },
						}),
					});
					expect(apply.status).toBe(400);
					return { summary: "Rejected through ACPX" };
				},
			},
			{
				enabled: true,
				tokenThreshold: 1,
				maxInterval: 1,
				maxInputTokens: 32_000,
				maxOutputTokens: 16_000,
				timeout: 30_000,
				backfillOnFirstRun: true,
			},
			agentsDir,
			"agent-a",
			["agent-a"],
			"incremental",
		);

		expect(result).toMatchObject({ applied: 0, failed: 1 });
		expect(
			accessor.withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM dreaming_evidence_consumption").get()),
		).toEqual({ count: 0 });
	});

	it("does not turn a committed capability result into a retry when trace persistence fails", async () => {
		const accessor = getDbAccessor();
		accessor.withWriteTx((db) => {
			db.prepare(
				`INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at)
				 VALUES ('pass-trace-failure', 'agent-a', 'incremental', 'running', datetime('now'), datetime('now'))`,
			).run();
		});
		const enqueue = accessor.withWriteTxAsync;
		if (!enqueue) throw new Error("async write API is unavailable");
		const injectable = accessor as {
			withWriteTxAsync: <T>(fn: (db: WriteDb) => T) => Promise<T>;
		};
		injectable.withWriteTxAsync = () => Promise.reject(new Error("injected trace persistence failure"));
		const app = new Hono();
		registerPipelineRoutes(app);

		try {
			const response = await app.request("/api/dream/tools/runbook_write", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					agentId: "agent-a",
					passId: "pass-trace-failure",
					actor: "dreaming-acpx",
					input: { summary: "Committed before trace persistence failed." },
				}),
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ tool: "runbook_write", ok: true });
			expect(
				accessor.withReadDb(
					(db) =>
						db.prepare("SELECT runbook_json AS runbook FROM dreaming_passes WHERE id = 'pass-trace-failure'").get() as {
							runbook: string | null;
						},
				),
			).toMatchObject({ runbook: expect.stringContaining("Committed before trace persistence failed.") });
		} finally {
			injectable.withWriteTxAsync = enqueue;
		}
	});

	it("serializes concurrent MCP traces with their request ids", async () => {
		const accessor = getDbAccessor();
		accessor.withWriteTx((db) => {
			db.prepare(
				`INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at)
				 VALUES ('pass-concurrent-trace', 'agent-a', 'incremental', 'running', datetime('now'), datetime('now'))`,
			).run();
		});
		const app = new Hono();
		registerPipelineRoutes(app);
		const responses = await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				app.request("/api/dream/tools/runbook_read", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						agentId: "agent-a",
						passId: "pass-concurrent-trace",
						toolCallId: `mcp-concurrent-${index}`,
						input: {},
					}),
				}),
			),
		);
		expect(responses.every((response) => response.status === 200)).toBe(true);
		const calls = await getDreamingToolCalls(accessor, "agent-a", "pass-concurrent-trace");
		expect(calls.map((call) => call.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(calls.map((call) => call.toolCallId).sort()).toEqual(
			Array.from({ length: 8 }, (_, index) => `mcp-concurrent-${index}`),
		);
	});

	it("does not expose a committed operation as failed when pass accounting throws", async () => {
		const accessor = getDbAccessor();
		accessor.withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories
				 (id, content, source_type, memory_kind, visibility, agent_id, created_at, updated_at)
				 VALUES ('m-accounting-error', 'Accounting callback evidence.', 'manual', 'episodic', 'normal', 'agent-a', datetime('now'), datetime('now'))`,
			).run();
		});
		let accountingError = "";
		const capability = createDreamingCapabilities({
			accessor,
			agentId: "agent-a",
			actor: "dreaming-test",
			onOperationsApplied() {
				throw new Error("injected post-commit accounting failure");
			},
			onOperationsAccountingError(error) {
				accountingError = error instanceof Error ? error.message : String(error);
			},
		}).find((candidate) => candidate.id === "apply_ontology_ops");
		if (!capability) throw new Error("apply_ontology_ops capability is unavailable");
		const result = await capability.invoke({
			agentId: "agent-a",
			operations: [
				{
					operation: "create_entity",
					payload: { name: "Accounting Safe", type: "project" },
					evidence: [
						{
							source_ref: "memory:m-accounting-error",
							source_kind: "manual",
							source_id: "m-accounting-error",
							quote: "Accounting callback evidence.",
						},
					],
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(accountingError).toBe("injected post-commit accounting failure");
		expect(
			accessor.withReadDb((db) =>
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND canonical_name = ?")
					.get("agent-a", "accounting safe"),
			),
		).toEqual({ count: 1 });
	});
});
