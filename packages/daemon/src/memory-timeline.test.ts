import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@signet/core";
import type { ReadDb } from "./db-accessor";
import { buildMemoryTimeline } from "./memory-timeline";

function makeDb(): Database {
	const db = new Database(":memory:");
	runMigrations(db as any);
	return db;
}

function insertMemory(
	db: Database,
	args: {
		id: string;
		createdAt: string;
		type?: string;
		who?: string;
		tags?: string | null;
		importance?: number;
		pinned?: number;
		deleted?: number;
	},
): void {
	db.prepare(
		`INSERT INTO memories
		 (id, content, type, who, tags, importance, pinned, source_type, is_deleted, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'test', ?, ?, ?)`,
	).run(
		args.id,
		`content-${args.id}`,
		args.type ?? "fact",
		args.who ?? "agent",
		args.tags ?? null,
		args.importance ?? 0.5,
		args.pinned ?? 0,
		args.deleted ?? 0,
		args.createdAt,
		args.createdAt,
	);
}

function insertHistory(
	db: Database,
	args: {
		id: string;
		memoryId: string;
		event: string;
		createdAt: string;
		reason?: string;
	},
): void {
	db.prepare(
		`INSERT INTO memory_history
		 (id, memory_id, event, old_content, new_content, changed_by, reason, metadata, created_at)
		 VALUES (?, ?, ?, NULL, NULL, 'tester', ?, NULL, ?)`,
	).run(args.id, args.memoryId, args.event, args.reason ?? null, args.createdAt);
}

describe("buildMemoryTimeline", () => {
	test("builds fixed buckets for today, last week, and one month", () => {
		const db = makeDb();
		try {
			insertMemory(db, {
				id: "mem-today",
				createdAt: "2026-03-04T09:00:00.000Z",
				type: "fact",
				who: "claude",
				tags: "alpha,beta",
				importance: 0.9,
				pinned: 1,
			});
			insertMemory(db, {
				id: "mem-last-week",
				createdAt: "2026-03-01T12:00:00.000Z",
				type: "decision",
				who: "opencode",
				tags: '["beta","gamma"]',
				importance: 0.7,
			});
			insertMemory(db, {
				id: "mem-one-month",
				createdAt: "2026-02-10T12:00:00.000Z",
				type: "preference",
				who: "opencode",
				importance: 0.6,
			});
			insertMemory(db, {
				id: "mem-too-old",
				createdAt: "2025-12-20T12:00:00.000Z",
				type: "fact",
			});

			insertHistory(db, {
				id: "hist-1",
				memoryId: "mem-last-week",
				event: "updated",
				createdAt: "2026-03-01T13:00:00.000Z",
				reason: "reinforced with follow-up",
			});
			insertHistory(db, {
				id: "hist-2",
				memoryId: "mem-one-month",
				event: "recovered",
				createdAt: "2026-02-10T13:00:00.000Z",
			});

			const timeline = buildMemoryTimeline(db as unknown as ReadDb, {
				now: new Date("2026-03-04T16:00:00.000Z"),
			});

			expect(timeline.buckets).toHaveLength(3);
			expect(timeline.rangePreset).toBe("today-last_week-one_month");

			const today = timeline.buckets[0];
			expect(today.label).toBe("Today");
			expect(today.memoriesAdded).toBe(1);
			expect(today.pinned).toBe(1);

			const lastWeek = timeline.buckets[1];
			expect(lastWeek.label).toBe("Last week");
			expect(lastWeek.memoriesAdded).toBe(2);
			expect(lastWeek.evolved).toBe(1);
			expect(lastWeek.strengthened).toBe(1);

			const oneMonth = timeline.buckets[2];
			expect(oneMonth.label).toBe("One month");
			expect(oneMonth.memoriesAdded).toBe(3);
			expect(oneMonth.evolved).toBe(2);
			expect(oneMonth.recovered).toBe(1);
		} finally {
			db.close();
		}
	});

	test("handles invalid timestamps safely", () => {
		const db = makeDb();
		try {
			insertMemory(db, {
				id: "mem-valid",
				createdAt: "2026-03-04T09:00:00.000Z",
			});

			db.prepare(
				`INSERT INTO memories
				 (id, content, type, source_type, is_deleted, created_at, updated_at)
				 VALUES ('mem-invalid', 'oops', 'fact', 'test', 0, 'not-a-date', 'not-a-date')`,
			).run();

			insertHistory(db, {
				id: "hist-invalid",
				memoryId: "mem-valid",
				event: "updated",
				createdAt: "nope-date",
			});

			const timeline = buildMemoryTimeline(db as unknown as ReadDb, {
				now: new Date("2026-03-04T16:00:00.000Z"),
			});

			expect(timeline.invalidMemoryTimestamps).toBe(1);
			expect(timeline.invalidHistoryTimestamps).toBe(1);
			expect(timeline.buckets[0]?.memoriesAdded).toBe(1);
		} finally {
			db.close();
		}
	});

	test("ignores soft-deleted memories and their history", () => {
		const db = makeDb();
		try {
			insertMemory(db, {
				id: "mem-live",
				createdAt: "2026-03-04T09:00:00.000Z",
			});
			insertMemory(db, {
				id: "mem-deleted",
				createdAt: "2026-03-04T09:00:00.000Z",
				deleted: 1,
			});

			insertHistory(db, {
				id: "hist-live",
				memoryId: "mem-live",
				event: "updated",
				createdAt: "2026-03-04T10:00:00.000Z",
			});
			insertHistory(db, {
				id: "hist-deleted",
				memoryId: "mem-deleted",
				event: "updated",
				createdAt: "2026-03-04T10:00:00.000Z",
			});

			const timeline = buildMemoryTimeline(db as unknown as ReadDb, {
				now: new Date("2026-03-04T16:00:00.000Z"),
			});

			expect(timeline.totalMemories).toBe(1);
			expect(timeline.totalHistoryEvents).toBe(1);
			expect(timeline.buckets[0]?.memoriesAdded).toBe(1);
			expect(timeline.buckets[0]?.trackedEvents).toBe(1);
		} finally {
			db.close();
		}
	});
});
