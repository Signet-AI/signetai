/**
 * Phase D stability acceptance scenario runner (#1543).
 *
 * Boots the real daemon (spawned from source) against a production-shaped
 * database (~106k memories, ~11k full-size transcript jobs, telemetry, and a
 * multi-thousand-file source index — see build-db.ts), with an event-loop
 * occupancy probe preloaded INTO the daemon process. While the daemon runs:
 *
 *   (a) polls /health/live, /api/status, and the diagnostics report
 *       concurrently at realistic intervals;
 *   (b) simulates provider-down: the embedding provider endpoint refuses
 *       connections (a bound-then-closed port), while a configured source
 *       root keeps the source sync walking (#1671's trigger);
 *   (c) drives a concurrent foreground write load via the normal memory
 *       remember path;
 *   (d) waits for and validates the incremental integrity coverage contract,
 *       including expected FTS5 skips and truthful frontier counts.
 *
 * At the end it reads the probe results, evaluates #1543's stability and
 * #1779's integrity acceptance criteria (criteria.ts), prints a human summary,
 * and writes a machine-readable JSON artifact.
 *
 * This harness is a judge, not a fixer: it never patches daemon behavior. If
 * it fails on current main, that is the harness working — the numbers are the
 * baseline.
 *
 * Usage:
 *   bun tests/integration/acceptance/run.ts [--scale full|smoke] [--keep] [--out DIR]
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildProductionDb, type ProductionDbResult } from "./build-db";
import { evaluateStability, percentile, type StabilityMeasurements } from "./criteria";

const harnessDir = import.meta.dir;
const repoRoot = resolve(harnessDir, "..", "..", "..");
const daemonScript = join(repoRoot, "platform/daemon/src/daemon.ts");
const probeScript = join(harnessDir, "loop-probe.ts");
const activeFetchControllers = new Set<AbortController>();

// -- CLI ---------------------------------------------------------------------

function parseArgs(argv: readonly string[]): { scale: "full" | "smoke"; keep: boolean; out: string | null } {
	const scaleIdx = argv.indexOf("--scale");
	const scale = scaleIdx !== -1 && argv[scaleIdx + 1] === "smoke" ? "smoke" : "full";
	return {
		scale,
		keep: argv.includes("--keep"),
		out: argv.includes("--out") ? (argv[argv.indexOf("--out") + 1] ?? null) : null,
	};
}

const args = parseArgs(process.argv.slice(2));

/** Full = the real deployment profile. Smoke = same code paths, smaller db + shorter run for per-PR CI. */
const SCALE =
	args.scale === "smoke"
		? {
				memories: 20_000,
				transcriptJobs: 2_000,
				telemetryEvents: 5_000,
				sourceFiles: 1_500,
				sourceTreeFiles: 400,
				sourceTreeDirs: 40,
				writeLoad: 120,
				runSeconds: 90,
			}
		: {
				memories: 106_000,
				transcriptJobs: 11_000,
				telemetryEvents: 25_000,
				sourceFiles: 5_000,
				sourceTreeFiles: 4_000,
				sourceTreeDirs: 200,
				writeLoad: 300,
				runSeconds: 180,
			};

// -- helpers -----------------------------------------------------------------

interface TimedResponse {
	readonly status: number;
	readonly ms: number;
	readonly json?: unknown;
}

async function timedFetch(
	url: string,
	timeoutMs: number,
	init?: RequestInit,
	readJson = false,
): Promise<TimedResponse> {
	const startedAt = performance.now();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	activeFetchControllers.add(controller);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (readJson) {
			const text = await response.text();
			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch {
				json = undefined;
			}
			return { status: response.status, ms: performance.now() - startedAt, json };
		}
		await response.arrayBuffer();
		return { status: response.status, ms: performance.now() - startedAt };
	} catch {
		return { status: 0, ms: performance.now() - startedAt };
	} finally {
		clearTimeout(timeout);
		activeFetchControllers.delete(controller);
	}
}

function listenOnEphemeralPort(server: Server): Promise<number> {
	return new Promise((resolvePort, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("no server address"));
				return;
			}
			resolvePort(address.port);
		});
	});
}

/** Resolve when the interval elapses, or immediately when the poller stops. */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolveSleep) => {
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolveSleep();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

/** Reserve an OS port and leave it CLOSED: connections are refused, never queued. */
async function reserveDeadPort(): Promise<number> {
	const holder = createServer();
	const port = await listenOnEphemeralPort(holder);
	await new Promise<void>((done) => holder.close(() => done()));
	return port;
}

function childExited(child: ChildProcess | null): {
	exited: boolean;
	code: number | null;
	signal: NodeJS.Signals | null;
} {
	if (!child || child.exitCode !== null || child.signalCode !== null) {
		return { exited: true, code: child?.exitCode ?? null, signal: child?.signalCode ?? null };
	}
	return { exited: false, code: null, signal: null };
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
	const value = record?.[key];
	return typeof value === "string" ? value : null;
}

interface IntegrityAcceptance {
	readonly pass: boolean;
	readonly checks: readonly {
		readonly name: string;
		readonly pass: boolean;
		readonly observed: string;
		readonly limit: string;
	}[];
	readonly summary: string;
	readonly snapshot: unknown;
}

function evaluateIntegritySnapshot(snapshot: unknown): IntegrityAcceptance {
	const root = asRecord(snapshot);
	const databaseIntegrity = asRecord(root?.databaseIntegrity);
	const progress = asRecord(databaseIntegrity?.incrementalProgress);
	const topLevelFts = asRecord(databaseIntegrity?.ftsVerification);
	const fts = asRecord(progress?.ftsVerification ?? databaseIntegrity?.ftsVerification);
	const inventory = numberField(progress, "inventoryObjects");
	const checked = numberField(progress, "checkedObjects");
	const skipped = numberField(progress, "skippedObjects");
	const remaining = numberField(progress, "remainingObjects");
	const ftsTotal = numberField(fts, "totalObjects");
	const ftsSkipped = numberField(fts, "skippedObjects");
	const ftsRemaining = numberField(fts, "remainingObjects");
	const countInvariant =
		inventory !== null && checked !== null && skipped !== null && remaining !== null
			? checked + skipped + remaining === inventory
			: false;
	const checks = [
		{
			name: "fresh production schema integrity state",
			pass: stringField(databaseIntegrity, "state") === "healthy" && databaseIntegrity?.repairGuidance === null,
			observed: `${String(databaseIntegrity?.state ?? "missing")} (repair guidance: ${String(databaseIntegrity?.repairGuidance ?? "none")})`,
			limit: "healthy with no repair guidance",
		},
		{
			name: "incremental integrity sweep completes",
			pass: stringField(progress, "phase") === "complete",
			observed: String(progress?.phase ?? "missing"),
			limit: "complete",
		},
		{
			name: "integrity coverage counts are consistent",
			pass: countInvariant,
			observed:
				inventory === null || checked === null || skipped === null || remaining === null
					? "missing numeric coverage fields"
					: `${checked} checked + ${skipped} skipped + ${remaining} remaining = ${inventory} inventory`,
			limit: "checked + skipped + remaining = inventory",
		},
		{
			name: "expected FTS5 coverage is explicit",
			pass:
				topLevelFts !== null &&
				stringField(fts, "status") === "unverifiable" &&
				ftsTotal !== null &&
				ftsTotal > 0 &&
				ftsSkipped === ftsTotal &&
				ftsRemaining === 0 &&
				stringField(progress, "degradationReason") === null,
			observed: `${String(fts?.status ?? "missing")} (${ftsSkipped ?? "?"}/${ftsTotal ?? "?"} skipped, ${ftsRemaining ?? "?"} remaining; degradation=${String(progress?.degradationReason ?? "none")})`,
			limit: "unverifiable FTS coverage, all FTS objects skipped, no degradation reason",
		},
		{
			name: "ordinary objects follow the FTS frontier",
			pass: stringField(progress, "lastObject") !== null && !/fts/i.test(stringField(progress, "lastObject") ?? ""),
			observed: String(progress?.lastObject ?? "missing"),
			limit: "completed object is not an FTS virtual table",
		},
	];
	const failed = checks.filter((check) => !check.pass);
	return {
		pass: failed.length === 0,
		checks,
		summary:
			failed.length === 0
				? "Integrity coverage acceptance PASSED: the production schema completed with explicit, non-degrading FTS coverage."
				: `Integrity coverage acceptance FAILED: ${failed.map((check) => check.name).join("; ")}`,
		snapshot,
	};
}

async function waitForIntegrityCoverage(
	origin: string,
	child: ChildProcess,
	output: () => string,
): Promise<IntegrityAcceptance> {
	const timeoutMs = args.scale === "smoke" ? 300_000 : 420_000;
	const deadline = Date.now() + timeoutMs;
	let lastSnapshot: unknown = null;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`daemon exited during integrity acceptance\n${output()}`);
		const response = await timedFetch(`${origin}/health`, 2_000, undefined, true);
		if (response.status === 200 && response.json !== undefined) {
			lastSnapshot = response.json;
			const databaseIntegrity = asRecord(asRecord(response.json)?.databaseIntegrity);
			const progress = asRecord(databaseIntegrity?.incrementalProgress);
			if (progress?.phase === "complete" || progress?.phase === "degraded") {
				return evaluateIntegritySnapshot(response.json);
			}
		}
		await Bun.sleep(200);
	}
	if (lastSnapshot !== null) {
		const evaluated = evaluateIntegritySnapshot(lastSnapshot);
		return {
			...evaluated,
			pass: false,
			checks: [
				...evaluated.checks,
				{
					name: "integrity coverage reaches a terminal observation",
					pass: false,
					observed: `timed out after ${timeoutMs / 1000}s`,
					limit: "complete or actionable terminal state",
				},
			],
			summary: `${evaluated.summary} The integrity progress did not reach a terminal observation within ${timeoutMs / 1000}s.`,
		};
	}
	return {
		pass: false,
		checks: [
			{
				name: "integrity coverage reaches a terminal observation",
				pass: false,
				observed: "no /health payload",
				limit: "complete or actionable terminal state",
			},
		],
		summary: "Integrity coverage acceptance FAILED: /health did not expose a database integrity payload.",
		snapshot: null,
	};
}

// -- synthetic source tree (keeps source sync walking like a real vault) ------

function buildSourceTree(root: string, files: number, dirs: number): void {
	const words = "source sync artifact capture transcript memory session index".split(" ");
	for (let d = 0; d < dirs; d++) {
		const dir = join(root, `notes-${String(d).padStart(4, "0")}`);
		mkdirSync(dir, { recursive: true });
		const perDir = Math.max(1, Math.ceil(files / dirs));
		for (let f = 0; f < perDir; f++) {
			const idx = d * perDir + f;
			if (idx >= files) break;
			const body: string[] = [`# note ${idx}`, ""];
			for (let line = 0; line < 40; line++) {
				body.push(`${words[(idx + line) % words.length]} ${words[(idx + line * 3) % words.length]} line ${line}`);
			}
			writeFileSync(join(dir, `note-${String(idx).padStart(6, "0")}.md`), `${body.join("\n")}\n`);
		}
	}
}

// -- probe results ------------------------------------------------------------

interface ProbeReport {
	enabled: boolean;
	phase: string;
	budgetMs: number;
	blocks: Array<{ at: number; ms: number; phase: string }>;
	samples: number[];
}

async function fetchProbeReport(probeOrigin: string): Promise<ProbeReport | null> {
	try {
		const response = await fetch(`${probeOrigin}/probe`, { signal: AbortSignal.timeout(5_000) });
		if (!response.ok) return null;
		return (await response.json()) as ProbeReport;
	} catch {
		return null;
	}
}

// -- main scenario ------------------------------------------------------------

interface PhaseMark {
	readonly at: number;
	readonly phase: string;
}

const phaseMarks: PhaseMark[] = [];
function markPhase(phase: string): void {
	phaseMarks.push({ at: Date.now(), phase });
}

const emergencyArtifactPath = join(
	resolve(args.out ?? join(tmpdir(), "phase-d-acceptance-artifacts")),
	`phase-d-acceptance-${args.scale}-failure.json`,
);

function writeEmergencyArtifact(kind: string, message: string): void {
	try {
		mkdirSync(resolve(args.out ?? join(tmpdir(), "phase-d-acceptance-artifacts")), { recursive: true });
		writeFileSync(
			emergencyArtifactPath,
			JSON.stringify(
				{
					harness: "phase-d-stability-acceptance",
					issue: 1543,
					integrityIssue: 1779,
					scale: args.scale,
					evaluation: {
						pass: false,
						checks: [],
						summary: `Phase D stability acceptance aborted during ${kind}: ${message}`,
					},
					phaseMarks,
					error: { kind, message },
				},
				null,
				2,
			),
		);
	} catch (error) {
		console.error(`[phase-d] could not write failure artifact ${emergencyArtifactPath}: ${String(error)}`);
	}
}

// Module-level daemon handle so the self-destruct timer can always reach it.
let daemonRef: ChildProcess | null = null;

async function main(): Promise<number> {
	const workspace = mkdtempSync(join(tmpdir(), "signet-phase-d-"));
	const agentsDir = join(workspace, "agents");
	mkdirSync(join(agentsDir, ".daemon", "logs"), { recursive: true });
	mkdirSync(join(agentsDir, "memory"), { recursive: true });

	let daemon: ChildProcess | null = null;
	let deadEmbeddingPort = 0;

	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];

	try {
		// 1. Build the production-shaped database.
		markPhase("build-db");
		console.error(
			`[phase-d] building ${args.scale} database: ${SCALE.memories} memories, ${SCALE.transcriptJobs} transcript jobs, ${SCALE.telemetryEvents} telemetry events, ${SCALE.sourceFiles} source index rows`,
		);
		const buildStarted = Date.now();
		const dbResult: ProductionDbResult = buildProductionDb(join(agentsDir, "memory", "memories.db"), {
			memoryCount: SCALE.memories,
			transcriptJobs: SCALE.transcriptJobs,
			telemetryEvents: SCALE.telemetryEvents,
			sourceFiles: SCALE.sourceFiles,
			seed: 1543,
		});
		const dbMb = (statSync(dbResult.dbPath).size / (1024 * 1024)).toFixed(1);
		console.error(`[phase-d] db built in ${Date.now() - buildStarted}ms (${dbMb} MB) at ${dbResult.dbPath}`);

		// 2. Provider-down endpoint: a port that REFUSES connections. The
		// daemon's embedding fetches fail fast at connect time — the same
		// failure mode as a dead provider, not a sleep-based fake.
		deadEmbeddingPort = await reserveDeadPort();

		// 3. agent.yaml with a reachable-by-URL-but-dead embedding provider
		//    (openai-compatible shape so base_url is honored) and the pipeline
		//    surface active.
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			[
				"agent:",
				"  name: phase-d-acceptance",
				"  created: 2026-01-01T00:00:00.000Z",
				"embedding:",
				`  provider: llama-cpp`,
				`  model: dead-provider-model`,
				`  dimensions: 768`,
				`  base_url: http://127.0.0.1:${deadEmbeddingPort}`,
				"memory:",
				"  pipelineV2:",
				"    enabled: true",
				"    hints:",
				"      enabled: false",
				"    reflections:",
				"      enabled: false",
				"    embeddingTracker:",
				"      enabled: true",
				"    modelRegistry:",
				"      enabled: false",
				"    procedural:",
				"      enabled: false",
				"    feedback:",
				"      enabled: false",
				"    significance:",
				"      enabled: false",
				"    telemetryEnabled: false",
				// Dreaming passes need an LLM route; without one they fail
				// (recorded noise). The harness judges stability surfaces, not
				// dreaming — pin the threshold above the seeded backlog so the
				// check loop stays quiet and deterministic.
				"  dreaming:",
				"    tokenThreshold: 1000000",
				"",
			].join("\n"),
		);

		// 4. Synthetic source root keeps the native source bridge walking
		//    while the provider is down (#1671's trigger shape).
		const sourceRoot = join(workspace, "source-tree");
		mkdirSync(sourceRoot, { recursive: true });
		buildSourceTree(sourceRoot, SCALE.sourceTreeFiles, SCALE.sourceTreeDirs);
		writeFileSync(
			join(agentsDir, "sources.json"),
			`${JSON.stringify(
				{
					version: 1,
					sources: [
						{
							id: "phase-d-synth",
							generation: "phase-d-acceptance-1",
							kind: "obsidian",
							name: "phase-d-synth",
							root: sourceRoot,
							enabled: true,
							mode: "read-only",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							excludeGlobs: ["**/.*/**", "**/.*"],
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		// 5. Spawn the daemon with the probe preloaded into its process. The
		//    probe binds its own loopback listener so results stay readable
		//    even if the daemon's HTTP surface wedges. The child env is
		//    hermetic: HOME and harness-specific state point at the workspace
		//    so built-in sources never index the invoking user's real home.
		markPhase("daemon-startup");
		const portHolder = createServer();
		const daemonPort = await listenOnEphemeralPort(portHolder);
		await new Promise<void>((done) => portHolder.close(() => done()));
		const origin = `http://127.0.0.1:${daemonPort}`;

		const probePortHolder = createServer();
		const probePort = await listenOnEphemeralPort(probePortHolder);
		await new Promise<void>((done) => probePortHolder.close(() => done()));
		const probeOrigin = `http://127.0.0.1:${probePort}`;

		const daemonHome = join(workspace, "daemon-home");
		mkdirSync(daemonHome, { recursive: true });

		console.error(
			`[phase-d] spawning daemon on ${origin} (probe on ${probeOrigin}, embedding provider dead on port ${deadEmbeddingPort})`,
		);
		daemon = spawn(process.execPath, ["--preload", probeScript, daemonScript], {
			cwd: repoRoot,
			env: {
				...process.env,
				HOME: daemonHome,
				USERPROFILE: daemonHome,
				CODEX_HOME: join(daemonHome, ".codex"),
				CLAUDE_CONFIG_DIR: join(daemonHome, ".claude"),
				HERMES_HOME: join(daemonHome, ".hermes"),
				SIGNET_PATH: agentsDir,
				SIGNET_PORT: String(daemonPort),
				SIGNET_HOST: "127.0.0.1",
				SIGNET_BIND: "127.0.0.1",
				SIGNET_TELEMETRY_OPTOUT: "1",
				SIGNET_DAEMON_ENTRYPOINT: "1",
				SIGNET_PHASE_D_PROBE_PORT: String(probePort),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		daemonRef = daemon;
		daemon.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString()));
		daemon.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));

		// 6. Wait for readiness (bounded). Startup counts toward the gate:
		//    #1543 demands no unbounded synchronous startup work.
		const readyDeadline = Date.now() + 120_000;
		let ready = false;
		while (Date.now() < readyDeadline) {
			const state = childExited(daemon);
			if (state.exited) {
				throw new Error(
					`daemon exited during startup: code=${state.code} signal=${state.signal}\nstderr tail:\n${stderrChunks.join("").slice(-4000)}`,
				);
			}
			const probe = await timedFetch(`${origin}/health/live`, 2_000).catch(() => null);
			if (probe && probe.status === 200) {
				ready = true;
				break;
			}
			await Bun.sleep(200);
		}
		if (!ready) throw new Error("daemon did not become live within 120s");
		const daemonStartupMark = phaseMarks[phaseMarks.length - 1];
		const startupMs = daemonStartupMark ? Date.now() - daemonStartupMark.at : -1;
		console.error(`[phase-d] daemon live after ${startupMs}ms (on ${SCALE.memories} memories)`);
		const integrityAcceptance = await waitForIntegrityCoverage(origin, daemon, () => stderrChunks.join(""));
		console.error(integrityAcceptance.summary);

		// 7. Start the measurement phase pollers.
		markPhase("run");
		// Tell the probe the startup phase ended.
		await fetch(`${probeOrigin}/phase`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ phase: "run" }),
			signal: AbortSignal.timeout(2_000),
		}).catch(() => {});

		const liveLatencies: number[] = [];
		const liveFailures = { count: 0 };
		const statusLatencies: number[] = [];
		const statusFailures = { count: 0 };
		const diagnosticsLatencies: number[] = [];
		const queueDepthSamples: Array<{ at: number; memory: number | null; summary: number | null }> = [];
		let queueDepthUnavailableReason: string | null = null;
		let stop = false;
		const pollerAbort = new AbortController();

		// (a) /health/live every 250ms — the hot liveness path.
		const liveLoop = (async () => {
			while (!stop) {
				const r = await timedFetch(`${origin}/health/live`, 5_000);
				liveLatencies.push(r.ms);
				if (r.status !== 200) liveFailures.count++;
				await sleepAbortable(250, pollerAbort.signal);
			}
		})();

		// (a) /api/status every 2s — the dashboard status path.
		const statusLoop = (async () => {
			while (!stop) {
				const r = await timedFetch(`${origin}/api/status`, 10_000);
				statusLatencies.push(r.ms);
				if (r.status !== 200) statusFailures.count++;
				await sleepAbortable(2_000, pollerAbort.signal);
			}
		})();

		// (a) diagnostics report every 5s (getDiagnostics equivalent). Queue
		// depth is read from the daemon's dedicated observable route rather than
		// guessing fields that are not present in /api/diagnostics.
		const diagnosticsLoop = (async () => {
			while (!stop) {
				const [r, queueResponse] = await Promise.all([
					timedFetch(`${origin}/api/diagnostics`, 10_000, undefined, true),
					timedFetch(`${origin}/api/diagnostics/queue`, 10_000, undefined, true),
				]);
				diagnosticsLatencies.push(r.ms);
				const queues = (
					queueResponse.json as
						| {
								queues?: {
									memory?: { pending?: unknown; leased?: unknown };
									summary?: { pending?: unknown; leased?: unknown };
								};
						  }
						| undefined
				)?.queues;
				const depth = (queue: { pending?: unknown; leased?: unknown } | undefined): number | null => {
					const pending = queue?.pending;
					const leased = queue?.leased;
					return typeof pending === "number" && typeof leased === "number" ? pending + leased : null;
				};
				const memoryDepth = depth(queues?.memory);
				const summaryDepth = depth(queues?.summary);
				if (queueResponse.status === 200 && (memoryDepth !== null || summaryDepth !== null)) {
					queueDepthSamples.push({ at: Date.now(), memory: memoryDepth, summary: summaryDepth });
				} else if (queueDepthSamples.length === 0) {
					queueDepthUnavailableReason =
						queueResponse.status === 0
							? "GET /api/diagnostics/queue did not respond"
							: `GET /api/diagnostics/queue returned HTTP ${queueResponse.status} without pending/leased queue counts`;
				}
				await sleepAbortable(5_000, pollerAbort.signal);
			}
		})();

		// (c) Foreground write load through the normal remember path,
		//     concurrent with the pollers. Modest concurrency, realistic body
		//     sizes.
		const writeLoop = (async () => {
			const bodies = Array.from({ length: SCALE.writeLoad }, (_, i) => ({
				content: `phase-d acceptance write ${i}: ${"observed system behavior under concurrent load ".repeat(3)}${i}`,
				who: "phase-d-harness",
				project: "phase-d",
				importance: 0.4 + (i % 10) / 25,
			}));
			let next = 0;
			const workers = Array.from({ length: 4 }, async () => {
				while (!stop) {
					const i = next++;
					if (i >= bodies.length) break;
					const body = bodies[i];
					if (!body) break;
					await timedFetch(`${origin}/api/memory/remember`, 10_000, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					});
					await sleepAbortable(150, pollerAbort.signal);
				}
			});
			await Promise.all(workers);
		})();

		// Run-phase watchdog: bounded wall clock, liveness of the daemon
		// process, and — critically — continued HTTP availability. A daemon
		// whose listener starves while the process stays alive is exactly
		// the #1670/#1671 wedge signature; the poller latency series records
		// it (timeouts), and this loop surfaces a hard error if BOTH primary
		// surfaces become unreachable (not merely slow) for 30s straight.
		const runDeadline = Date.now() + SCALE.runSeconds * 1_000;
		let lastReachableAt = Date.now();
		let lastProgressLog = Date.now();
		while (Date.now() < runDeadline) {
			const state = childExited(daemon);
			if (state.exited) {
				throw new Error(
					`daemon exited mid-run: code=${state.code} signal=${state.signal}\nstderr tail:\n${stderrChunks.join("").slice(-4000)}`,
				);
			}
			const live = await timedFetch(`${origin}/health/live`, 2_000);
			if (live.status === 200) {
				lastReachableAt = Date.now();
			} else if (Date.now() - lastReachableAt > 30_000) {
				console.error(
					`[phase-d] /health/live unreachable for ${Math.round((Date.now() - lastReachableAt) / 1000)}s (last status ${live.status}) — continuing to sample; the latency series and probe will record the outage`,
				);
				lastReachableAt = Date.now(); // re-arm; each 30s outage is logged once
			}
			if (Date.now() - lastProgressLog > 15_000) {
				lastProgressLog = Date.now();
				const runMark = phaseMarks[phaseMarks.length - 1];
				const elapsed = runMark ? Math.round((Date.now() - runMark.at) / 1000) : 0;
				console.error(
					`[phase-d] run t+${elapsed}s: live p95 so far ${Math.round(percentile(liveLatencies, 0.95))}ms over ${liveLatencies.length} samples; status p95 ${Math.round(percentile(statusLatencies, 0.95))}ms over ${statusLatencies.length} samples`,
				);
			}
			await Bun.sleep(1_000);
		}
		stop = true;
		pollerAbort.abort();
		for (const controller of activeFetchControllers) controller.abort();
		const POLLER_SHUTDOWN_TIMEOUT_MS = 15_000;
		const pollers = Promise.allSettled([liveLoop, statusLoop, diagnosticsLoop, writeLoop]);
		const shutdownResult = await Promise.race([
			pollers.then(() => "settled" as const),
			Bun.sleep(POLLER_SHUTDOWN_TIMEOUT_MS).then(() => "timeout" as const),
		]);
		const pollersSettled = shutdownResult === "settled";
		if (!pollersSettled) {
			console.error(
				`[phase-d] pollers did not settle within ${POLLER_SHUTDOWN_TIMEOUT_MS / 1000}s after the run deadline`,
			);
		}

		// 8. Collect probe results and evaluate.
		const probe = await fetchProbeReport(probeOrigin);
		if (!probe) throw new Error("probe results unavailable: probe server did not respond");

		const worstBlock =
			probe.blocks.length > 0 ? probe.blocks.reduce((worst, block) => (block.ms > worst.ms ? block : worst)) : null;

		const measurements: StabilityMeasurements = {
			eventLoop: {
				blockBudgetMs: probe.budgetMs,
				blocksOverBudget: probe.blocks.length,
				p50Ms: percentile(probe.samples, 0.5),
				p95Ms: percentile(probe.samples, 0.95),
				maxMs: probe.samples.length > 0 ? Math.max(...probe.samples) : 0,
				worstBlock,
			},
			healthLive: {
				samples: liveLatencies.length,
				failures: liveFailures.count,
				p95Ms: percentile(liveLatencies, 0.95),
				maxMs: liveLatencies.length > 0 ? Math.max(...liveLatencies) : 0,
			},
			apiStatus: {
				samples: statusLatencies.length,
				failures: statusFailures.count,
				p95Ms: percentile(statusLatencies, 0.95),
				maxMs: statusLatencies.length > 0 ? Math.max(...statusLatencies) : 0,
			},
		};
		let evaluation = evaluateStability(measurements);
		if (!pollersSettled) {
			const shutdownCheck = {
				name: "pollers settle after run deadline",
				pass: false,
				observed: `pollers still pending after ${POLLER_SHUTDOWN_TIMEOUT_MS / 1000}s`,
				limit: "all pollers settled",
			};
			evaluation = {
				pass: false,
				checks: [...evaluation.checks, shutdownCheck],
				summary: evaluation.pass
					? `Phase D stability acceptance FAILED: pollers did not settle within ${POLLER_SHUTDOWN_TIMEOUT_MS / 1000}s after the run deadline.`
					: `${evaluation.summary} Pollers also did not settle within ${POLLER_SHUTDOWN_TIMEOUT_MS / 1000}s after the run deadline.`,
			};
		}
		if (!integrityAcceptance.pass) {
			evaluation = {
				pass: false,
				checks: [...evaluation.checks, ...integrityAcceptance.checks],
				summary: `${evaluation.summary} ${integrityAcceptance.summary}`,
			};
		} else {
			evaluation = {
				...evaluation,
				checks: [...evaluation.checks, ...integrityAcceptance.checks],
			};
		}

		// 9. Output: human summary + machine-readable artifact.
		let logs = "";
		try {
			const logDir = join(agentsDir, ".daemon", "logs");
			for (const name of readdirSync(logDir))
				if (name.endsWith(".log")) logs += readFileSync(join(logDir, name), "utf8");
		} catch {}

		const artifact = {
			harness: "phase-d-stability-acceptance",
			issue: 1543,
			integrityIssue: 1779,
			scale: args.scale,
			db: { ...dbResult.counts, buildMs: dbResult.buildMs, sizeMb: Number(dbMb) },
			startupMs,
			runSeconds: SCALE.runSeconds,
			providerDownPort: deadEmbeddingPort,
			writeLoadRequests: SCALE.writeLoad,
			shutdown: {
				pollersSettled,
				timedOut: !pollersSettled,
				timeoutMs: POLLER_SHUTDOWN_TIMEOUT_MS,
			},
			diagnostics: {
				samples: diagnosticsLatencies.length,
				p95Ms: Math.round(percentile(diagnosticsLatencies, 0.95)),
				maxMs: diagnosticsLatencies.length > 0 ? Math.round(Math.max(...diagnosticsLatencies)) : 0,
				queueDepthSamples,
				queueDepthRoute: "/api/diagnostics/queue",
				queueDepthUnavailableReason,
			},
			measurements,
			evaluation,
			integrityAcceptance,
			phaseMarks,
			daemonStdoutTail: stdoutChunks.join("").slice(-4000),
			daemonStderrTail: stderrChunks.join("").slice(-4000),
			logTail: logs.split(/\r?\n/).slice(-200).join("\n"),
		};

		const outDir = args.out ?? workspace;
		mkdirSync(outDir, { recursive: true });
		const artifactPath = join(outDir, `phase-d-acceptance-${args.scale}.json`);
		writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

		console.error("");
		console.error("== Phase D stability acceptance ==");
		for (const check of evaluation.checks) {
			console.error(
				`  ${check.pass ? "PASS" : "FAIL"}  ${check.name}: observed ${check.observed} (limit ${check.limit})`,
			);
		}
		console.error(
			`  event-loop delay p50/p95/max: ${Math.round(measurements.eventLoop.p50Ms)}/${Math.round(measurements.eventLoop.p95Ms)}/${Math.round(measurements.eventLoop.maxMs)}ms`,
		);
		console.error(`  artifact: ${artifactPath}`);
		console.error("");
		if (!evaluation.pass) console.error(evaluation.summary);
		return evaluation.pass ? 0 : 1;
	} finally {
		if (daemon && !childExited(daemon).exited) {
			// A wedged daemon can ignore SIGTERM (observed on main: shutdown
			// cleanup itself timed out after a 30s event-loop block). Escalate
			// on a short deadline so the harness always terminates; probe
			// results were already collected before this point.
			daemon.kill("SIGTERM");
			await new Promise<void>((done) => {
				const timer = setTimeout(() => {
					daemon?.kill("SIGKILL");
					setTimeout(done, 1_000);
				}, 8_000);
				daemon?.once("close", () => {
					clearTimeout(timer);
					done();
				});
			});
		}
		if (!args.keep) {
			try {
				rmSync(workspace, { recursive: true, force: true });
			} catch {}
		} else {
			console.error(`[phase-d] kept workspace: ${workspace}`);
		}
	}
}

if (import.meta.main) {
	// Hard wall-clock self-destruct: a wedged daemon (or a hung await anywhere
	// in the harness) must never wedge CI. The deadline covers every phase;
	// SIGKILL to the daemon + exit 124 so the timeout is unmistakable in logs.
	const SELF_DESTRUCT_MS = (args.scale === "smoke" ? 9 : 16) * 60_000;
	const selfDestruct = setTimeout(() => {
		const message = `exceeded ${SELF_DESTRUCT_MS / 60_000}min wall clock`;
		console.error(`[phase-d] SELF-DESTRUCT: ${message} — killing daemon and aborting`);
		writeEmergencyArtifact("self-destruct", message);
		if (daemonRef && !daemonRef.killed) daemonRef.kill("SIGKILL");
		process.exit(124);
	}, SELF_DESTRUCT_MS);
	selfDestruct.unref?.();

	try {
		process.exitCode = await main();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[phase-d] harness failed: ${message}`);
		writeEmergencyArtifact("harness-error", message);
		process.exitCode = 1;
	} finally {
		clearTimeout(selfDestruct);
	}
}
