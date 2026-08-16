import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DreamingConfig } from "@signet/core";

import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor } from "../db-accessor";
import { DreamingLiveBus } from "./dreaming-live";
import type { DreamingAgentExecutor, DreamingConfig } from "./dreaming";
import { failingExecutorFactory, startDreamingWorker } from "./dreaming-worker";

function defaultCfg(overrides?: Partial<DreamingConfig>): DreamingConfig {
	return {
		enabled: true,
		tokenThreshold: 100_000,
		maxInterval: 6 * 60 * 60 * 1_000,
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
		withReadDbAsync<T>(fn: (db: Database) => Promise<T>): Promise<T> {
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
		withWriteTxAsync<T>(fn: (db: Database) => T): Promise<T> {
			return Promise.resolve().then(() => {
				db.exec("BEGIN IMMEDIATE");
				try {
					const result = fn(db);
					db.exec("COMMIT");
					return result;
				} catch (e) {
					db.exec("ROLLBACK");
					throw e;
				}
			});
		},
	} as unknown as DbAccessor;
}

async function waitForTerminal(
	bus: DreamingLiveBus,
	passId: string,
): Promise<boolean> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (bus.states(passId)?.terminal) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return false;
}

describe("dreaming worker live-observation wiring (#1601)", () => {

	let db: Database;
	let accessor: DbAccessor;
	let agentsDir: string;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = wrapDb(db);
		agentsDir = mkdtempSync(join(tmpdir(), "dreaming-live-wiring-"));
	});

	afterEach(() => {
		rmSync(agentsDir, { recursive: true, force: true });
		db.close();
	});

	it("forwards normalized observation events to the live bus during a pass", async () => {
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, agent_id, content, harness, created_at, updated_at, completed_at)
			 VALUES ('live-wiring-evidence', 'default', 'Evidence driving the observation probe.', 'pi',
			         datetime('now'), datetime('now'), datetime('now'))`,
		).run();
		const bus = new DreamingLiveBus();
		const executorFactory = (): DreamingAgentExecutor => ({
			async run(input: Parameters<DreamingAgentExecutor["run"]>[0]) {
				const sink = input.dreamingLiveEvents?.sink;
				expect(typeof sink).toBe("function");
				sink?.({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", text: "wired observation" },
				});
				return { summary: "wired pass" };
			},
		});

		const worker = startDreamingWorker(
			accessor,
			defaultCfg({ tokenThreshold: 1 }),
			agentsDir,
			"default",
			{
				executorFactory,
				liveEvents: { bus },
			},
		);
		try {
			const passId = await worker.triggerAsync("incremental", "default");
			await worker.activePass;

			const replay = bus.replay(passId, 0);
			expect(replay.map((frame) => frame.event.type)).toEqual([
				"assistant_delta",
				"state_transition",
			]);
			expect(replay[1].event).toEqual({
				type: "state_transition",
				passId,
				state: "completed",
				message: "wired pass",
			});
			expect(db.prepare("SELECT status FROM dreaming_passes WHERE id = ?").get(passId)).toEqual({
				status: "completed",
			});
		} finally {
			worker.stop();
			bus.pruneAll();
		}
	});

	it("emits a terminal state transition when a triggered pass fails", async () => {
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, agent_id, content, harness, created_at, updated_at, completed_at)
			 VALUES ('live-wiring-failure-evidence', 'default', 'Evidence driving the failure probe.', 'pi',
			         datetime('now'), datetime('now'), datetime('now'))`,
		).run();
		const bus = new DreamingLiveBus();
		// Module-side failure injection: Bun's async-throw attribution
		// attributes expected failures to module-source positions (reported
		// neither as test errors nor as unhandled throws), whereas the same
		// throw defined in this test file is reported as a test error under
		// `bun test` even when caught downstream.
		const executorFactory = failingExecutorFactory("provider failure");

		const worker = startDreamingWorker(
			accessor,
			defaultCfg({ tokenThreshold: 1 }),
			agentsDir,
			"default",
			{
				executorFactory,
				liveEvents: { bus },
			},
		);
		try {
			let passId = "";
			try {
				passId = await worker.triggerAsync("incremental", "default");
			} catch (e) {
				expect(e).toBeInstanceOf(Error);
			}
			// The lifecycle reaction attached at triggerAsync time settles the
			// terminal state asynchronously; poll its observable effect.
			const terminalSeen = await waitForTerminal(bus, passId);
			expect(terminalSeen).toBe(true);
			const terminal = bus.replay(passId, 0).find((frame) => frame.event.type === "state_transition");
			expect(terminal).toBeDefined();
			expect(terminal?.event.state).toBe("failed");
			expect(terminal?.event.message).toContain("provider failure");
			const row = db.prepare("SELECT status FROM dreaming_passes WHERE id = ?").get(passId) as { status: string } | null;
			expect(row?.status).toBe("failed");
		} finally {
			worker.stop();
			bus.pruneAll();
		}
	});
});
