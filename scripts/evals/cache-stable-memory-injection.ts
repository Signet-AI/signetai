#!/usr/bin/env bun

import { performance } from "node:perf_hooks";
import {
	StreamingMemoryContextScrubber,
	composeApiUserContent,
	stripInternalMemoryContext,
} from "../../platform/core/src/memory-context";

const SAMPLE_COUNT = 1_000;
const userMessage = "Continue the deployment checklist for the Signet daemon.";
const dynamicContext = "The last deployment used the canary path; preserve the rollback checkpoint.";
const providerContent = composeApiUserContent(userMessage, dynamicContext);
const replay = composeApiUserContent(userMessage, dynamicContext);

if (providerContent !== replay) {
	throw new Error("cache-stable replay changed provider-bound bytes for identical state");
}

const canonical = stripInternalMemoryContext(`User: ${providerContent}\nAssistant: acknowledged`);
if (canonical.includes("signet-memory") || canonical.includes("memory-context")) {
	throw new Error("canonical transcript retained an internal memory delimiter");
}

const scrubber = new StreamingMemoryContextScrubber();
const visible = [
	scrubber.feed('visible before <signet-memory source="api">hidden'),
	scrubber.feed(" context</signet-mem"),
	scrubber.feed("ory> visible after"),
	scrubber.flush(),
].join("");
if (visible !== "visible before  visible after") {
	throw new Error(`stream scrubber leaked or altered visible output: ${JSON.stringify(visible)}`);
}

const latencies: number[] = [];
for (let index = 0; index < SAMPLE_COUNT; index += 1) {
	const startedAt = performance.now();
	const value = composeApiUserContent(userMessage, dynamicContext);
	if (value !== providerContent) throw new Error(`non-deterministic composition at sample ${index}`);
	latencies.push(performance.now() - startedAt);
}

function percentile(values: readonly number[], ratio: number): number {
	const ordered = [...values].sort((left, right) => left - right);
	const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1));
	return ordered[index] ?? 0;
}

console.log(
	JSON.stringify(
		{
			samples: SAMPLE_COUNT,
			providerChars: providerContent.length,
			canonicalChars: canonical.length,
			p50Ms: Number(percentile(latencies, 0.5).toFixed(4)),
			p95Ms: Number(percentile(latencies, 0.95).toFixed(4)),
		},
		null,
		2,
	),
);
