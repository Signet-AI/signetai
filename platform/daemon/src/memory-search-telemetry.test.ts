import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import type { RecallResponse } from "./memory-search";
import { listMemorySearchTelemetry, recordMemorySearchTelemetry } from "./memory-search-telemetry";
import { resolveMemorySearchTelemetryProject } from "./memory-search-telemetry-project";

describe("memory search telemetry", () => {
	let dir = "";
	let prevSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-memory-search-telemetry-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    telemetry:
      memorySearchQaEnabled: true
`,
		);
		prevSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (prevSignetPath === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = prevSignetPath;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	function response(): RecallResponse {
		return {
			query: "what did we decide about recall qa",
			method: "hybrid",
			results: [
				{
					id: "mem-1",
					content: "Recall QA should preserve enough context for manual review.",
					content_length: 61,
					truncated: false,
					score: 0.91,
					source: "memory",
					type: "decision",
					tags: "signet,recall",
					pinned: false,
					importance: 0.8,
					who: "ant",
					project: "/repo",
					created_at: "2026-05-06T00:00:00.000Z",
				},
			],
			meta: {
				totalReturned: 1,
				hasSupplementary: false,
				noHits: false,
				timings: {
					totalMs: 12.34,
					stages: [{ name: "memory_fts", durationMs: 1.2 }],
				},
			},
		};
	}

	it("stores query text, filters, timings, and result snapshots for QA", () => {
		recordMemorySearchTelemetry(getDbAccessor(), {
			route: "POST /api/memory/recall",
			agentId: "ant",
			sessionKey: "sess-1",
			project: "/repo",
			params: {
				query: "what did we decide about recall qa",
				keywordQuery: "recall qa",
				limit: 5,
				agentId: "ant",
				readPolicy: "isolated",
				project: "/repo",
			},
			response: response(),
			retentionDays: 90,
		});

		const items = listMemorySearchTelemetry(getDbAccessor(), { agentId: "ant" });

		expect(items).toHaveLength(1);
		expect(items[0]?.query).toBe("what did we decide about recall qa");
		expect(items[0]?.keyword_query).toBe("recall qa");
		expect(items[0]?.filters.limit).toBe(5);
		expect(items[0]?.duration_ms).toBe(12.34);
		expect(items[0]?.results[0]?.rank).toBe(1);
		expect(items[0]?.results[0]?.content).toContain("manual review");
	});

	it("resolves telemetry project from effective recall params", () => {
		expect(resolveMemorySearchTelemetryProject({ project: "/repo" })).toBe("/repo");
		expect(resolveMemorySearchTelemetryProject({ project: "  /repo  " })).toBe("/repo");
		expect(resolveMemorySearchTelemetryProject({ project: "" })).toBeNull();
		expect(resolveMemorySearchTelemetryProject({})).toBeNull();
	});

	it("filters no-hit rows", () => {
		const empty: RecallResponse = {
			query: "nothing here",
			method: "hybrid",
			results: [],
			meta: {
				totalReturned: 0,
				hasSupplementary: false,
				noHits: true,
				timings: { totalMs: 3, stages: [] },
			},
		};

		recordMemorySearchTelemetry(getDbAccessor(), {
			route: "GET /api/memory/search",
			agentId: "ant",
			sessionKey: null,
			project: null,
			params: { query: "nothing here", agentId: "ant" },
			response: empty,
			retentionDays: 90,
		});

		expect(listMemorySearchTelemetry(getDbAccessor(), { noHits: true })).toHaveLength(1);
		expect(listMemorySearchTelemetry(getDbAccessor(), { noHits: false })).toHaveLength(0);
	});
});
