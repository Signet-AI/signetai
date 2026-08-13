import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, termination } from "./repro-1059-eval";

const daemonScript = join(import.meta.dir, "platform/daemon/src/daemon.ts");
const agentsDir = mkdtempSync(join(tmpdir(), "signet-1059-"));
mkdirSync(join(agentsDir, ".daemon", "logs"), { recursive: true });
mkdirSync(join(agentsDir, "memory"), { recursive: true });
writeFileSync(
	join(agentsDir, "agent.yaml"),
	[
		"embedding:",
		"  provider: none",
		"memory:",
		"  pipelineV2:",
		"    enabled: true",
		"    hints:",
		"      enabled: false",
		"    reflections:",
		"      enabled: false",
		"    embeddingTracker:",
		"      enabled: false",
		"    modelRegistry:",
		"      enabled: false",
		"    procedural:",
		"      enabled: false",
		"    feedback:",
		"      enabled: false",
		"    significance:",
		"      enabled: false",
		"    telemetryEnabled: false",
		"",
	].join("\n"),
);

let downstream: Server | null = null;
let daemon: ChildProcess | null = null;
const stdout: string[] = [];
const stderr: string[] = [];

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") return reject(new Error("no server address"));
			resolve(address.port);
		});
	});
}

async function request(
	origin: string,
	path: string,
	init?: RequestInit,
): Promise<{ status: number; body: string; ms: number }> {
	const started = performance.now();
	const response = await fetch(`${origin}${path}`, init);
	return { status: response.status, body: await response.text(), ms: performance.now() - started };
}

async function waitForLive(origin: string, child: ChildProcess): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const state = termination(child);
		if (state.exited) {
			throw new Error(
				`daemon exited during startup: code=${state.exitCode ?? "null"} signal=${state.signal ?? "null"}`,
			);
		}
		try {
			const result = await request(origin, "/health/live", { signal: AbortSignal.timeout(1_000) });
			if (result.status === 200) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error("daemon did not become live within 60s");
}

function counts(rows: Array<{ status?: string }>): Record<string, number> {
	const result: Record<string, number> = {};
	for (const row of rows) {
		const status = row.status ?? "unknown";
		result[status] = (result[status] ?? 0) + 1;
	}
	return result;
}

function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
}

try {
	downstream = createServer((req, res) => {
		if (req.url?.startsWith("/slow/")) {
			setTimeout(() => {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end(`slow downstream payload ${req.url}\n${"x".repeat(1800)}`);
			}, 1200);
			return;
		}
		res.writeHead(404);
		res.end("not found");
	});
	const downstreamPort = await listen(downstream);
	const portServer = createServer();
	const daemonPort = await listen(portServer);
	await new Promise<void>((resolve) => portServer.close(() => resolve()));
	const origin = `http://127.0.0.1:${daemonPort}`;
	const downstreamOrigin = `http://127.0.0.1:${downstreamPort}`;

	daemon = spawn(process.execPath, [daemonScript], {
		cwd: import.meta.dir,
		env: {
			...process.env,
			SIGNET_PATH: agentsDir,
			SIGNET_PORT: String(daemonPort),
			SIGNET_HOST: "127.0.0.1",
			SIGNET_BIND: "127.0.0.1",
			SIGNET_TELEMETRY_OPTOUT: "1",
			SIGNET_DAEMON_ENTRYPOINT: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	daemon.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
	daemon.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
	await waitForLive(origin, daemon);

	const posted: Array<{ id: string; kind: string }> = [];
	const postErrors: string[] = [];
	const start = Date.now();
	const total = 180;
	const batchSize = 10;
	for (let batch = 0; batch < total / batchSize; batch++) {
		const requests: Promise<void>[] = [];
		for (let index = 0; index < batchSize; index++) {
			const n = batch * batchSize + index;
			const mode = n % 3;
			const kind = mode === 0 ? "text" : mode === 1 ? "url" : "file";
			const body =
				mode === 0
					? { source_type: "text", title: `mixed-text-${n}`, content: `${"document text ".repeat(700)} ${n}` }
					: mode === 1
						? { source_type: "url", title: `mixed-url-${n}`, url: `${downstreamOrigin}/slow/${n}` }
						: { source_type: "file", title: `mixed-file-${n}`, url: `/tmp/synthetic-${n}.pdf` };
			requests.push(
				request(origin, "/api/documents", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				})
					.then((result) => {
						if (result.status !== 201) {
							postErrors.push(`${n}: status=${result.status} body=${result.body.slice(0, 200)}`);
							return;
						}
						const parsed = JSON.parse(result.body) as { id?: string };
						if (typeof parsed.id === "string") posted.push({ id: parsed.id, kind });
					})
					.catch((error) => postErrors.push(`${n}: ${String(error)}`)),
			);
		}
		await Promise.all(requests);
		await Bun.sleep(1000);
	}
	const submitDurationMs = Date.now() - start;

	const liveLatencies: number[] = [];
	let liveSuccessfulSamples = 0;
	const healthLatencies: number[] = [];
	const snapshots: Array<{
		elapsedSec: number;
		status: number;
		counts: Record<string, number>;
		liveMs: number;
		healthMs: number;
	}> = [];
	const deadline = Date.now() + 360_000;
	while (Date.now() < deadline) {
		if (termination(daemon).exited) break;
		const live = await request(origin, "/health/live", { signal: AbortSignal.timeout(2_000) }).catch(() => ({
			status: 0,
			body: "",
			ms: 2_000,
		}));
		const health = await request(origin, "/health", { signal: AbortSignal.timeout(2_000) }).catch(() => ({
			status: 0,
			body: "",
			ms: 2_000,
		}));
		liveLatencies.push(live.ms);
		if (live.status === 200) liveSuccessfulSamples++;
		healthLatencies.push(health.ms);
		let statusCounts: Record<string, number> = {};
		const documents = await request(origin, "/api/documents?limit=500", { signal: AbortSignal.timeout(2_000) }).catch(
			() => ({ status: 0, body: "", ms: 2_000 }),
		);
		if (documents.status === 200) {
			try {
				statusCounts = counts(
					(JSON.parse(documents.body) as { documents?: Array<{ status?: string }> }).documents ?? [],
				);
			} catch {}
		}
		snapshots.push({
			elapsedSec: Math.round((Date.now() - start) / 1000),
			status: health.status,
			counts: statusCounts,
			liveMs: Math.round(live.ms),
			healthMs: Math.round(health.ms),
		});
		const terminal = (statusCounts.done ?? 0) + (statusCounts.failed ?? 0) + (statusCounts.deleted ?? 0);
		if (posted.length > 0 && terminal >= posted.length) break;
		await Bun.sleep(1000);
	}

	const logDir = join(agentsDir, ".daemon", "logs");
	let logs = "";
	try {
		for (const name of readdirSync(logDir)) if (name.endsWith(".log")) logs += readFileSync(join(logDir, name), "utf8");
	} catch {}
	const tail = logs.split(/\r?\n/).slice(-120).join("\n");
	const finalSnapshot = snapshots.at(-1);
	const finalCounts = finalSnapshot?.counts ?? {};
	const terminal = (finalCounts.done ?? 0) + (finalCounts.failed ?? 0) + (finalCounts.deleted ?? 0);
	const residualBacklog = snapshots.length === 0 ? null : Math.max(0, posted.length - terminal);
	const child = termination(daemon);
	const evaluation = evaluate({
		expectedSubmissions: total,
		posted: posted.length,
		postErrors: postErrors.length,
		daemonExited: child.exited,
		liveSamples: liveLatencies.length,
		liveSuccessfulSamples,
		liveP95Ms: Math.round(percentile(liveLatencies, 0.95)),
		backlogObserved: snapshots.length > 0,
		residualBacklog,
	});
	const result = {
		agentsDir,
		submitDurationMs,
		posted: posted.length,
		postErrors,
		daemonExit: child.exitCode,
		daemonSignal: child.signal,
		live: {
			samples: liveLatencies.length,
			maxMs: Math.round(Math.max(...liveLatencies)),
			p95Ms: Math.round(percentile(liveLatencies, 0.95)),
		},
		health: {
			samples: healthLatencies.length,
			maxMs: Math.round(Math.max(...healthLatencies)),
			p95Ms: Math.round(percentile(healthLatencies, 0.95)),
		},
		snapshots: snapshots.filter((_, i) => i % 10 === 0 || i === snapshots.length - 1),
		backlog: {
			observed: snapshots.length > 0,
			residual: residualBacklog,
			drained: evaluation.backlogDrained,
		},
		evaluation,
		childStdout: stdout.join(""),
		childStderr: stderr.join(""),
		logTail: tail,
	};
	console.log(JSON.stringify(result, null, 2));
	process.exitCode = evaluation.pass ? 0 : 1;
} finally {
	if (daemon && !termination(daemon).exited) {
		daemon.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				daemon?.kill("SIGKILL");
				resolve();
			}, 5_000);
			daemon?.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
	if (downstream) await new Promise<void>((resolve) => downstream?.close(() => resolve()));
	rmSync(agentsDir, { recursive: true, force: true });
}
