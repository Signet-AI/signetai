import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { type WriteDb, closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { registerPipelineRoutes } from "./pipeline-routes";

describe("POST /api/dream/tools/apply_ontology_ops", () => {
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
});
