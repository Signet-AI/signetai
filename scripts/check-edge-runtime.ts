#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const RSS_LIMIT_KIB = 100 * 1024;
const EMBEDDING_LIMIT_MS = 5_000;
const EDGE_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

function argument(name: string): string | null {
	const index = process.argv.indexOf(name);
	return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function readLinuxRssKib(pid: number): number {
	const statusPath = `/proc/${pid}/status`;
	if (!existsSync(statusPath)) throw new Error(`Linux process status not found: ${statusPath}`);
	const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(statusPath, "utf8"));
	if (!match) throw new Error(`VmRSS missing from ${statusPath}`);
	return Number(match[1]);
}

const workspace = resolve(argument("--workspace") ?? process.env.SIGNET_PATH ?? join(homedir(), ".agents"));
const pidPath = join(workspace, ".daemon", "pid");
const pid = Number(readFileSync(pidPath, "utf8").trim());
if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid daemon PID in ${pidPath}`);

const idleRssKib = readLinuxRssKib(pid);
const result: Record<string, unknown> = {
	architecture: process.arch,
	idleRssKib,
	idleRssPass: idleRssKib < RSS_LIMIT_KIB,
	pid,
	platform: process.platform,
	rssLimitKib: RSS_LIMIT_KIB,
	workspace,
};

if (process.argv.includes("--with-embedding")) {
	const port = Number(argument("--port") ?? process.env.SIGNET_PORT ?? "3850");
	const statusResponse = await fetch(`http://127.0.0.1:${port}/api/embeddings/status`, {
		signal: AbortSignal.timeout(90_000),
	});
	const status = (await statusResponse.json()) as Record<string, unknown>;
	if (!statusResponse.ok || status.available !== true) {
		throw new Error(`Native embedding warm-up failed: ${JSON.stringify(status)}`);
	}

	const startedAt = performance.now();
	const response = await fetch(`http://127.0.0.1:${port}/api/memory/recall`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ query: "edge runtime latency probe", limit: 1 }),
		signal: AbortSignal.timeout(90_000),
	});
	const requestElapsedMs = Math.round(performance.now() - startedAt);
	const body = (await response.json()) as Record<string, unknown>;
	const meta = body.meta as Record<string, unknown> | undefined;
	const timings = meta?.timings as Record<string, unknown> | undefined;
	const stages = Array.isArray(timings?.stages) ? timings.stages : [];
	const embeddingStage = stages.find(
		(stage): stage is Record<string, unknown> =>
			typeof stage === "object" && stage !== null && (stage as Record<string, unknown>).name === "query_embedding_wait",
	);
	const elapsedMs = typeof embeddingStage?.durationMs === "number" ? embeddingStage.durationMs : null;
	const modelPass = status.model === EDGE_EMBEDDING_MODEL;
	const latencyPass = elapsedMs !== null && elapsedMs < EMBEDDING_LIMIT_MS;
	result.embedding = {
		available: status.available === true,
		elapsedMs,
		latencyPass,
		limitMs: EMBEDDING_LIMIT_MS,
		model: status.model,
		modelPass,
		requestElapsedMs,
	};
	if (!response.ok || !modelPass || !latencyPass) process.exitCode = 1;
}

console.log(JSON.stringify(result, null, 2));
if (idleRssKib >= RSS_LIMIT_KIB) process.exitCode = 1;
