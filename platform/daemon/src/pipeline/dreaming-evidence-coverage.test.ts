import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { ReadDb } from "../db-accessor";
import {
	DREAMING_EVIDENCE_COVERAGE_MAX_PASSES,
	DREAMING_EVIDENCE_COVERAGE_MAX_SOURCES,
	getDreamingEvidenceCoverageInDb,
} from "./dreaming-evidence-coverage";

const AGENT = "agent-a";
const OTHER = "agent-b";
const CONTENT = "a".repeat(120);
const BOUNDS = { maxSources: DREAMING_EVIDENCE_COVERAGE_MAX_SOURCES, maxPasses: DREAMING_EVIDENCE_COVERAGE_MAX_PASSES };

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
		expect(coverage.complete).toBe(true);
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
		expect(coverage.complete).toBe(true);
	});

	it("marks coverage incomplete when the source bound truncates the scan", () => {
		seedMemory(db, "mem-a", "2026-01-01 00:00:01");
		seedMemory(db, "mem-b", "2026-01-01 00:00:02");
		const coverage = getDreamingEvidenceCoverageInDb(db as unknown as ReadDb, AGENT, {
			maxSources: 1,
			maxPasses: DREAMING_EVIDENCE_COVERAGE_MAX_PASSES,
		});
		expect(coverage.sources.eligible).toBe(1);
		expect(coverage.complete).toBe(false);
	});
});
