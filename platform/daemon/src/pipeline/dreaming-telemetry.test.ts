/**
 * Regression test: dreaming pass token usage must reach the telemetry
 * pipeline (dreaming.pass) so dreaming economics show up in PostHog — the
 * local dreaming_passes table alone was invisible to analytics.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { type TelemetryCollector, createTelemetryCollector, setActiveTelemetry } from "../telemetry";
import { cleanupTestTempDir, createTestTempDir } from "../test-temp-dir";
import { recordDreamingPassTelemetry } from "./dreaming";

let dir = "";

const TELEMETRY_CONFIG = {
	posthogHost: "",
	posthogApiKey: "",
	flushIntervalMs: 60000,
	flushBatchSize: 50,
	retentionDays: 90,
	memorySearchQaEnabled: false,
} as const;

describe("dreaming telemetry", () => {
	beforeAll(() => {
		dir = createTestTempDir("signet-dream-telemetry-");
		closeDbAccessor();
		rmSync(join(dir, "memory"), { recursive: true, force: true });
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterAll(() => {
		setActiveTelemetry(undefined);
		closeDbAccessor();
		cleanupTestTempDir(dir);
	});

	it("emits dreaming.pass with provider-reported usage at pass completion", async () => {
		const collector = createTelemetryCollector(getDbAccessor(), TELEMETRY_CONFIG, "0.0.0-test");
		setActiveTelemetry(collector);

		recordDreamingPassTelemetry({
			mode: "agentic",
			outcome: "completed",
			outcomeCode: "completed",
			effects: {
				artifactsConsidered: 12,
				memoriesCreated: 2,
				memoriesUpdated: 1,
				memoriesSuperseded: 3,
				memoriesRetired: 1,
				claimsChanged: 4,
				relationshipsChanged: 2,
				provenanceLinksChanged: 5,
				toolCalls: 7,
				durationMs: 3210,
			},
			usage: {
				inputTokens: 384561,
				outputTokens: 18227,
				cacheReadTokens: 100000,
				cacheCreationTokens: 5000,
				totalTokens: 502788,
				totalCost: 0.14574042,
				accountingProvenance: "provider_reported",
			},
		});
		recordDreamingPassTelemetry({
			mode: "hygiene",
			outcome: "no-op",
			outcomeCode: "no_work",
			effects: {
				artifactsConsidered: 0,
				memoriesCreated: 0,
				memoriesUpdated: 0,
				memoriesSuperseded: 0,
				memoriesRetired: 0,
				claimsChanged: 0,
				relationshipsChanged: 0,
				provenanceLinksChanged: 0,
				toolCalls: 0,
				durationMs: 4,
			},
			usage: null,
		});
		await collector.flush();

		const passes = collector.query().filter((e) => e.event === "dreaming.pass");
		expect(passes).toHaveLength(2);
		const full = passes.find((e) => e.properties.mode === "agentic");
		expect(full?.properties.tokensInput).toBe(384561);
		expect(full?.properties.tokensOutput).toBe(18227);
		expect(full?.properties.tokensCacheRead).toBe(100000);
		expect(full?.properties.tokensCacheWrite).toBe(5000);
		expect(full?.properties.tokensTotal).toBe(502788);
		expect(full?.properties.cost).toBe(0.14574042);
		expect(full?.properties.accountingProvenance).toBe("provider_reported");
		expect(full?.properties.outcome).toBe("completed");
		expect(full?.properties.outcomeCode).toBe("completed");
		expect(full?.properties.artifactsConsidered).toBe(12);
		expect(full?.properties.memoriesCreated).toBe(2);
		expect(full?.properties.memoriesUpdated).toBe(1);
		expect(full?.properties.memoriesSuperseded).toBe(3);
		expect(full?.properties.memoriesRetired).toBe(1);
		expect(full?.properties.claimsChanged).toBe(4);
		expect(full?.properties.relationshipsChanged).toBe(2);
		expect(full?.properties.provenanceLinksChanged).toBe(5);
		expect(full?.properties.toolCalls).toBe(7);
		expect(full?.properties.durationMs).toBe(3210);
		const bare = passes.find((e) => e.properties.mode === "hygiene");
		expect(bare?.properties.tokensInput).toBeNull();
		expect(bare?.properties.cost).toBeNull();
		expect(bare?.properties.outcome).toBe("no-op");
		expect(bare?.properties.outcomeCode).toBe("no_work");
	});
});
