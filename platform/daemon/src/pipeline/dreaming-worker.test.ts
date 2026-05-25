import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DreamingConfig, LlmProvider } from "@signet/core";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor } from "../db-accessor";
import { closeInferenceProviderResolver, initInferenceProviderResolver } from "../llm";
import { getDreamingWorkerAgentIds, startDreamingWorker } from "./dreaming-worker";

function defaultCfg(overrides?: Partial<DreamingConfig>): DreamingConfig {
	return {
		enabled: true,
		tokenThreshold: 100_000,
		maxInputTokens: 32_000,
		maxOutputTokens: 16_000,
		timeout: 300_000,
		backfillOnFirstRun: false,
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
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			}
		},
	} as unknown as DbAccessor;
}

function makeProvider(): LlmProvider {
	return {
		name: "test",
		async available() {
			return true;
		},
		async generate() {
			return JSON.stringify({ summary: "noop", mutations: [] });
		},
	};
}

describe("dreaming worker agent scope", () => {
	let db: Database;
	let accessor: DbAccessor;
	let agentsDir: string;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = wrapDb(db);
		agentsDir = mkdtempSync(join(tmpdir(), "dreaming-worker-"));
		initInferenceProviderResolver(() => makeProvider());
	});

	afterEach(() => {
		closeInferenceProviderResolver();
		rmSync(agentsDir, { recursive: true, force: true });
		db.close();
	});

	it("discovers registered and data-bearing agents for periodic checks", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO agents (id, name, read_policy, created_at, updated_at)
			 VALUES (?, ?, 'isolated', ?, ?)`,
		).run("noam", "noam", now, now);
		db.prepare(
			`INSERT INTO memories (id, content, type, agent_id, created_at, updated_at, updated_by)
			 VALUES (?, ?, 'fact', ?, ?, ?, 'test')`,
		).run("mem-agent", "agent-owned memory", "memory-agent", now, now);
		db.prepare(
			`INSERT INTO session_summaries (id, agent_id, content, token_count, depth, kind, earliest_at, latest_at, created_at)
			 VALUES (?, ?, ?, 10, 0, 'session', ?, ?, ?)`,
		).run("summary-agent", "summary-agent", "agent-owned summary", now, now, now);
		db.prepare(
			`INSERT INTO dreaming_state (agent_id, tokens_since_last_pass)
			 VALUES (?, 500)`,
		).run("state-agent");

		expect(getDreamingWorkerAgentIds(accessor, "default")).toEqual([
			"default",
			"memory-agent",
			"noam",
			"state-agent",
			"summary-agent",
		]);
	});

	it("writes manual async trigger passes to the requested agent", async () => {
		const worker = startDreamingWorker(accessor, defaultCfg(), agentsDir, "default");
		try {
			const passId = worker.triggerAsync("incremental", "noam");
			await worker.activePass;

			const row = db.prepare("SELECT agent_id, status, mode FROM dreaming_passes WHERE id = ?").get(passId) as {
				agent_id: string;
				status: string;
				mode: string;
			};
			expect(row).toEqual({ agent_id: "noam", status: "completed", mode: "incremental" });
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM dreaming_passes WHERE agent_id = 'default'").get() as {
					count: number;
				},
			).toEqual({ count: 0 });
		} finally {
			worker.stop();
		}
	});
});
