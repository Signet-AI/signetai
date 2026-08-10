import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type SignetSourceEntry, addObsidianSource } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	recordFirstSourceRecall,
	recordSourceConnected,
	recordSourceConnectionFailure,
	recordSourceFreshness,
	recordSourceIndexOperation,
	sourceCountBucket,
	sourceDurationBucket,
	sourceFailureClass,
	sourceLagBucket,
	sourceSizeBucket,
} from "./source-lifecycle-telemetry";
import { createTelemetryCollector, setActiveTelemetry } from "./telemetry";
import { cleanupTestTempDir, createTestTempDir } from "./test-temp-dir";

const TELEMETRY_CONFIG = {
	posthogHost: "",
	posthogApiKey: "",
	flushIntervalMs: 60_000,
	flushBatchSize: 50,
	retentionDays: 90,
	memorySearchQaEnabled: false,
} as const;

describe("source lifecycle telemetry", () => {
	let dir = "";
	let collector: ReturnType<typeof createTelemetryCollector>;
	let source: SignetSourceEntry;

	beforeEach(() => {
		dir = createTestTempDir("signet-source-lifecycle-");
		mkdirSync(join(dir, "memory"), { recursive: true });
		const vault = join(dir, "private-vault");
		mkdirSync(vault, { recursive: true });
		const added = addObsidianSource({ root: vault, name: "Private vault" }, dir);
		if (!added.ok) throw new Error(added.error);
		source = added.source;
		initDbAccessor(join(dir, "memory", "memories.db"));
		collector = createTelemetryCollector(getDbAccessor(), TELEMETRY_CONFIG, "0.0.0-test");
		collector.start();
		// The production collector is the active process-wide sink used by the
		// source telemetry boundary.
		setActiveTelemetry(collector);
	});

	afterEach(async () => {
		setActiveTelemetry(undefined);
		await collector?.stop();
		closeDbAccessor();
		cleanupTestTempDir(dir);
	});

	it("uses fixed buckets and bounded failure classes", () => {
		expect(sourceCountBucket(0)).toBe("0");
		expect(sourceCountBucket(11)).toBe("11_100");
		expect(sourceCountBucket(Number.MAX_SAFE_INTEGER)).toBe("10k_plus");
		expect(sourceSizeBucket(2_000_000)).toBe("1_10mb");
		expect(sourceDurationBucket(45_000)).toBe("10_60s");
		expect(sourceLagBucket(2 * 60 * 60_000)).toBe("1_6h");
		expect(sourceFailureClass(new Error("401 token rejected"))).toBe("authentication");
		expect(sourceFailureClass(new Error("429 rate limit"))).toBe("rate_limited");
		expect(sourceFailureClass(new Error("/Users/private/vault/file.md"))).toBe("filesystem");
	});

	it("records a privacy-safe connect, readiness, and first-recall funnel", async () => {
		recordSourceConnected(source, "default");
		recordSourceConnected(source, "default");
		recordSourceIndexOperation({
			source,
			agentId: "default",
			discovered: 120,
			accepted: 100,
			skipped: 15,
			failed: 5,
			durationMs: 45_000,
			outcome: "success",
			searchable: true,
			sourceBytes: 2_000_000,
		});
		recordFirstSourceRecall("default", [
			{ source: "source_obsidian", source_id: source.id },
			{ source: "source_obsidian", source_id: source.id },
		]);
		recordFirstSourceRecall("default", [{ source: "source_obsidian", source_id: source.id }]);
		await collector.flush();
		const events = collector.query({ event: "source.lifecycle", limit: 100 });
		expect(events.filter((event) => event.properties.phase === "connect")).toHaveLength(1);
		expect(events.some((event) => event.properties.readiness === "indexed")).toBe(true);
		expect(events.some((event) => event.properties.readiness === "searchable")).toBe(true);
		expect(events.filter((event) => event.properties.phase === "first_recall")).toHaveLength(1);
		expect(events.some((event) => event.properties.sourceSizeBucket === "1_10mb")).toBe(true);

		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain("Private vault");
		expect(serialized).not.toContain("private-vault");
		expect(serialized).not.toContain(source.id);
	});

	it("reports failed configuration with only a bounded class", async () => {
		recordSourceConnectionFailure("github", new Error("token rejected by provider"));
		await collector.flush();
		const event = collector
			.query({ event: "source.lifecycle", limit: 10 })
			.find((row) => row.properties.phase === "connect");
		expect(event?.properties.outcome).toBe("failed");
		expect(event?.properties.failureClass).toBe("authentication");
		expect(JSON.stringify(event)).not.toContain("token rejected");
	});

	it("samples recurring freshness without waiting for a sync to end", async () => {
		const recurring = {
			...source,
			id: "discord:recurring-test",
			kind: "discord" as const,
			providerSettings: { syncMode: "gateway-tail" },
		};
		const now = Date.parse("2026-08-09T22:00:00.000Z");
		recordSourceFreshness(recurring, "default", undefined, now);
		recordSourceFreshness(recurring, "default", "2026-08-09T21:59:00.000Z", now);
		await collector.flush();
		const events = collector.query({ event: "source.lifecycle", limit: 20 });
		expect(
			new Set(
				events.filter((event) => event.properties.phase === "freshness").map((event) => event.properties.freshness),
			),
		).toEqual(new Set(["healthy", "unknown"]));
	});
});
