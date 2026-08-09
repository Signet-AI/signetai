#!/usr/bin/env bun
/**
 * Stale-session sweep liveness eval (#1254).
 *
 * This runs the production daemon hook modules against an isolated temporary
 * SIGNET_PATH. It seeds 50 live-retained stale sessions, runs the same sweep
 * used by the daemon, measures event-loop lag with a 10ms probe, and fails if
 * any session is classified as session.turn or the liveness budget is missed.
 *
 * Usage:
 *   bun scripts/load-test-stale-session-sweep.ts [--count 50] [--max-lag-ms 500]
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ParsedArgs {
	readonly count: number;
	readonly maxLagMs: number;
}

function parseArgs(raw: readonly string[]): ParsedArgs {
	let count = 50;
	let maxLagMs = 500;
	for (let index = 0; index < raw.length; index += 1) {
		const arg = raw[index];
		if (arg === "--count") {
			count = Number.parseInt(raw[index + 1] ?? "", 10);
			index += 1;
		}
		if (arg === "--max-lag-ms") {
			maxLagMs = Number.parseInt(raw[index + 1] ?? "", 10);
			index += 1;
		}
		if (arg === "--help") {
			console.log("Usage: bun scripts/load-test-stale-session-sweep.ts [--count 50] [--max-lag-ms 500]");
			process.exit(0);
		}
	}
	if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("--count must be an integer from 1 to 50");
	if (!Number.isFinite(maxLagMs) || maxLagMs < 1) throw new Error("--max-lag-ms must be positive");
	return { count, maxLagMs };
}

function percentile(sorted: readonly number[], percentileValue: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
	return sorted[Math.max(0, index)] ?? 0;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const agentsDir = mkdtempSync(join(tmpdir(), "signet-stale-sweep-eval-"));
	process.env.SIGNET_PATH = agentsDir;
	process.env.SIGNET_AGENT_ID = "default";
	writeFileSync(join(agentsDir, "AGENTS.md"), "Stale-session sweep liveness eval.\n");

	const { closeDbAccessor, getDbAccessor, initDbAccessor } = await import("../platform/daemon/src/db-accessor");
	const hooks = await import("../platform/daemon/src/hooks");
	const { createTelemetryCollector, setActiveTelemetry } = await import("../platform/daemon/src/telemetry");
	const { upsertSessionTranscript } = await import("../platform/daemon/src/session-transcripts");

	const dbPath = join(agentsDir, "memory", "memories.db");
	const telemetryConfig = {
		posthogHost: "",
		posthogApiKey: "",
		flushIntervalMs: 60_000,
		flushBatchSize: 100,
		retentionDays: 90,
		memorySearchQaEnabled: false,
	} as const;

	try {
		initDbAccessor(dbPath, { agentsDir });
		const now = Date.now();
		const staleAt = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
		const transcript = `User: ${"s".repeat(300)}\nAssistant: ${"t".repeat(300)}`;
		for (let index = 0; index < args.count; index += 1) {
			upsertSessionTranscript(`stale-sweep-eval-${process.pid}-${index}`, transcript, "eval", null, "default", staleAt);
		}

		const collector = createTelemetryCollector(getDbAccessor(), telemetryConfig, "eval");
		setActiveTelemetry(collector);
		const lagSamples: number[] = [];
		const probeIntervalMs = 10;
		let expectedAt = performance.now() + probeIntervalMs;
		const probe = setInterval(() => {
			const nowAt = performance.now();
			lagSamples.push(Math.max(0, nowAt - expectedAt));
			expectedAt = nowAt + probeIntervalMs;
		}, probeIntervalMs);
		try {
			const startedAt = performance.now();
			const result = await hooks.sweepStaleSessions({
				staleOlderThanMs: 24 * 60 * 60 * 1000,
				limit: args.count,
			});
			const elapsedMs = performance.now() - startedAt;
			await collector.flush();
			clearInterval(probe);

			const ends = collector.query().filter((event) => event.event === "session.end");
			const turns = collector.query().filter((event) => event.event === "session.turn");
			const sortedLag = [...lagSamples].sort((a, b) => a - b);
			const maxLagMs = Math.round(Math.max(...lagSamples, 0));
			const p95LagMs = Math.round(percentile(sortedLag, 95));
			const report = {
				verdict:
					result.closed === args.count && ends.length === args.count && turns.length === 0 && maxLagMs <= args.maxLagMs
						? "pass"
						: "fail",
				count: args.count,
				closed: result.closed,
				totalMatching: result.totalMatching,
				sessionEndEvents: ends.length,
				sessionTurnEvents: turns.length,
				elapsedMs: Math.round(elapsedMs),
				maxLagMs,
				p95LagMs,
				maxAllowedLagMs: args.maxLagMs,
			};
			console.log(JSON.stringify(report, null, 2));
			if (report.verdict !== "pass") process.exitCode = 1;
		} finally {
			clearInterval(probe);
			setActiveTelemetry(undefined);
			await collector.stop();
		}
	} finally {
		closeDbAccessor();
		if (existsSync(agentsDir)) rmSync(agentsDir, { recursive: true, force: true });
	}
}

main()
	.then(() => {
		process.exit(process.exitCode ?? 0);
	})
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
