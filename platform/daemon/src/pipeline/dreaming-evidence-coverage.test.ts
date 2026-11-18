import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { ReadDb } from "../db-accessor";
import {
	DREAMING_EVIDENCE_COVERAGE_DEADLINE_MS,
	DREAMING_EVIDENCE_COVERAGE_MAX_PASSES,
	DREAMING_EVIDENCE_COVERAGE_MAX_SOURCES,
	getDreamingEvidenceCoverageInDb,
	scanDreamingEvidenceCoverageStep,
} from "./dreaming-evidence-coverage";
import { readRecentEpisodicSources } from "../episodic-sources";

const AGENT = "agent-a";
const OTHER = "agent-b";
const CONTENT = "a".repeat(120);
const BOUNDS = {
	maxSources: DREAMING_EVIDENCE_COVERAGE_MAX_SOURCES,
	maxPasses: DREAMING_EVIDENCE_COVERAGE_MAX_PASSES,
	deadlineMs: DREAMING_EVIDENCE_COVERAGE_DEADLINE_MS,
};

function seedMemory(db: Database, id: string, capturedAt: string, agentId = AGENT, content = CONTENT): void {
	db.prepare(
		`INSERT INTO memories
		 (id, content, source_type, memory_kind, visibility, agent_id, created_at, updated_at)
		 VALUES (?, ?, 'manual', 'episodic', 'normal', ?, ?, ?)`,
	).run(id, content, agentId, capturedAt, capturedAt);
}

function seedPass(db: Database, id: string, agentId = AGENT): void {
	db.prepare(
		`INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at)
		 VALUES (?, ?, 'incremental', 'completed', datetime('now'), datetime('now'))`,
	).run(id, agentId);
}

function seedConsumption(
	db: Database,
	sourceId: string,
	capturedAt: string,
	offset: number,
	basis: "review" | "delivery",
	options: { readonly passId?: string; readonly stalledPasses?: number; readonly agentId?: string } = {},
): void {
	db.prepare(
		`INSERT INTO dreaming_evidence_consumption
		 (agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision,
		  delivered_offset, source_length, pass_id, updated_at, cursor_basis, stalled_passes)
		 VALUES (?, 'memory', ?, ?, '', ?, ?, ?, ?, datetime('now'), ?, ?)`,
	).run(
		options.agentId ?? AGENT,
		sourceId,
		capturedAt,
		capturedAt,
		offset,
		CONTENT.length,
		options.passId ?? `fixture-${sourceId}`,
		basis,
		options.stalledPasses ?? 0,
	);
}

function seedDelivery(
	db: Database,
	passId: string,
	sourceId: string,
	capturedAt: string,
	start: number,
	end: number,
	agentId = AGENT,
): void {
	const sequence = (db.prepare("SELECT COUNT(*) AS count FROM dreaming_tool_calls").get() as { count: number }).count;
	db.prepare(
		`INSERT INTO dreaming_tool_calls
		 (id, agent_id, pass_id, sequence, tool_name, input_json, output_json, success, latency_ms)
		 VALUES (?, ?, ?, ?, 'search_evidence', ?, ?, 1, 0)`,
	).run(
		`${passId}-${start}`,
		agentId,
		passId,
		sequence,
		JSON.stringify({ agentId }),
		JSON.stringify({
			ok: true,
			items: [
				{
					sourceRef: `memory:${sourceId}`,
					capturedAt,
					sourceRevision: capturedAt,
					sourceEntryId: "",
					contentOffset: start,
					contentLength: CONTENT.length,
					content: CONTENT.slice(start, end),
				},
			],
		}),
	);
}

function seedStalledAttention(db: Database, subjectRef: string, resolved: boolean): void {
	db.prepare(
		`INSERT INTO dreaming_attention (id, agent_id, kind, subject_ref, details_json, priority, resolved_at)
		 VALUES (?, ?, 'evidence_requeue', ?, json_object('reason', 'evidence-stalled'), 60, ?)`,
	).run(
		`attention-${subjectRef}-${resolved ? "resolved" : "open"}`,
		AGENT,
		`${subjectRef}${resolved ? "-resolved" : ""}`,
		resolved ? datetimeNow(db) : null,
	);
}

function datetimeNow(db: Database): string {
	return (db.prepare("SELECT datetime('now') AS now").get() as { now: string }).now;
}

describe("dreaming evidence coverage", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	function seedScenario(): void {
		const t = (suffix: number): string => `2026-01-01 00:00:0${suffix}`;
		seedMemory(db, "mem-full", t(1));
		seedMemory(db, "mem-partial", t(2));
		seedMemory(db, "mem-never", t(3));
		seedMemory(db, "mem-overlap", t(4));
		seedMemory(db, "mem-defect", t(5));
		seedMemory(db, "mem-other", t(6), OTHER, "b".repeat(50));
		seedPass(db, "pass-full");
		seedPass(db, "pass-partial");
		seedPass(db, "pass-overlap-1");
		seedPass(db, "pass-overlap-2");
		seedPass(db, "pass-other", OTHER);
		seedConsumption(db, "mem-full", t(1), CONTENT.length, "review", { passId: "pass-full" });
		seedConsumption(db, "mem-partial", t(2), 40, "review", { passId: "pass-partial" });
		seedConsumption(db, "mem-overlap", t(4), CONTENT.length, "review", { passId: "pass-overlap-1", stalledPasses: 2 });
		seedConsumption(db, "mem-defect", t(5), CONTENT.length, "delivery");
		seedConsumption(db, "mem-other", t(6), 50, "review", { passId: "pass-other", agentId: OTHER });
		seedDelivery(db, "pass-overlap-1", "mem-overlap", t(4), 0, 60);
		seedDelivery(db, "pass-overlap-2", "mem-overlap", t(4), 40, 120);
		seedStalledAttention(db, "memory:mem-overlap", false);
		seedStalledAttention(db, "memory:mem-overlap", true);
	}

	it("classifies eligible evidence exactly once per scope", () => {
		seedScenario();
		const coverage = getDreamingEvidenceCoverageInDb(db as unknown as ReadDb, AGENT, BOUNDS);
		expect(coverage.agentId).toBe(AGENT);
		expect(coverage.sources.eligible).toBe(5);
		expect(coverage.sources.fullyReviewed).toBe(2);
		expect(coverage.sources.partiallyReviewed).toBe(1);
		expect(coverage.sources.neverDelivered).toBe(1);
		expect(coverage.chars.eligible).toBe(600);
		expect(coverage.chars.reviewed).toBe(280);
		expect(coverage.chars.unreviewed).toBe(320);
		expect(coverage.chars.consumedWithoutReview).toBe(120);
		expect(coverage.chars.delivered).toBe(140);
		expect(coverage.chars.redelivered).toBe(20);
		expect(coverage.redeliveryRatio).toBeCloseTo(20 / 140, 12);
		expect(coverage.chars.consumedByCursorBasis).toEqual({ review: 280, delivery: 120 });
		expect(coverage.chars.stalledRows).toBe(1);
		expect(coverage.pendingContinuations).toBe(1);
		expect(coverage.openStalledAttention).toBe(1);
		expect(coverage.scanComplete).toBe(true);
		expect(coverage.fullyReviewed).toBe(false);
		expect(coverage.dreamedFraction).toBeCloseTo(280 / 600, 12);
		expect(coverage.byKind.memory).toEqual({
			sources: { eligible: 5, fullyReviewed: 2, partiallyReviewed: 1, neverDelivered: 1 },
			chars: {
				eligible: 600,
				reviewed: 280,
				unreviewed: 320,
				consumedWithoutReview: 120,
				delivered: 140,
				redelivered: 20,
				consumedByCursorBasis: { review: 280, delivery: 120 },
				stalledRows: 1,
			},
		});
		expect(coverage.byKind.artifact?.chars.eligible).toBe(0);
		expect(coverage.byKind.transcript?.chars.eligible).toBe(0);
	});

	it("never leaks another agent's evidence into the scoped totals", () => {
		seedScenario();
		const coverage = getDreamingEvidenceCoverageInDb(db as unknown as ReadDb, AGENT, BOUNDS);
		expect(coverage.chars.eligible).toBe(600);
		const other = getDreamingEvidenceCoverageInDb(db as unknown as ReadDb, OTHER, BOUNDS);
		expect(other.sources.eligible).toBe(1);
		expect(other.chars.eligible).toBe(50);
		expect(other.chars.reviewed).toBe(50);
		expect(other.chars.consumedWithoutReview).toBe(0);
		expect(other.sources.neverDelivered).toBe(0);
	});

	it("reports null dreamedFraction when no evidence is eligible", () => {
		const coverage = getDreamingEvidenceCoverageInDb(db as unknown as ReadDb, AGENT, BOUNDS);
		expect(coverage.sources.eligible).toBe(0);
		expect(coverage.chars.eligible).toBe(0);
		expect(coverage.dreamedFraction).toBeNull();
		expect(coverage.scanComplete).toBe(true);
		expect(coverage.fullyReviewed).toBe(false);
	});

	it("marks coverage incomplete when the source bound truncates the scan", () => {
		seedMemory(db, "mem-a", "2026-01-01 00:00:01");
		seedMemory(db, "mem-b", "2026-01-01 00:00:02");
		const coverage = getDreamingEvidenceCoverageInDb(db as unknown as ReadDb, AGENT, {
			maxSources: 1,
			maxPasses: DREAMING_EVIDENCE_COVERAGE_MAX_PASSES,
			deadlineMs: DREAMING_EVIDENCE_COVERAGE_DEADLINE_MS,
		});
		expect(coverage.sources.eligible).toBe(1);
		expect(coverage.scanComplete).toBe(false);
	});

	it("counts each requeued source once even when it predates the cursor", () => {
		const total = 150;
		for (let i = 0; i < total; i += 1) {
			seedMemory(db, `mem-rq-${i}`, `2026-01-01 00:00:${String(i % 60).padStart(2, "0")}`);
			db.prepare(
				`INSERT INTO dreaming_evidence_exclusions
				 (agent_id, source_kind, source_id, reason, pass_id, requeue_requested_at, resolved_at)
				 VALUES (?, 'memory', ?, 'coverage-fixture', 'fixture-pass', datetime('now'), NULL)`,
			).run(AGENT, `mem-rq-${i}`);
		}
		const coverage = getDreamingEvidenceCoverageInDb(db as unknown as ReadDb, AGENT, BOUNDS);
		expect(coverage.sources.eligible).toBe(total);
		expect(coverage.scanComplete).toBe(true);
	});

	it("pages cursor-only source enumeration without repeating older requeued rows", () => {
		const total = 150;
		for (let i = 0; i < total; i += 1) {
			seedMemory(
				db,
				`mem-page-${i}`,
				`2026-01-01 00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
			);
		}
		const seen = new Set<string>();
		let cursor: Parameters<typeof readRecentEpisodicSources>[6] | null = null;
		for (let page = 0; page < 5; page += 1) {
			const rows = readRecentEpisodicSources(
				db as unknown as ReadDb,
				AGENT,
				100,
				["memory"],
				null,
				"oldest",
				cursor,
				undefined,
				false,
			);
			for (const row of rows) seen.add(row.id);
			if (rows.length === 0) break;
			const last = rows[rows.length - 1];
			cursor = { capturedAt: last.capturedAt, kind: last.kind, id: last.id };
		}
		expect(seen.size).toBe(total);
	});

	it("reports fullyReviewed only for a fully reviewed, fully consumed scope", () => {
		seedMemory(db, "mem-done", "2026-01-01 00:00:01");
		seedPass(db, "pass-done");
		seedConsumption(db, "mem-done", "2026-01-01 00:00:01", CONTENT.length, "review", { passId: "pass-done" });
		const coverage = getDreamingEvidenceCoverageInDb(db as unknown as ReadDb, AGENT, BOUNDS);
		expect(coverage.sources.fullyReviewed).toBe(1);
		expect(coverage.chars.unreviewed).toBe(0);
		expect(coverage.chars.consumedWithoutReview).toBe(0);
		expect(coverage.scanComplete).toBe(true);
		expect(coverage.fullyReviewed).toBe(true);
	});

	it("completes the scan when the source cap exactly matches eligible sources", () => {
		for (const suffix of ["a", "b", "c"]) {
			seedMemory(db, `mem-exact-${suffix}`, `2026-01-01 00:00:0${suffix === "a" ? 1 : suffix === "b" ? 2 : 3}`);
		}
		const coverage = getDreamingEvidenceCoverageInDb(db as unknown as ReadDb, AGENT, { ...BOUNDS, maxSources: 3 });
		expect(coverage.sources.eligible).toBe(3);
		expect(coverage.scanComplete).toBe(true);
	});

	it("reports drift when eligible sources outnumber the walked window", () => {
		seedMemory(db, "mem-old", "2026-01-01 00:00:01");
		seedMemory(db, "mem-new", "2026-01-01 00:00:02");
		const coverage = getDreamingEvidenceCoverageInDb(db as unknown as ReadDb, AGENT, { ...BOUNDS, maxSources: 1 });
		expect(coverage.sources.eligible).toBe(1);
		expect(coverage.scanComplete).toBe(false);
	});

	it("counts a source inserted after page one as drift against the fresh count", () => {
		seedMemory(db, "mem-page-one", "2026-01-01 00:00:02");
		const first = scanDreamingEvidenceCoverageStep(db as unknown as ReadDb, {
			step: "sources",
			agentId: AGENT,
			cursor: null,
			limit: 1,
		});
		expect(first.entries).toHaveLength(1);
		seedMemory(db, "mem-late", "2026-01-01 00:00:01");
		const count = scanDreamingEvidenceCoverageStep(db as unknown as ReadDb, {
			step: "count",
			agentId: AGENT,
			bound: 1000,
		});
		if (count.step !== "count") throw new Error("expected a count step");
		expect(count.eligible).toBe(2);
	});

	it("marks the scan incomplete when delivery ranges exceed the per-entry cap", () => {
		seedMemory(db, "mem-many-ranges", "2026-01-01 00:00:01");
		for (let index = 0; index < 205; index += 1) {
			const passId = `pass-range-${index}`;
			seedPass(db, passId);
			seedDelivery(db, passId, "mem-many-ranges", "2026-01-01 00:00:01", index % 115, (index % 115) + 1);
		}
		const coverage = getDreamingEvidenceCoverageInDb(db as unknown as ReadDb, AGENT, BOUNDS);
		expect(coverage.chars.redelivered).toBeGreaterThan(0);
		expect(coverage.scanComplete).toBe(false);
	});

	it("keeps a page of large sources under the owner result budget", () => {
		for (let index = 0; index < 100; index += 1) {
			seedMemory(db, `mem-wide-${String(index).padStart(3, "0")}`.repeat(500), "2026-01-01 00:00:01");
		}
		const coverage = getDreamingEvidenceCoverageInDb(db as unknown as ReadDb, AGENT, BOUNDS);
		expect(coverage.scanComplete).toBe(false);
	});
});
