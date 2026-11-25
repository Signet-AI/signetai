import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { type WriteDb, closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { createDreamingAgentTools } from "../pipeline/dreaming-agent-tools";
import { bindDreamingPassTools } from "../pipeline/dreaming-pass-tools";
import type { PiAgentTool } from "../pipeline/pi-agent-protocol";
import { registerPipelineRoutes } from "./pipeline-routes";

describe("POST /api/dream/tools/apply_ontology_ops", () => {
	let agentsDir = "";

	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "signet-dreaming-tools-route-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		initDbAccessor(join(agentsDir, "memory", "memories.db"), { agentsDir });
	});

	afterEach(async () => {
		await closeDbAccessor();
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
		const injectable = accessor as {
			withWriteTxAsync: <T>(fn: (db: WriteDb) => T) => Promise<T>;
		};
		injectable.withWriteTxAsync = (fn) => {
			const progress = accessor.withReadDb((db) =>
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM entities WHERE agent_id='agent-a' AND name LIKE 'Route retry entity %'",
					)
					.get(),
			);
			if (typeof progress === "object" && progress !== null && "count" in progress && progress.count === 20)
				return Promise.reject(new Error("injected route writer rejection"));
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
});

describe("POST /api/dream/tools/:capability for a request that names a pass", () => {
	let agentsDir = "";
	let release: (() => Promise<void>) | undefined;

	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "signet-dreaming-pass-tools-route-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		initDbAccessor(join(agentsDir, "memory", "memories.db"), { agentsDir });
	});

	afterEach(async () => {
		await release?.();
		release = undefined;
		await closeDbAccessor();
		rmSync(agentsDir, { recursive: true, force: true });
	});

	function recorder(seen: unknown[]): PiAgentTool {
		return {
			name: "search_evidence",
			label: "Search evidence",
			description: "test",
			parameters: {},
			async execute(_id, input) {
				seen.push(input);
				return {
					content: [{ type: "text", text: JSON.stringify({ tool: "search_evidence", ok: true, items: [] }) }],
					details: { tool: "search_evidence" },
				};
			},
		};
	}

	function call(capability: string, body: Record<string, unknown>): Promise<Response> {
		const app = new Hono();
		registerPipelineRoutes(app);
		return Promise.resolve(
			app.request(`/api/dream/tools/${capability}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
	}

	it("serves the call from the pass's own tools with the credential's agent pinned", async () => {
		const seen: unknown[] = [];
		release = bindDreamingPassTools({ passId: "pass-live", agentId: "agent-a", tools: [recorder(seen)] });

		const response = await call("search_evidence", { agentId: "agent-a", passId: "pass-live", input: { limit: 1 } });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ tool: "search_evidence", ok: true, items: [], agentId: "agent-a" });
		expect(seen).toEqual([{ limit: 1, agentId: "agent-a" }]);
	});

	it("refuses a pass that is not accepting tool calls instead of running the call outside it", async () => {
		const response = await call("search_evidence", { agentId: "agent-a", passId: "pass-gone", input: {} });

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "Dreaming pass is not accepting tool calls" });
	});

	it("rejects a pass ID that is not a non-empty string instead of running the call outside a pass", async () => {
		const seen: unknown[] = [];
		release = bindDreamingPassTools({ passId: "42", agentId: "agent-a", tools: [recorder(seen)] });

		const statuses: number[] = [];
		for (const passId of [42, "", "  ", null, ["42"]]) {
			statuses.push((await call("search_evidence", { agentId: "agent-a", passId, input: {} })).status);
		}

		expect(statuses).toEqual([400, 400, 400, 400, 400]);
		expect(seen).toEqual([]);
	});

	it("refuses another agent's credential and a second scope inside the input", async () => {
		const seen: unknown[] = [];
		release = bindDreamingPassTools({ passId: "pass-live", agentId: "agent-a", tools: [recorder(seen)] });

		const foreign = await call("search_evidence", { agentId: "agent-b", passId: "pass-live", input: {} });
		const second = await call("search_evidence", {
			agentId: "agent-a",
			passId: "pass-live",
			input: { agentId: "agent-b" },
		});

		expect([foreign.status, second.status]).toEqual([403, 403]);
		expect(seen).toEqual([]);
	});

	it("refuses a nested scope the pass does not allow", async () => {
		release = bindDreamingPassTools({
			passId: "pass-live",
			agentId: "agent-a",
			tools: createDreamingAgentTools({
				accessor: getDbAccessor(),
				agentId: "agent-a",
				allowedAgentIds: ["agent-a"],
				actor: "dreaming",
				passId: "pass-live",
				mode: "incremental",
			}),
		});

		const response = await call("runbook_write", {
			agentId: "agent-a",
			passId: "pass-live",
			input: { summary: "note", deferredEvidence: [{ agentId: "agent-b", sourceRef: "memory:m-1" }] },
		});

		expect(response.status).toBe(403);
	});

	it("returns 404 for a capability the pass does not expose", async () => {
		release = bindDreamingPassTools({ passId: "pass-live", agentId: "agent-a", tools: [recorder([])] });

		const response = await call("memory_head_commit", { agentId: "agent-a", passId: "pass-live", input: {} });

		expect(response.status).toBe(404);
	});

	it("keeps one binding per pass and waits for in-flight calls on release", async () => {
		let finish: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let enter: () => void = () => undefined;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const slow: PiAgentTool = {
			...recorder([]),
			async execute() {
				enter();
				await gate;
				return {
					content: [{ type: "text", text: JSON.stringify({ tool: "search_evidence", ok: true }) }],
					details: { tool: "search_evidence" },
				};
			},
		};
		const first = bindDreamingPassTools({ passId: "pass-live", agentId: "agent-a", tools: [slow] });
		expect(() => bindDreamingPassTools({ passId: "pass-live", agentId: "agent-a", tools: [slow] })).toThrow(
			"already has bound tools",
		);

		const pending = call("search_evidence", { agentId: "agent-a", passId: "pass-live", input: {} });
		await entered;
		let released = false;
		const releasing = first().then(() => {
			released = true;
		});
		expect((await call("search_evidence", { agentId: "agent-a", passId: "pass-live", input: {} })).status).toBe(409);
		expect(released).toBe(false);

		finish();
		await releasing;
		expect((await pending).status).toBe(200);
	});
});
