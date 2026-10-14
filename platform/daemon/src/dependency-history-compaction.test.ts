import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../core/src/migrations";
import { createDbOwnerClient, type DbOwnerClient } from "./db-owner-client";
import { compactDependencyHistoryBatch, startDependencyHistoryCompaction } from "./dependency-history-compaction";

interface HistoryEvent {
	readonly dep: string;
	readonly event: "created" | "deleted" | "updated" | "backfill";
	readonly at: string;
	readonly reason?: string;
	readonly previousReason?: string;
	readonly changedBy?: string;
	readonly agentId?: string;
	readonly target?: string;
}

describe("dependency history compaction", () => {
	let dir = "";
	let path = "";
	let owner: DbOwnerClient | null = null;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-dependency-history-"));
		path = join(dir, "memories.db");
		const db = new Database(path);
		runMigrations(db as never);
		db.close();
	});

	afterEach(async () => {
		await owner?.close();
		owner = null;
		rmSync(dir, { recursive: true, force: true });
	});

	function append(events: readonly HistoryEvent[]): void {
		const db = new Database(path);
		try {
			const insert = db.prepare(
				`INSERT INTO entity_dependency_history
				 (id, dependency_id, source_entity_id, target_entity_id, agent_id, dependency_type, event,
				  changed_by, reason, previous_reason, metadata, created_at)
				 VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, 'wiki_link', ?, ?, ?, ?, '{}', ?)`,
			);
			for (const e of events) {
				insert.run(
					e.dep,
					`source-${e.dep}`,
					e.target ?? `target-${e.dep}`,
					e.agentId ?? "default",
					e.event,
					e.changedBy ?? "db-trigger",
					e.reason ?? `link in ${e.dep}`,
					e.previousReason ?? null,
					e.at,
				);
			}
		} finally {
			db.close();
		}
	}

	function remaining(): string[] {
		const db = new Database(path, { readonly: true });
		try {
			return (
				db
					.prepare("SELECT dependency_id, event, reason, created_at FROM entity_dependency_history ORDER BY rowid")
					.all() as Array<{ dependency_id: string; event: string; reason: string; created_at: string }>
			).map((row) => `${row.dependency_id} ${row.event} ${row.created_at.slice(-2)} ${row.reason}`);
		} finally {
			db.close();
		}
	}

	function state(): { cursor_rowid: number; pruned_rows: number } {
		const db = new Database(path, { readonly: true });
		try {
			return db
				.prepare("SELECT cursor_rowid, pruned_rows FROM dependency_history_compaction_state WHERE id = 1")
				.all()[0] as { cursor_rowid: number; pruned_rows: number };
		} finally {
			db.close();
		}
	}

	async function startOwner(): Promise<DbOwnerClient> {
		owner = createDbOwnerClient({ dbPath: path });
		await owner.start();
		return owner;
	}

	const t0 = "2026-10-05 07:25:00";
	const t1 = "2026-10-05 07:25:01";
	const t2 = "2026-10-05 07:25:02";

	it("removes only delete-then-create pairs that record no change and keeps every meaningful event", async () => {
		append([
			{ dep: "rebuilt", event: "created", at: t0 },
			{ dep: "reason-changed", event: "created", at: t0 },
			{ dep: "really-deleted", event: "created", at: t0 },
			{ dep: "split-second", event: "created", at: t0 },
			{ dep: "interleaved", event: "created", at: t0 },
			{ dep: "touched", event: "created", at: t0 },
			{ dep: "backfilled", event: "backfill", at: t0, changedBy: "migration-050" },
			{ dep: "rebuilt-twice", event: "created", at: t0 },
			{ dep: "foreign-writer", event: "created", at: t0 },
			{ dep: "retargeted", event: "created", at: t0 },
			{ dep: "rebuilt", event: "deleted", at: t1 },
			{ dep: "reason-changed", event: "deleted", at: t1 },
			{ dep: "really-deleted", event: "deleted", at: t1 },
			{ dep: "split-second", event: "deleted", at: t1 },
			{ dep: "interleaved", event: "deleted", at: t1 },
			{ dep: "interleaved", event: "updated", at: t1, previousReason: "link in interleaved" },
			{ dep: "touched", event: "updated", at: t1, previousReason: "link in touched" },
			{ dep: "backfilled", event: "deleted", at: t1 },
			{ dep: "rebuilt-twice", event: "deleted", at: t1 },
			{ dep: "foreign-writer", event: "deleted", at: t1, changedBy: "manual-repair" },
			{ dep: "retargeted", event: "deleted", at: t1 },
			{ dep: "rebuilt", event: "created", at: t1 },
			{ dep: "reason-changed", event: "created", at: t1, reason: "link in reason-changed, renamed" },
			{ dep: "split-second", event: "created", at: t2 },
			{ dep: "interleaved", event: "created", at: t1 },
			{ dep: "backfilled", event: "created", at: t1 },
			{ dep: "rebuilt-twice", event: "created", at: t1 },
			{ dep: "foreign-writer", event: "created", at: t1 },
			{ dep: "retargeted", event: "created", at: t1, target: "another-target" },
			{ dep: "rebuilt-twice", event: "deleted", at: t2 },
			{ dep: "rebuilt-twice", event: "created", at: t2 },
		]);
		const client = await startOwner();

		let batches = 0;
		for (;;) {
			const batch = await compactDependencyHistoryBatch(client, { windowRows: 4 });
			batches += 1;
			if (batch.caughtUp) break;
			expect(batches).toBeLessThan(50);
		}

		expect(batches).toBeGreaterThan(1);
		expect(remaining()).toEqual([
			"rebuilt created 00 link in rebuilt",
			"reason-changed created 00 link in reason-changed",
			"really-deleted created 00 link in really-deleted",
			"split-second created 00 link in split-second",
			"interleaved created 00 link in interleaved",
			"touched created 00 link in touched",
			"backfilled backfill 00 link in backfilled",
			"rebuilt-twice created 00 link in rebuilt-twice",
			"foreign-writer created 00 link in foreign-writer",
			"retargeted created 00 link in retargeted",
			"reason-changed deleted 01 link in reason-changed",
			"really-deleted deleted 01 link in really-deleted",
			"split-second deleted 01 link in split-second",
			"interleaved deleted 01 link in interleaved",
			"interleaved updated 01 link in interleaved",
			"touched updated 01 link in touched",
			"foreign-writer deleted 01 link in foreign-writer",
			"retargeted deleted 01 link in retargeted",
			"reason-changed created 01 link in reason-changed, renamed",
			"split-second created 02 link in split-second",
			"interleaved created 01 link in interleaved",
			"foreign-writer created 01 link in foreign-writer",
			"retargeted created 01 link in retargeted",
		]);
		expect(state().pruned_rows).toBe(8);
	});

	it("drains in bounded cycles, terminates when caught up, and resumes for rows appended later", async () => {
		const rebuild = (dep: string, at: string): HistoryEvent[] => [
			{ dep, event: "deleted", at },
			{ dep, event: "created", at },
		];
		const deps = Array.from({ length: 6 }, (_, i) => `dep-${i}`);
		append(deps.map((dep) => ({ dep, event: "created" as const, at: t0 })));
		append(deps.flatMap((dep) => rebuild(dep, t1)));
		const client = await startOwner();
		const worker = startDependencyHistoryCompaction(client, {
			windowRows: 3,
			maxBatchesPerCycle: 2,
			startDelayMs: 24 * 60 * 60 * 1000,
			yieldMs: 0,
		});
		try {
			const first = await worker.runCycle();
			expect(first).toMatchObject({ batches: 2, caughtUp: false });

			let cycles = 1;
			let last = first;
			while (!last.caughtUp) {
				last = await worker.runCycle();
				cycles += 1;
				expect(last.batches).toBeLessThanOrEqual(2);
				expect(cycles).toBeLessThan(20);
			}
			expect(remaining()).toEqual(deps.map((dep) => `${dep} created 00 link in ${dep}`));
			expect(state().pruned_rows).toBe(12);

			const idle = await worker.runCycle();
			expect(idle).toMatchObject({ batches: 1, pruned: 0, caughtUp: true });

			append(rebuild("dep-0", t2));
			append([{ dep: "dep-1", event: "deleted", at: t2 }]);
			const resumed = await worker.runCycle();
			expect(resumed).toMatchObject({ pruned: 2, caughtUp: true });
			expect(remaining()).toEqual([
				...deps.map((dep) => `${dep} created 00 link in ${dep}`),
				"dep-1 deleted 02 link in dep-1",
			]);
			expect(state().pruned_rows).toBe(14);
		} finally {
			await worker.stop();
		}
		expect(worker.running).toBe(false);
	});
});
