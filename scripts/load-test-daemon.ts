#!/usr/bin/env bun
/**
 * Daemon concurrency load test (issue #1148).
 *
 * Reproduces the load profile that preceded the silent daemon deaths:
 * automation bots (Minecraft chat bridge, camera/motion sentinel) hammering
 * the daemon API — session-start hooks, secrets listing, session capture,
 * recall — while the Obsidian watcher indexes in the background. The invariant
 * under test: concurrent session-start + secrets + status traffic must NOT be
 * able to take the daemon down, and if it does, the daemon must leave evidence
 * (lifecycle record, log tail) instead of vanishing silently.
 *
 * Usage:
 *   bun scripts/load-test-daemon.ts [--duration 20] [--concurrency 8]
 *       [--port 3850] [--writes] [--token <bearer>]
 *
 * Against the live daemon (default) or a scratch one:
 *   SIGNET_PATH=/tmp/signet-loadtest bun platform/daemon/src/daemon.ts &  # scratch daemon
 *   bun scripts/load-test-daemon.ts --port 3850
 *
 * Exit code 0 = daemon stayed healthy through the run (p95 < 2s), 1 = failure.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Route {
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly weight: number;
	readonly body?: () => Record<string, unknown>;
}

const SESSION_KEY_PREFIX = `loadtest-${process.pid}-`;
let sessionCounter = 0;
// session-end must reference a session that session-start actually created,
// otherwise every end is a 400 and the real path never runs.
const startedSessionKeys: string[] = [];

function nextSessionKey(): string {
	sessionCounter += 1;
	return `${SESSION_KEY_PREFIX}${sessionCounter}`;
}

const READ_ROUTES: readonly Route[] = [
	{ method: "GET", path: "/api/status", weight: 4 },
	{ method: "GET", path: "/api/secrets", weight: 1 },
	{ method: "GET", path: "/api/sessions", weight: 1 },
	{
		method: "POST",
		path: "/api/hooks/session-start",
		weight: 3,
		body: () => {
			const sessionKey = nextSessionKey();
			startedSessionKeys.push(sessionKey);
			return { harness: "loadtest", sessionKey, agentId: "default", project: "/tmp/signet-loadtest" };
		},
	},
	{
		method: "POST",
		path: "/api/hooks/session-end",
		weight: 1,
		body: () => ({
			harness: "loadtest",
			sessionKey: startedSessionKeys.shift() ?? nextSessionKey(),
			agentId: "default",
		}),
	},
	{
		method: "POST",
		path: "/api/hooks/recall",
		weight: 1,
		body: () => ({ query: "daemon load test concurrency", limit: 3 }),
	},
];

const WRITE_ROUTES: readonly Route[] = [
	{
		method: "POST",
		path: "/api/memory/remember",
		weight: 1,
		body: () => ({ content: `load test memory ${Date.now()}`, agentId: "default" }),
	},
];

interface ParsedArgs {
	readonly durationSec: number;
	readonly concurrency: number;
	readonly port: number;
	readonly writes: boolean;
	readonly token: string | null;
	readonly agentsDir: string;
}

function parseArgs(raw: string[]): ParsedArgs {
	let durationSec = 20;
	let concurrency = 8;
	let port = 3850;
	let writes = false;
	let token: string | null = process.env.SIGNET_API_KEY?.trim() || null;
	let agentsDir = process.env.SIGNET_PATH?.trim() || join(homedir(), ".agents");

	for (let i = 0; i < raw.length; i += 1) {
		const arg = raw[i];
		const next = (): string => {
			i += 1;
			return raw[i];
		};
		if (arg === "--duration") durationSec = Number.parseInt(next(), 10);
		else if (arg === "--concurrency") concurrency = Number.parseInt(next(), 10);
		else if (arg === "--port") port = Number.parseInt(next(), 10);
		else if (arg === "--token") token = next() || null;
		else if (arg === "--writes") writes = true;
		else if (arg === "--agents-dir") agentsDir = next();
		else if (arg === "--help") {
			console.log(
				"Usage: bun scripts/load-test-daemon.ts [--duration 20] [--concurrency 8] [--port 3850] [--writes] [--token <bearer>]",
			);
			process.exit(0);
		}
	}

	return { durationSec, concurrency, port, writes, token, agentsDir };
}

function buildRouteTable(writes: boolean): readonly Route[] {
	return writes ? [...READ_ROUTES, ...WRITE_ROUTES] : READ_ROUTES;
}

function weightedRoute(routes: readonly Route[]): Route {
	const total = routes.reduce((sum, route) => sum + route.weight, 0);
	let roll = Math.random() * total;
	for (const route of routes) {
		roll -= route.weight;
		if (roll <= 0) return route;
	}
	return routes[routes.length - 1];
}

interface RunStats {
	requests: number;
	failures: number;
	latenciesMs: number[];
	statusCounts: Map<number, number>;
}

interface DeathEvent {
	readonly detectedAt: string;
	readonly recoveredAt: string | null;
	readonly downForMs: number;
}

function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, idx)];
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const baseUrl = `http://127.0.0.1:${args.port}`;
	const routes = buildRouteTable(args.writes);

	const headers: Record<string, string> = { "content-type": "application/json" };
	if (args.token) headers.authorization = `Bearer ${args.token}`;

	// Pre-flight: the daemon must be reachable before we start piling on load.
	const preflight = await fetch(`${baseUrl}/api/status`, { headers, signal: AbortSignal.timeout(5_000) });
	if (!preflight.ok) {
		console.error(`Daemon not reachable at ${baseUrl} (HTTP ${preflight.status}). Start it first.`);
		process.exit(1);
	}

	const stats: RunStats = { requests: 0, failures: 0, latenciesMs: [], statusCounts: new Map() };
	const deaths: DeathEvent[] = [];
	let daemonDownSince: number | null = null;
	let lastHealthOk = true;
	let finished = false;

	// Watchdog: independent of the workers, probes health every 250ms and
	// records any window where the daemon stopped answering.
	async function watchdog(): Promise<void> {
		while (!finished) {
			try {
				const res = await fetch(`${baseUrl}/api/status`, { headers, signal: AbortSignal.timeout(2_000) });
				if (res.ok) {
					if (daemonDownSince !== null) {
						const downForMs = Date.now() - daemonDownSince;
						deaths.push({
							detectedAt: new Date(daemonDownSince).toISOString(),
							recoveredAt: new Date().toISOString(),
							downForMs,
						});
						daemonDownSince = null;
					}
					lastHealthOk = true;
				} else if (daemonDownSince === null) {
					daemonDownSince = Date.now();
					lastHealthOk = false;
				}
			} catch {
				if (daemonDownSince === null) {
					daemonDownSince = Date.now();
					lastHealthOk = false;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	// Worker: fire one weighted request, record latency/status.
	async function worker(): Promise<void> {
		while (!finished) {
			const route = weightedRoute(routes);
			const started = performance.now();
			try {
				const res = await fetch(`${baseUrl}${route.path}`, {
					method: route.method,
					headers,
					...(route.body ? { body: JSON.stringify(route.body()) } : {}),
					signal: AbortSignal.timeout(10_000),
				});
				const elapsedMs = performance.now() - started;
				stats.latenciesMs.push(elapsedMs);
				stats.statusCounts.set(res.status, (stats.statusCounts.get(res.status) ?? 0) + 1);
			} catch {
				stats.failures += 1;
			}
			stats.requests += 1;
		}
	}

	const watchdogPromise = watchdog();
	const workers = Array.from({ length: args.concurrency }, () => worker());
	await new Promise((resolve) => setTimeout(resolve, args.durationSec * 1000));
	finished = true;
	await Promise.all([...workers, watchdogPromise]);

	// Final health check: the daemon must be answering after the run.
	let finalHealthy = false;
	try {
		const res = await fetch(`${baseUrl}/api/status`, { headers, signal: AbortSignal.timeout(5_000) });
		finalHealthy = res.ok;
	} catch {
		finalHealthy = false;
	}

	// An unrecovered death (daemon stayed down until the end of the run) must
	// still surface as a death event.
	if (daemonDownSince !== null) {
		deaths.push({
			detectedAt: new Date(daemonDownSince).toISOString(),
			recoveredAt: null,
			downForMs: Date.now() - daemonDownSince,
		});
	}

	// Post-mortem evidence: the lifecycle record, when present.
	let lifecycle: unknown = null;
	try {
		const raw = readFileSync(join(args.agentsDir, ".daemon", "lifecycle.json"), "utf-8");
		lifecycle = JSON.parse(raw);
	} catch {
		lifecycle = null;
	}

	const sorted = [...stats.latenciesMs].sort((a, b) => a - b);
	const report = {
		verdict: finalHealthy && deaths.length === 0 ? "pass" : "fail",
		baseUrl,
		durationSec: args.durationSec,
		concurrency: args.concurrency,
		requests: stats.requests,
		requestFailures: stats.failures,
		statusCounts: Object.fromEntries(stats.statusCounts),
		latencyMs: {
			p50: Math.round(percentile(sorted, 50)),
			p95: Math.round(percentile(sorted, 95)),
			p99: Math.round(percentile(sorted, 99)),
		},
		deaths: deaths.map((d) => ({ ...d })),
		finalHealthy,
		lifecycle,
	};
	console.log(JSON.stringify(report, null, 2));

	if (!finalHealthy || deaths.length > 0) {
		console.error(
			"\nFAIL: the daemon did not survive the load (or died without recording it). Check the lifecycle record above, the daemon log tail, and journalctl --user -u 'signet-daemon-*'.",
		);
		process.exit(1);
	}
	if (stats.failures > stats.requests * 0.05) {
		console.error(
			`\nFAIL: ${stats.failures} request failures out of ${stats.requests} (${((stats.failures / stats.requests) * 100).toFixed(1)}%).`,
		);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("load test crashed:", err);
	process.exit(1);
});
