import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../../../core/src/migrations";
import type { ReadDb } from "../../db-accessor";
import {
	DEFAULT_CONTEXT_BUDGET_PCT,
	FALLBACK_CONTEXT_WINDOW_TOKENS,
	buildIngestContext,
	computeIngestBudget,
	resolveIngestSource,
} from "./context";
import type { IngestJobRow } from "./lease";

function asReadDb(db: Database): ReadDb {
	return db as unknown as ReadDb;
}

function job(over: Partial<IngestJobRow>): IngestJobRow {
	return {
		id: over.id ?? "job1",
		memory_id: over.memory_id ?? null,
		document_id: over.document_id ?? null,
		job_type: "ingest",
		status: over.status ?? "leased",
		payload: over.payload ?? null,
		attempts: 1,
		max_attempts: 5,
		priority: 0,
		agent_id: over.agent_id ?? "default",
	};
}

describe("ingest context builder", () => {
	let db: Database;
	let rdb: ReadDb;
	let agentsDir: string;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		rdb = asReadDb(db);
		agentsDir = mkdtempSync(join(tmpdir(), "ingest-ctx-"));
	});
	afterEach(() => db.close());

	test("computeIngestBudget uses the configured window and 128k fallback", () => {
		expect(computeIngestBudget(200_000, undefined).inputBudget).toBe(Math.floor(200_000 * DEFAULT_CONTEXT_BUDGET_PCT));
		expect(computeIngestBudget(undefined, undefined).window).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
		expect(computeIngestBudget(undefined, undefined).inputBudget).toBe(
			Math.floor(FALLBACK_CONTEXT_WINDOW_TOKENS * DEFAULT_CONTEXT_BUDGET_PCT),
		);
	});

	test("resolves a memory source from the job's memory_id", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, agent_id, project, created_at, updated_at)
			 VALUES (?, ?, 'default', 'ingest-test', ?, ?)`,
		).run("mem1", "Nicholai prefers GLM 5.1 via Z.AI.", now, now);

		const src = resolveIngestSource(rdb, "default", job({ memory_id: "mem1" }));
		expect(src?.kind).toBe("memory");
		expect(src?.content).toContain("GLM 5.1");
		expect(src?.project).toBe("ingest-test");
	});

	test("falls back to payload text when no memory/document is referenced", () => {
		const src = resolveIngestSource(rdb, "default", job({ payload: JSON.stringify({ text: "raw payload source" }) }));
		expect(src?.kind).toBe("payload");
		expect(src?.content).toBe("raw payload source");
	});

	test("buildIngestContext packs the source + runbook + budget; small source is not oversize", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, agent_id, created_at, updated_at)
			 VALUES (?, ?, 'default', ?, ?)`,
		).run("mem1", "A durable preference about routing.", now, now);

		const ctx = buildIngestContext(rdb, {
			job: job({ id: "job1", memory_id: "mem1" }),
			agentId: "default",
			agentsDir,
			contextWindow: 200_000,
		});

		expect(ctx.source.kind).toBe("memory");
		expect(ctx.source.content).toContain("durable preference");
		expect(ctx.budget.inputBudget).toBe(Math.floor(200_000 * DEFAULT_CONTEXT_BUDGET_PCT));
		expect(ctx.tokens.total).toBeLessThanOrEqual(ctx.budget.inputBudget + 1); // packing respects budget
		expect(ctx.oversize).toBe(false);
		// DREAMING.md absent in the empty tmp agentsDir → empty runbook.
		expect(ctx.dreamingMd).toBe("");
	});

	test("flags oversize when the source alone exceeds the input budget", () => {
		// Build a source much larger than a tiny window's input budget.
		const huge = "This is a durable fact. ".repeat(4000); // ~40k chars ≈ ~10k tokens
		const ctx = buildIngestContext(rdb, {
			job: job({ id: "job1", payload: JSON.stringify({ text: huge }) }),
			agentId: "default",
			agentsDir,
			contextWindow: 500, // inputBudget = 400 tokens; source >> that
		});
		expect(ctx.oversize).toBe(true);
		// Oversize keeps the full source (caller splits or fails; no silent mid-truncation).
		expect(ctx.source.content.length).toBe(huge.length);
	});
});
