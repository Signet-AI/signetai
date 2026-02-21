/**
 * Tests for the analytics collector and timeline builder.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@signet/core";
import {
	createAnalyticsCollector,
	type AnalyticsCollector,
	type ErrorEntry,
} from "./analytics";
import { buildTimeline, type TimelineSources } from "./timeline";
import type { ReadDb } from "./db-accessor";
import type { LogEntry } from "./logger";

// ---------------------------------------------------------------------------
// Analytics Collector Tests
// ---------------------------------------------------------------------------

describe("AnalyticsCollector", () => {
	let collector: AnalyticsCollector;

	beforeEach(() => {
		collector = createAnalyticsCollector(10);
	});

	describe("usage counters", () => {
		it("tracks endpoint request counts and latency", () => {
			collector.recordRequest("POST", "/api/memory/remember", 200, 150);
			collector.recordRequest("POST", "/api/memory/remember", 200, 250);
			collector.recordRequest("POST", "/api/memory/remember", 500, 50);

			const usage = collector.getUsage();
			const ep = usage.endpoints["POST /api/memory/remember"];
			expect(ep).toBeDefined();
			expect(ep.count).toBe(3);
			expect(ep.errors).toBe(1);
			expect(ep.totalLatencyMs).toBe(450);
		});

		it("tracks actor stats by operation type", () => {
			collector.recordRequest("POST", "/api/memory/remember", 200, 10, "agent-1");
			collector.recordRequest("POST", "/api/memory/recall", 200, 10, "agent-1");
			collector.recordRequest("POST", "/api/memory/recall", 200, 10, "agent-1");
			collector.recordRequest("POST", "/api/memory/modify", 200, 10, "agent-1");
			collector.recordRequest("GET", "/api/status", 200, 10, "agent-1");

			const usage = collector.getUsage();
			const actor = usage.actors["agent-1"];
			expect(actor.remembers).toBe(1);
			expect(actor.recalls).toBe(2);
			expect(actor.mutations).toBe(1);
			expect(actor.requests).toBe(1);
		});

		it("tracks provider stats", () => {
			collector.recordProvider("ollama", 100, true);
			collector.recordProvider("ollama", 200, true);
			collector.recordProvider("ollama", 500, false);

			const usage = collector.getUsage();
			const p = usage.providers["ollama"];
			expect(p.calls).toBe(3);
			expect(p.failures).toBe(1);
			expect(p.totalLatencyMs).toBe(800);
		});

		it("tracks connector stats", () => {
			collector.recordConnector("fs-docs", "sync");
			collector.recordConnector("fs-docs", "sync");
			collector.recordConnector("fs-docs", "document", 5);
			collector.recordConnector("fs-docs", "error");

			const usage = collector.getUsage();
			const c = usage.connectors["fs-docs"];
			expect(c.syncs).toBe(2);
			expect(c.documentsProcessed).toBe(5);
			expect(c.errors).toBe(1);
		});
	});

	describe("error ring buffer", () => {
		it("stores and retrieves errors", () => {
			collector.recordError({
				timestamp: "2026-01-01T00:00:00Z",
				stage: "extraction",
				code: "EXTRACTION_TIMEOUT",
				message: "timed out",
			});

			const errors = collector.getErrors();
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("EXTRACTION_TIMEOUT");
		});

		it("evicts oldest entries when capacity is reached", () => {
			for (let i = 0; i < 15; i++) {
				collector.recordError({
					timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
					stage: "extraction",
					code: "EXTRACTION_PARSE_FAIL",
					message: `error ${i}`,
				});
			}

			// Capacity is 10
			const errors = collector.getErrors({ limit: 100 });
			expect(errors).toHaveLength(10);
			// Oldest should be evicted (0-4 gone, 5-14 remain)
			expect(errors[0].message).toBe("error 5");
			expect(errors[9].message).toBe("error 14");
		});

		it("filters by stage", () => {
			collector.recordError({
				timestamp: "2026-01-01T00:00:00Z",
				stage: "extraction",
				code: "EXTRACTION_TIMEOUT",
				message: "a",
			});
			collector.recordError({
				timestamp: "2026-01-01T00:00:01Z",
				stage: "mutation",
				code: "MUTATION_CONFLICT",
				message: "b",
			});

			const extracted = collector.getErrors({ stage: "extraction" });
			expect(extracted).toHaveLength(1);
			expect(extracted[0].code).toBe("EXTRACTION_TIMEOUT");
		});

		it("filters by since timestamp", () => {
			collector.recordError({
				timestamp: "2026-01-01T00:00:00Z",
				stage: "extraction",
				code: "EXTRACTION_TIMEOUT",
				message: "old",
			});
			collector.recordError({
				timestamp: "2026-01-15T00:00:00Z",
				stage: "extraction",
				code: "EXTRACTION_PARSE_FAIL",
				message: "new",
			});

			const recent = collector.getErrors({ since: "2026-01-10T00:00:00Z" });
			expect(recent).toHaveLength(1);
			expect(recent[0].message).toBe("new");
		});

		it("produces error summary counts by code", () => {
			collector.recordError({
				timestamp: "2026-01-01T00:00:00Z",
				stage: "extraction",
				code: "EXTRACTION_TIMEOUT",
				message: "a",
			});
			collector.recordError({
				timestamp: "2026-01-01T00:00:01Z",
				stage: "extraction",
				code: "EXTRACTION_TIMEOUT",
				message: "b",
			});
			collector.recordError({
				timestamp: "2026-01-01T00:00:02Z",
				stage: "mutation",
				code: "MUTATION_CONFLICT",
				message: "c",
			});

			const summary = collector.getErrorSummary();
			expect(summary["EXTRACTION_TIMEOUT"]).toBe(2);
			expect(summary["MUTATION_CONFLICT"]).toBe(1);
		});
	});

	describe("latency histograms", () => {
		it("computes p50/p95/p99 from known values", () => {
			// Feed 100 values: 1, 2, 3, ..., 100
			for (let i = 1; i <= 100; i++) {
				collector.recordLatency("remember", i);
			}

			const latency = collector.getLatency();
			const r = latency.remember;
			expect(r.count).toBe(100);
			expect(r.p50).toBe(50);
			expect(r.p95).toBe(95);
			expect(r.p99).toBe(99);
			expect(r.mean).toBe(51); // (1+100)/2 = 50.5, rounded to 51
		});

		it("returns zeros when empty", () => {
			const latency = collector.getLatency();
			expect(latency.recall.count).toBe(0);
			expect(latency.recall.p50).toBe(0);
			expect(latency.recall.mean).toBe(0);
		});

		it("tracks four separate operations", () => {
			collector.recordLatency("remember", 100);
			collector.recordLatency("recall", 200);
			collector.recordLatency("mutate", 300);
			collector.recordLatency("jobs", 400);

			const latency = collector.getLatency();
			expect(latency.remember.count).toBe(1);
			expect(latency.recall.p50).toBe(200);
			expect(latency.mutate.p50).toBe(300);
			expect(latency.jobs.p50).toBe(400);
		});
	});

	describe("reset", () => {
		it("clears all state", () => {
			collector.recordRequest("GET", "/health", 200, 5);
			collector.recordProvider("ollama", 100, true);
			collector.recordError({
				timestamp: "2026-01-01T00:00:00Z",
				stage: "extraction",
				code: "EXTRACTION_TIMEOUT",
				message: "x",
			});
			collector.recordLatency("remember", 50);

			collector.reset();

			const usage = collector.getUsage();
			expect(Object.keys(usage.endpoints)).toHaveLength(0);
			expect(Object.keys(usage.providers)).toHaveLength(0);
			expect(collector.getErrors()).toHaveLength(0);
			expect(collector.getLatency().remember.count).toBe(0);
		});
	});
});

// ---------------------------------------------------------------------------
// Timeline Builder Tests
// ---------------------------------------------------------------------------

describe("buildTimeline", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as any);
	});

	function makeSources(
		logs: LogEntry[] = [],
		errors: ErrorEntry[] = [],
	): TimelineSources {
		return {
			db: db as unknown as ReadDb,
			getRecentLogs: () => logs,
			getRecentErrors: () => errors,
		};
	}

	it("returns empty timeline for unknown ID", () => {
		const tl = buildTimeline(makeSources(), "nonexistent-id");
		expect(tl.entityType).toBe("unknown");
		expect(tl.entityId).toBe("nonexistent-id");
		expect(tl.events).toHaveLength(0);
		expect(tl.generatedAt).toBeTruthy();
	});

	it("builds timeline from memory_history events", () => {
		db.run(
			"INSERT INTO memories (id, content, type, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["mem-1", "test content", "fact", "test", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
		);
		db.run(
			"INSERT INTO memory_history (id, memory_id, event, changed_by, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			["h-1", "mem-1", "ADD", "agent", "initial save", "2026-01-01T00:00:00Z"],
		);
		db.run(
			"INSERT INTO memory_history (id, memory_id, event, changed_by, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			["h-2", "mem-1", "UPDATE", "agent", "correction", "2026-01-01T00:01:00Z"],
		);

		const tl = buildTimeline(makeSources(), "mem-1");
		expect(tl.entityType).toBe("memory");

		const historyEvents = tl.events.filter((e) => e.source === "history");
		expect(historyEvents).toHaveLength(2);
		expect(historyEvents[0].event).toBe("ADD");
		expect(historyEvents[1].event).toBe("UPDATE");
	});

	it("includes job events in timeline", () => {
		db.run(
			"INSERT INTO memories (id, content, type, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["mem-2", "test", "fact", "test", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
		);
		db.run(
			"INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["j-1", "mem-2", "extract", "done", "2026-01-01T00:00:00Z", "2026-01-01T00:00:05Z", "2026-01-01T00:00:05Z"],
		);

		const tl = buildTimeline(makeSources(), "mem-2");
		const jobEvents = tl.events.filter((e) => e.source === "job");
		expect(jobEvents.length).toBeGreaterThanOrEqual(2);
		expect(jobEvents.some((e) => e.event.includes("created"))).toBe(true);
		expect(jobEvents.some((e) => e.event.includes("completed"))).toBe(true);
	});

	it("includes matching log entries", () => {
		db.run(
			"INSERT INTO memories (id, content, type, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["mem-3", "test", "fact", "test", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
		);

		const logs: LogEntry[] = [
			{
				timestamp: "2026-01-01T00:00:01Z",
				level: "info",
				category: "pipeline",
				message: "Processing mem-3",
				data: { memoryId: "mem-3" },
			},
			{
				timestamp: "2026-01-01T00:00:02Z",
				level: "info",
				category: "api",
				message: "Unrelated log",
			},
		];

		const tl = buildTimeline(makeSources(logs), "mem-3");
		const logEvents = tl.events.filter((e) => e.source === "log");
		expect(logEvents).toHaveLength(1);
		expect(logEvents[0].details.message).toBe("Processing mem-3");
	});

	it("includes matching error entries", () => {
		db.run(
			"INSERT INTO memories (id, content, type, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["mem-4", "test", "fact", "test", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
		);

		const errors: ErrorEntry[] = [
			{
				timestamp: "2026-01-01T00:00:03Z",
				stage: "extraction",
				code: "EXTRACTION_TIMEOUT",
				message: "timeout",
				memoryId: "mem-4",
			},
			{
				timestamp: "2026-01-01T00:00:04Z",
				stage: "embedding",
				code: "EMBEDDING_TIMEOUT",
				message: "unrelated",
				memoryId: "mem-99",
			},
		];

		const tl = buildTimeline(makeSources([], errors), "mem-4");
		const errorEvents = tl.events.filter((e) => e.source === "error");
		expect(errorEvents).toHaveLength(1);
		expect(errorEvents[0].event).toContain("EXTRACTION_TIMEOUT");
	});

	it("sorts events chronologically across sources", () => {
		db.run(
			"INSERT INTO memories (id, content, type, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["mem-5", "test", "fact", "test", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
		);
		db.run(
			"INSERT INTO memory_history (id, memory_id, event, changed_by, created_at) VALUES (?, ?, ?, ?, ?)",
			["h-5", "mem-5", "ADD", "agent", "2026-01-01T00:00:02Z"],
		);

		const logs: LogEntry[] = [
			{
				timestamp: "2026-01-01T00:00:01Z",
				level: "info",
				category: "pipeline",
				message: "Processing mem-5",
			},
		];

		const errors: ErrorEntry[] = [
			{
				timestamp: "2026-01-01T00:00:03Z",
				stage: "extraction",
				code: "EXTRACTION_PARSE_FAIL",
				message: "parse error for mem-5",
				memoryId: "mem-5",
			},
		];

		const tl = buildTimeline(makeSources(logs, errors), "mem-5");
		expect(tl.events.length).toBeGreaterThanOrEqual(3);
		for (let i = 1; i < tl.events.length; i++) {
			expect(tl.events[i].timestamp >= tl.events[i - 1].timestamp).toBe(true);
		}
	});
});
