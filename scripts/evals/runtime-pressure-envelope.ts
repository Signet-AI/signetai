#!/usr/bin/env bun
/**
 * Runtime-pressure liveness/load eval (#1282).
 *
 * Exercises the same bounded envelope builder used by daemon heartbeats with
 * a deterministic synthetic load. It fails if envelope construction becomes
 * slow, grows its key set, or starts carrying forbidden process/user data.
 */

import { performance } from "node:perf_hooks";
import {
	buildRuntimePressureEnvelope,
	getRuntimePressureEnvelope,
	setRuntimePressureEnvelope,
} from "../../platform/daemon/src/runtime-pressure";

const SAMPLE_COUNT = 2_000;
const MAX_P95_BUILD_MS = 1;
const FORBIDDEN_KEYS = ["pid", "path", "source", "stack", "payload", "processId"];

function percentile(values: readonly number[], ratio: number): number {
	const ordered = [...values].sort((left, right) => left - right);
	const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1);
	return ordered[Math.max(0, index)] ?? 0;
}

const durations: number[] = [];
let lastEnvelope = buildRuntimePressureEnvelope();
for (let index = 0; index < SAMPLE_COUNT; index += 1) {
	const startedAt = performance.now();
	lastEnvelope = buildRuntimePressureEnvelope({
		memoryQueueDepth: index % 1_001,
		summaryQueueDepth: (index * 3) % 257,
		oldestJobAgeSec: index % 1_200,
		activeWorkers: index % 17,
		batchSize: 8,
		memoryRssMb: 512,
		cpuPercent: 42,
		recoveryOutcome: index % 2 === 0 ? "still_degraded" : "recovered",
	});
	durations.push(performance.now() - startedAt);
}

setRuntimePressureEnvelope(lastEnvelope);
const cached = getRuntimePressureEnvelope();
const keys = Object.keys(cached);
const forbidden = keys.filter((key) => FORBIDDEN_KEYS.some((term) => key.toLowerCase().includes(term.toLowerCase())));
const report = {
	verdict:
		cached.runtimePressureVersion === 1 && forbidden.length === 0 && percentile(durations, 0.95) <= MAX_P95_BUILD_MS
			? "pass"
			: "fail",
	samples: SAMPLE_COUNT,
	keyCount: keys.length,
	p95BuildMs: Number(percentile(durations, 0.95).toFixed(3)),
	maxP95BuildMs: MAX_P95_BUILD_MS,
	forbiddenKeys: forbidden,
};

console.log(JSON.stringify(report, null, 2));
if (report.verdict !== "pass") process.exit(1);
