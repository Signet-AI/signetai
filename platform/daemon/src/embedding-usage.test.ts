/**
 * Regression test for issue #1181: pipeline.embedding was declared in
 * TELEMETRY_EVENTS but never emitted, so embedding token spend was
 * invisible in PostHog and the telemetry stats endpoint. The event must
 * fire at the embedding fetch boundary (recordEmbeddingUsage) with
 * tokens/provider/sourceKind.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { recordEmbeddingUsage } from "./embedding-usage";
import { type TelemetryCollector, createTelemetryCollector, setActiveTelemetry } from "./telemetry";
import { cleanupTestTempDir, createTestTempDir } from "./test-temp-dir";

let dir = "";
let collector: TelemetryCollector;

const TELEMETRY_CONFIG = {
	posthogHost: "", // nothing sends; events stay local
	posthogApiKey: "",
	flushIntervalMs: 60000,
	flushBatchSize: 50,
	retentionDays: 90,
	memorySearchQaEnabled: false,
} as const;

function resetWorkspace(): void {
	closeDbAccessor();
	rmSync(join(dir, "memory"), { recursive: true, force: true });
	mkdirSync(join(dir, "memory"), { recursive: true });
	initDbAccessor(join(dir, "memory", "memories.db"));
}

describe("embedding telemetry (issue #1181)", () => {
	beforeAll(() => {
		dir = createTestTempDir("signet-embed-telemetry-");
		resetWorkspace();
	});

	afterAll(() => {
		setActiveTelemetry(undefined);
		closeDbAccessor();
		cleanupTestTempDir(dir);
	});

	it("emits pipeline.embedding at the fetch boundary with tokens, provider, sourceKind", async () => {
		collector = createTelemetryCollector(getDbAccessor(), TELEMETRY_CONFIG, "0.0.0-test");
		setActiveTelemetry(collector);

		recordEmbeddingUsage({ provider: "native", tokens: 128, source: "memory-capture" });
		recordEmbeddingUsage({ provider: "ollama", tokens: 42, source: "dreaming" });
		await collector.flush();

		const embeddings = (await collector.query()).filter((e) => e.event === "pipeline.embedding");
		expect(embeddings).toHaveLength(2);
		const first = embeddings.find((e) => e.properties.provider === "native");
		expect(first?.properties.tokens).toBe(128);
		expect(first?.properties.cost).toBe(0);
		expect(first?.properties.sourceKind).toBe("memory-capture");
		const second = embeddings.find((e) => e.properties.provider === "ollama");
		expect(second?.properties.tokens).toBe(42);
		expect(second?.properties.cost).toBe(0);
		expect(second?.properties.sourceKind).toBe("dreaming");

		// The DB accounting still lands too (shared boundary, #1154).
		const row = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT SUM(tokens) AS tokens FROM embedding_usage").get() as { tokens: number },
		);
		expect(row.tokens).toBe(170);
	});
});
