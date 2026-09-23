import { describe, expect, it } from "bun:test";
import {
	type ReviewDueAccessor,
	collectReviewDueClaims,
	findApproachingReviewDueMemories,
	findExpiredReviewDueMemories,
} from "./memory-review-due";

interface Row {
	readonly id: string;
	readonly content: string;
	readonly type: string;
	readonly importance: number;
	readonly review_after: string;
	readonly created_at: string;
	readonly agent_id: string;
	readonly scope: string | null;
	readonly is_deleted: number;
}

function memory(id: string, reviewAfter: string, isDeleted = 0): Row {
	return {
		id,
		content: `claim ${id}`,
		type: "fact",
		importance: 0.7,
		review_after: reviewAfter,
		created_at: "2026-01-01T00:00:00.000Z",
		agent_id: "default",
		scope: null,
		is_deleted: isDeleted,
	};
}

class FakeAccessor implements ReviewDueAccessor {
	rows: Row[] = [];
	sqls: string[] = [];

	all<T>(sql: string, ...params: unknown[]): T[] {
		this.sqls.push(sql);
		const now = String(params[0]);
		const limit = Number(params[params.length - 1]);
		// Minimal emulation of the SQL semantics for the two query shapes.
		if (sql.includes("review_after < ?")) {
			return this.rows
				.filter((r) => r.review_after < now && r.is_deleted === 0)
				.sort((a, b) => a.review_after.localeCompare(b.review_after))
				.slice(0, limit) as unknown as T[];
		}
		const horizon = String(params[1]);
		return this.rows
			.filter((r) => r.review_after >= now && r.review_after <= horizon && r.is_deleted === 0)
			.sort((a, b) => a.review_after.localeCompare(b.review_after))
			.slice(0, limit) as unknown as T[];
	}
}

const NOW = "2026-08-01T00:00:00.000Z";

describe("findExpiredReviewDueMemories", () => {
	it("returns claims whose review_after has passed, oldest first", () => {
		const accessor = new FakeAccessor();
		accessor.rows = [
			memory("expired-old", "2026-03-15T00:00:00.000Z"),
			memory("future", "2026-09-15T00:00:00.000Z"),
			memory("expired-recent", "2026-07-20T00:00:00.000Z"),
		];
		const result = findExpiredReviewDueMemories(accessor, new Date(NOW));
		expect(result.map((r) => r.id)).toEqual(["expired-old", "expired-recent"]);
		expect(result[0]).toMatchObject({ reviewAfter: "2026-03-15T00:00:00.000Z" });
	});

	it("excludes soft-deleted memories", () => {
		const accessor = new FakeAccessor();
		accessor.rows = [memory("deleted", "2026-01-01T00:00:00.000Z", 1), memory("live", "2026-01-02T00:00:00.000Z")];
		expect(findExpiredReviewDueMemories(accessor, new Date(NOW)).map((r) => r.id)).toEqual(["live"]);
	});

	it("returns nothing when no claim has expired", () => {
		const accessor = new FakeAccessor();
		accessor.rows = [memory("future", "2026-09-15T00:00:00.000Z")];
		expect(findExpiredReviewDueMemories(accessor, new Date(NOW))).toEqual([]);
	});
});

describe("findApproachingReviewDueMemories", () => {
	it("returns claims within the look-ahead window", () => {
		const accessor = new FakeAccessor();
		accessor.rows = [
			memory("in-window", "2026-08-03T00:00:00.000Z"),
			memory("far-future", "2026-12-01T00:00:00.000Z"),
			memory("already-expired", "2026-07-01T00:00:00.000Z"),
		];
		const result = findApproachingReviewDueMemories(accessor, new Date(NOW), {
			expiringSoonMs: 7 * 24 * 60 * 60 * 1000,
		});
		expect(result.map((r) => r.id)).toEqual(["in-window"]);
	});

	it("honors a custom look-ahead window", () => {
		const accessor = new FakeAccessor();
		accessor.rows = [memory("in-30d", "2026-08-20T00:00:00.000Z")];
		const result = findApproachingReviewDueMemories(accessor, new Date(NOW), {
			expiringSoonMs: 30 * 24 * 60 * 60 * 1000,
		});
		expect(result.map((r) => r.id)).toEqual(["in-30d"]);
	});
});

describe("collectReviewDueClaims", () => {
	it("returns expired and approaching claims together", () => {
		const accessor = new FakeAccessor();
		accessor.rows = [
			memory("expired", "2026-03-15T00:00:00.000Z"),
			memory("approaching", "2026-08-03T00:00:00.000Z"),
			memory("far", "2026-12-01T00:00:00.000Z"),
		];
		const result = collectReviewDueClaims(accessor, new Date(NOW));
		expect(result.expired.map((r) => r.id)).toEqual(["expired"]);
		expect(result.approaching.map((r) => r.id)).toEqual(["approaching"]);
	});

	it("bounds the combined expired and approaching result by limit", () => {
		const accessor = new FakeAccessor();
		accessor.rows = [memory("expired", "2026-03-15T00:00:00.000Z"), memory("approaching", "2026-08-03T00:00:00.000Z")];
		const result = collectReviewDueClaims(accessor, new Date(NOW), { limit: 1 });
		expect(result.expired.map((r) => r.id)).toEqual(["expired"]);
		expect(result.approaching).toEqual([]);
	});
});
