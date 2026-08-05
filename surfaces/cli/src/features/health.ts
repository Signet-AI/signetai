import { join } from "node:path";
import { diagnoseHermesIntegration } from "@signet/connector-hermes-agent";
import { OpenClawConnector, type OpenClawRuntimeState } from "@signet/connector-openclaw";
import {
	type SignetInstallationReport,
	detectSchema,
	detectSignetInstallations,
	getMissingIdentityFiles,
	hasValidIdentity,
	inactivePackageManagerInstallations,
	loadIdentityMode,
} from "@signet/core";
import chalk from "chalk";
import { daemonAccessLines } from "../lib/network.js";
import type { DaemonResourceUsage } from "../lib/runtime.js";
import { getGitRemoteState, getSnapshotProtection, hasOpenClawWorkspaceLink } from "../lib/workspace-protection.js";
import Database from "../sqlite.js";
import { getDaemonBaseUrl } from "./repair-queue.js";

interface Existing {
	readonly agentsDir: boolean;
	readonly agentsMd: boolean;
	readonly agentYaml: boolean;
	readonly memoryDb: boolean;
}

interface DaemonStatus {
	readonly running: boolean;
	readonly pid: number | null;
	readonly uptime: number | null;
	readonly version: string | null;
	readonly host: string | null;
	readonly bindHost: string | null;
	readonly networkMode: string | null;
	readonly resources?: DaemonResourceUsage | null;
	readonly extraction: {
		readonly configured: string | null;
		readonly resolved: string | null;
		readonly effective: string | null;
		readonly fallbackProvider: string | null;
		readonly status: string | null;
		readonly degraded: boolean;
		readonly reason: string | null;
		readonly blockedBy?: readonly string[];
		readonly since: string | null;
		readonly enabled: boolean;
		readonly paused: boolean;
		readonly workerRunning: boolean;
		readonly ready: boolean;
		readonly blockedReason: string | null;
		readonly hasWorkloadState: boolean;
	} | null;
	readonly transcripts: {
		readonly pending: number;
		readonly failed: number;
		readonly dead: number;
	} | null;
	readonly health?: {
		readonly score: number | null;
		readonly status: string | null;
	} | null;
	readonly queue?: {
		readonly memory: {
			readonly pending: number;
			readonly leased: number;
			readonly completed: number;
			readonly failed: number;
			readonly dead: number;
			readonly oldestAgeSec: number;
			readonly oldestDeadAgeSec: number;
			readonly lastError: string | null;
		} | null;
		readonly summary: {
			readonly pending: number;
			readonly leased: number;
			readonly completed: number;
			readonly failed: number;
			readonly dead: number;
			readonly oldestAgeSec: number;
			readonly oldestDeadAgeSec: number;
			readonly lastError: string | null;
		} | null;
	} | null;
	readonly probe?: {
		readonly status: "healthy" | "degraded" | "listener-unhealthy" | "process-unhealthy" | "stale-artifact" | "absent";
		readonly detail: string;
		readonly url: string | null;
		readonly listenerPresent: boolean;
		readonly processPid: number | null;
		readonly stalePid: number | null;
		readonly readinessReasons?: readonly string[];
	};
	readonly openclaw?: {
		readonly status: "connected" | "stale" | "never-seen";
		readonly lastHeartbeat: string | null;
		readonly pluginVersion: string | null;
		readonly hooksRegistered: readonly string[];
		readonly hooksSucceeded: number;
		readonly hooksFailed: number;
		readonly lastLatencyMs: number;
		readonly lastError: string | null;
	} | null;
}

interface DbReport {
	readonly exists: boolean;
	readonly schema: string | null;
	readonly needsMigration: boolean;
	readonly memoryCount: number | null;
	readonly conversationCount: number | null;
}

interface FileReport {
	readonly name: string;
	readonly exists: boolean;
}

interface StatusReport {
	readonly basePath: string;
	readonly installed: boolean;
	readonly validIdentity: boolean;
	readonly missingIdentityFiles: readonly string[];
	readonly files: readonly FileReport[];
	readonly db: DbReport;
	readonly daemon: DaemonStatus;
	readonly git: {
		readonly isRepo: boolean;
		readonly origin: string | null;
		readonly snapshot: string | null;
	};
	readonly openclawDualSystem: boolean;
	readonly openclawRuntime: OpenClawRuntimeState;
	readonly openclawWorkspaceLinked: boolean;
	readonly openclawWorkspaceUnprotected: boolean;
}

interface DoctorFinding {
	readonly level: "info" | "warn" | "error";
	readonly code?: string;
	readonly message: string;
	readonly fix?: string;
}

const HIGH_PHYSICAL_MEMORY_MIB = 1024;

interface StatusDeps {
	readonly agentsDir: string;
	readonly defaultPort: number;
	readonly detectExistingSetup: (basePath: string) => Existing;
	readonly extractPathOption: (value: unknown) => string | null;
	readonly formatUptime: (seconds: number) => string;
	readonly getDaemonStatus: () => Promise<DaemonStatus>;
	readonly normalizeAgentPath: (pathValue: string) => string;
	readonly parseIntegerValue: (value: unknown) => number | null;
	readonly signetLogo: () => string;
	readonly detectInstallations?: () => SignetInstallationReport;
}

export async function getStatusReport(basePath: string, deps: StatusDeps): Promise<StatusReport> {
	const existing = deps.detectExistingSetup(basePath);
	const installed = existing.agentsDir;
	const identityMode = installed ? loadIdentityMode(basePath) : "managed";
	const showIdentityFiles = identityMode === "managed";
	const files = [
		...(showIdentityFiles ? [{ name: "AGENTS.md", exists: existing.agentsMd }] : []),
		{ name: "agent.yaml", exists: existing.agentYaml },
		{ name: "memories.db", exists: existing.memoryDb },
	];
	const daemon = await deps.getDaemonStatus();
	const git = getGitRemoteState(basePath);
	const snapshot = getSnapshotProtection(basePath);
	const openclawWorkspaceLinked = hasOpenClawWorkspaceLink(basePath);
	const openclawRuntime = new OpenClawConnector().getRuntimeState();
	const report: StatusReport = {
		basePath,
		installed,
		validIdentity: installed ? hasValidIdentity(basePath) : false,
		missingIdentityFiles: installed ? getMissingIdentityFiles(basePath) : [],
		files,
		db: {
			exists: existing.memoryDb,
			schema: null,
			needsMigration: false,
			memoryCount: null,
			conversationCount: null,
		},
		daemon,
		git: {
			isRepo: git.isRepo,
			origin: git.origin,
			snapshot,
		},
		openclawDualSystem: openclawRuntime === "dual",
		openclawRuntime,
		openclawWorkspaceLinked,
		openclawWorkspaceUnprotected: openclawWorkspaceLinked && git.origin === null && snapshot === null,
	};

	if (!existing.memoryDb) {
		return report;
	}

	let db: ReturnType<typeof Database> | null = null;
	try {
		db = Database(join(basePath, "memory", "memories.db"), {
			readonly: true,
		});
		const schema = detectSchema(db);
		const memoryCount = readCount(db, "SELECT COUNT(*) as count FROM memories", deps);
		const conversationCount = schema.hasConversations
			? readCount(db, "SELECT COUNT(*) as count FROM conversations", deps)
			: null;
		return {
			...report,
			db: {
				exists: true,
				schema: schema.type,
				needsMigration: schema.type !== "core" && schema.type !== "unknown",
				memoryCount,
				conversationCount,
			},
		};
	} catch {
		return report;
	} finally {
		if (db) {
			db.close();
		}
	}
}

export async function showStatus(options: { path?: string; json?: boolean }, deps: StatusDeps): Promise<void> {
	const basePath = deps.normalizeAgentPath(deps.extractPathOption(options) ?? deps.agentsDir);
	const report = await getStatusReport(basePath, deps);

	if (options.json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}

	console.log(deps.signetLogo());

	if (!report.installed) {
		console.log(chalk.yellow("  No Signet installation found."));
		console.log(`  Run ${chalk.bold("signet setup")} to get started.`);
		return;
	}

	console.log(chalk.bold("  Status\n"));

	if (report.daemon.running) {
		const readinessDegraded = report.daemon.probe?.status === "degraded";
		const ver = report.daemon.version && report.daemon.version !== "0.0.0" ? ` v${report.daemon.version}` : "";
		console.log(
			`  ${chalk.green("●")} Daemon ${chalk.green("running")}${chalk.dim(ver)}${readinessDegraded ? chalk.dim(" (live)") : ""}`,
		);
		console.log(chalk.dim(`    PID: ${report.daemon.pid ?? "unknown"}`));
		console.log(
			chalk.dim(`    Uptime: ${report.daemon.uptime === null ? "unknown" : deps.formatUptime(report.daemon.uptime)}`),
		);
		const resources = report.daemon.resources;
		if (resources?.physicalFootprint !== null && resources?.physicalFootprint !== undefined) {
			const rss = resources.rss === null ? "" : ` (${formatMemory(resources.rss)} RSS)`;
			const peak =
				resources.peakPhysicalFootprint === null ? "" : `, peak ${formatMemory(resources.peakPhysicalFootprint)}`;
			console.log(chalk.dim(`    Memory: ${formatMemory(resources.physicalFootprint)} physical${rss}${peak}`));
		}
		for (const line of daemonAccessLines(deps.defaultPort, report.daemon)) {
			console.log(chalk.dim(`    ${line}`));
		}
		if (readinessDegraded) {
			const reasons = report.daemon.probe?.readinessReasons ?? [];
			const summary = reasons.slice(0, 2).join("; ");
			console.log(chalk.yellow(`    ▲ Readiness degraded${summary ? `: ${summary}` : ""}`));
		}
		const transcripts = report.daemon.transcripts;
		if (transcripts) {
			const unhealthy = transcripts.failed > 0 || transcripts.dead > 0;
			const pending = transcripts.pending > 0;
			const icon = unhealthy ? chalk.red("✗") : pending ? chalk.yellow("◐") : chalk.green("✓");
			const label = unhealthy
				? chalk.red("needs attention")
				: pending
					? chalk.yellow("pending")
					: chalk.green("healthy");
			console.log(
				`    ${icon} Transcript capture ${label}${transcripts.pending > 0 ? chalk.dim(` (${transcripts.pending} pending)`) : ""}${transcripts.failed + transcripts.dead > 0 ? chalk.dim(` (${transcripts.failed + transcripts.dead} failed/dead)`) : ""}`,
			);
		}
		const extractionNotice = getExtractionStatusNotice(report.daemon);
		if (extractionNotice) {
			const icon = extractionNotice.level === "error" ? chalk.red("✗") : chalk.yellow("⚠");
			const colorize = extractionNotice.level === "error" ? chalk.red : chalk.yellow;
			console.log(colorize(`    ${icon} ${extractionNotice.title}`));
			console.log(chalk.dim(`      ${extractionNotice.detail}`));
		}
		if (report.daemon.openclaw && report.openclawRuntime === "plugin") {
			const icon =
				report.daemon.openclaw.status === "connected"
					? chalk.green("✓")
					: report.daemon.openclaw.status === "stale"
						? chalk.yellow("⚠")
						: chalk.yellow("◐");
			console.log(`    ${icon} OpenClaw plugin ${report.daemon.openclaw.status}`);
		}
	} else {
		const probe = report.daemon.probe;
		// The process can be alive while /health is unreachable (event loop
		// blocked by a wedged worker). Label that "unresponsive", not
		// "stopped": a restart often re-triggers the same wedge, and the
		// operator should look at the logs first (#1074).
		const unresponsive = probe?.status === "listener-unhealthy" || probe?.status === "process-unhealthy";
		if (unresponsive) {
			console.log(`  ${chalk.yellow("◐")} Daemon ${chalk.yellow("unresponsive")}`);
			console.log(chalk.dim(`    ${probe.detail}`));
			console.log(
				chalk.dim(
					"    The daemon process is alive but not answering. Check `signet daemon logs`; a restart may not clear a wedged worker.",
				),
			);
		} else {
			console.log(`  ${chalk.red("○")} Daemon ${chalk.red("stopped")}`);
			if (probe && probe.status !== "absent") {
				console.log(chalk.dim(`    ${probe.detail}`));
			}
		}
	}

	// Queue diagnostics include the live memory and summary workers.
	if (report.daemon.running) {
		await renderPipelineQueuesBlock(deps, report.daemon.queue ?? undefined);
		const daemonHealth = report.daemon.health;
		if (daemonHealth?.status === "unhealthy") {
			const score = typeof daemonHealth.score === "number" ? ` (score ${daemonHealth.score.toFixed(2)})` : "";
			console.log(chalk.yellow(`  ⚠ Daemon reports unhealthy composite health${score}`));
			console.log(chalk.dim("    Core memory processing may be failing; see the queue rows above."));
		}
	}

	console.log();

	for (const file of report.files) {
		const icon = file.exists ? chalk.green("✓") : chalk.red("✗");
		console.log(`  ${icon} ${file.name}`);
	}

	if (report.db.needsMigration && report.db.schema) {
		console.log();
		console.log(chalk.yellow(`  ⚠ Database schema: ${report.db.schema}`));
		console.log(chalk.dim(`    Run ${chalk.bold("signet migrate-schema")} to upgrade`));
	}

	if (report.db.exists) {
		console.log();
		if (typeof report.db.memoryCount === "number") {
			console.log(chalk.dim(`  Memories: ${report.db.memoryCount}`));
		}
		if (typeof report.db.conversationCount === "number") {
			console.log(chalk.dim(`  Conversations: ${report.db.conversationCount}`));
		}
	}

	if (!report.validIdentity && report.missingIdentityFiles.length > 0) {
		console.log();
		console.log(chalk.yellow(`  Missing identity files: ${report.missingIdentityFiles.join(", ")}`));
	}

	console.log();
	console.log(chalk.dim(`  Path: ${report.basePath}`));
	if (report.openclawWorkspaceUnprotected) {
		console.log(chalk.red("  ⚠ OpenClaw workspace protection: unprotected"));
		console.log(chalk.dim("    No origin remote detected for this workspace."));
	} else if (report.openclawWorkspaceLinked && report.git.snapshot) {
		console.log(chalk.yellow("  ⚠ OpenClaw workspace protection: local snapshot"));
		console.log(chalk.dim(`    Snapshot: ${report.git.snapshot}`));
	}
	if (report.openclawRuntime === "legacy") {
		console.log(chalk.yellow("  ⚠ OpenClaw runtime: legacy-only"));
		console.log(chalk.dim("    Run `signet sync` to migrate to the plugin path and restore full lifecycle capture."));
	}
	console.log();
}

interface QueueCountsForDisplay {
	readonly pending: number;
	readonly leased: number;
	readonly completed: number;
	readonly failed: number;
	readonly dead: number;
	readonly oldestAgeSec: number;
	readonly oldestDeadAgeSec: number;
	readonly lastError: string | null;
}

interface PipelineQueueDisplayReport {
	readonly timestamp: string;
	readonly queues: {
		readonly memory: QueueCountsForDisplay;
		readonly summary: QueueCountsForDisplay;
	};
}

async function fetchPipelineQueueReport(baseUrl: string): Promise<PipelineQueueDisplayReport | null> {
	try {
		const res = await fetch(`${baseUrl}/api/diagnostics/queue`, {
			signal: AbortSignal.timeout(2000),
		});
		if (!res.ok) return null;
		return (await res.json()) as PipelineQueueDisplayReport;
	} catch {
		return null;
	}
}

function formatAge(seconds: number): string {
	if (seconds <= 0) return "—";
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
	return `${(seconds / 86400).toFixed(1)}d`;
}

function renderQueueRow(label: string, counts: QueueCountsForDisplay): string {
	const deadColor = counts.dead > 0 ? chalk.red : chalk.dim;
	const failColor = counts.failed > 0 ? chalk.yellow : chalk.dim;
	const cells: string[] = [
		`p=${counts.pending}`,
		`l=${counts.leased}`,
		`c=${counts.completed}`,
		failColor(`f=${counts.failed}`),
		deadColor(`d=${counts.dead}`),
		chalk.dim(`oldest=${formatAge(counts.oldestAgeSec)}`),
		chalk.dim(`dead=${formatAge(counts.oldestDeadAgeSec)}`),
	];
	return `    ${chalk.bold(label.padEnd(10))} ${cells.join(" ")}`;
}

export async function renderPipelineQueuesBlock(
	deps: { defaultPort: number },
	captured?: NonNullable<DaemonStatus["queue"]>,
): Promise<void> {
	// Prefer the daemon's own /api/status queue block (always available when
	// the daemon is up); fall back to the admin-guarded diagnostics endpoint
	// for the richer age columns.
	const report = captured
		? ({
				queues: {
					memory: captured.memory,
					summary: captured.summary,
				},
			} as PipelineQueueDisplayReport)
		: await fetchPipelineQueueReport(getDaemonBaseUrl(deps.defaultPort));
	if (!report?.queues) return;
	const { memory, summary } = report.queues;
	if (!memory || !summary) return;
	const deadTotal = memory.dead + summary.dead;
	const heading = deadTotal > 0 ? chalk.yellow("Pipeline queues (dead jobs present)") : "Pipeline queues";
	console.log("");
	console.log(`  ${heading}`);
	console.log(renderQueueRow("memory", memory));
	console.log(renderQueueRow("summary", summary));
	if (memory.lastError) console.log(chalk.dim(`    memory last error: ${String(memory.lastError).slice(0, 120)}`));
	if (summary.lastError) console.log(chalk.dim(`    summary last error: ${String(summary.lastError).slice(0, 120)}`));
	console.log(chalk.dim("    (use 'signet repair queue {requeue|cancel|prune} [--apply]' to clean up)"));
}

export { getDaemonBaseUrl };

export function getExtractionStatusNotice(
	daemon: DaemonStatus,
): { level: "warn" | "error"; title: string; detail: string } | null {
	const extraction = daemon.extraction;
	if (extraction && daemon.running && extraction.hasWorkloadState && !extraction.ready) {
		// The legacy auto-extraction pipeline was deliberately retired in favor
		// of Dreaming, which owns all semantic writes. Retired states are not a
		// fault and are not surfaced as a pipeline notice at all.
		if (!extraction.enabled && extraction.status === "disabled" && extraction.reason) {
			return null;
		}
		const title = !extraction.enabled
			? "Pipeline disabled"
			: extraction.paused
				? "Pipeline paused"
				: extraction.status === "blocked"
					? "Extraction blocked"
					: "Extraction unavailable";
		return {
			level: extraction.status === "blocked" ? "error" : "warn",
			title,
			detail: `configured: ${extraction.configured ?? "none"}, resolved: ${extraction.resolved ?? "none"}, effective: ${extraction.effective ?? "none"}, worker running: ${extraction.workerRunning}${extraction.blockedReason ? ` — ${extraction.blockedReason}` : ""}${
				extraction.status === "blocked" && extraction.blockedBy && extraction.blockedBy.length > 0
					? ` — blocked by: ${extraction.blockedBy.join("; ")}`
					: ""
			}`,
		};
	}
	if (extraction && daemon.running && extraction.status === "blocked") {
		const blockedBy =
			extraction.blockedBy && extraction.blockedBy.length > 0
				? ` — blocked by: ${extraction.blockedBy.join("; ")}`
				: "";
		return {
			level: "error",
			title: "Extraction blocked",
			detail: `configured: ${extraction.configured ?? "unknown"}, fallback: ${extraction.fallbackProvider ?? "unknown"}${extraction.reason ? ` — ${extraction.reason}` : ""}${blockedBy}`,
		};
	}

	if (extraction && daemon.running && extraction.status === "degraded") {
		return {
			level: "warn",
			title: "Extraction degraded",
			detail: `configured: ${extraction.configured ?? "unknown"}, effective: ${extraction.effective ?? "unknown"}${extraction.reason ? ` — ${extraction.reason}` : ""}`,
		};
	}

	return null;
}

export async function showDoctor(
	options: { path?: string; json?: boolean; target?: string },
	deps: StatusDeps,
): Promise<void> {
	if (options.target === "hermes" || options.target === "hermes-agent") {
		await showHermesDoctor(options);
		return;
	}

	if (options.target) {
		console.log(chalk.red(`Unknown doctor target: ${options.target}`));
		console.log(chalk.dim("Supported targets: hermes"));
		process.exitCode = 1;
		return;
	}

	const basePath = deps.normalizeAgentPath(deps.extractPathOption(options) ?? deps.agentsDir);
	const report = await getStatusReport(basePath, deps);
	const installations = (deps.detectInstallations ?? detectSignetInstallations)();
	const findings = getDoctorFindings(report, installations);
	const ok = findings.every((finding) => finding.level !== "error");

	if (options.json) {
		console.log(JSON.stringify({ ok, report, installations, findings }, null, 2));
		return;
	}

	console.log(deps.signetLogo());
	console.log(chalk.bold("  Doctor\n"));

	if (findings.length === 0) {
		console.log(chalk.green("  ✓ Looks healthy"));
		console.log(chalk.dim("  No obvious local issues detected."));
		console.log();
		return;
	}

	for (const finding of findings) {
		const icon =
			finding.level === "error" ? chalk.red("✗") : finding.level === "warn" ? chalk.yellow("⚠") : chalk.cyan("•");
		console.log(`  ${icon} ${finding.message}`);
		if (finding.fix) {
			console.log(chalk.dim(`    ${finding.fix}`));
		}
	}

	console.log();
	if (ok) {
		console.log(chalk.yellow("  Signet can run, but there's a bit of duct tape showing."));
	} else {
		console.log(chalk.red("  Fix the errors above before trusting the CLI to behave."));
	}
	console.log();
}

async function showHermesDoctor(options: { json?: boolean }): Promise<void> {
	const report = await diagnoseHermesIntegration();

	if (options.json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}

	console.log(chalk.bold("  Hermes Doctor\n"));
	console.log(chalk.dim(`  Hermes home: ${report.hermesHome}`));
	console.log(chalk.dim(`  Hermes repo: ${report.hermesRepo ?? "not found"}`));
	console.log();

	for (const check of report.checks) {
		const icon = check.ok ? chalk.green("✓") : chalk.red("✗");
		console.log(`  ${icon} ${check.label}`);
		console.log(chalk.dim(`    ${check.detail}`));
		if (!check.ok && check.fix) {
			console.log(chalk.dim(`    ${check.fix}`));
		}
	}

	if (report.toolNames.length > 0) {
		console.log();
		console.log(chalk.dim(`  Tools: ${report.toolNames.join(", ")}`));
	}

	for (const warning of report.warnings) {
		console.log(chalk.yellow(`  ⚠ ${warning}`));
	}

	console.log();
	if (report.ok) {
		console.log(chalk.green("  ✓ Hermes Signet integration is healthy"));
	} else {
		console.log(chalk.red("  Hermes Signet integration needs repair"));
	}
	console.log();
}

function addDaemonProbeFindings(report: StatusReport, findings: DoctorFinding[]): void {
	const probe = report.daemon.probe;
	if (!probe || probe.status === "healthy") return;

	if (probe.status === "listener-unhealthy") {
		findings.push({
			level: "error",
			message: "Daemon port is listening, but /health is unreachable.",
			fix: "Run `signet daemon restart`; if it recurs, inspect ~/.agents/.daemon/logs/daemon.err.log.",
		});
		return;
	}

	if (probe.status === "process-unhealthy") {
		findings.push({
			level: "error",
			message: "Daemon process exists, but the HTTP health endpoint is unreachable.",
			fix: "Run `signet daemon restart`; if it hangs, stop the stale process and inspect daemon logs.",
		});
		return;
	}

	if (probe.status === "stale-artifact") {
		findings.push({
			level: "warn",
			message: "Daemon pid artifact is stale.",
			fix: "Run `signet daemon start`; stale pid files are ignored by current status probes.",
		});
	}
}

function addOpenClawRuntimeFindings(report: StatusReport, findings: DoctorFinding[]): void {
	if (report.openclawRuntime === "dual") {
		findings.push({
			level: "error",
			message:
				"OpenClaw dual-system conflict: legacy hook AND plugin are both enabled. This causes duplicate memories, 2× token burn, and 409 session errors.",
			fix: 'Run `signet setup --harness openclaw` to repair, or set hooks.internal.entries["signet-memory"].enabled = false in your openclaw config.',
		});
	}

	if (report.openclawRuntime === "legacy") {
		findings.push({
			level: "warn",
			message:
				"OpenClaw is still running on the legacy Signet hook path. Manual commands still work, but session-start, prompt-submit, compaction, and session-end capture stay disabled.",
			fix: "Run `signet sync` to migrate this OpenClaw config to the plugin runtime path.",
		});
	}
}

function addOpenClawHeartbeatFindings(report: StatusReport, findings: DoctorFinding[]): void {
	if (!report.daemon.running || report.openclawRuntime !== "plugin") return;
	const health = report.daemon.openclaw;
	if (!health) {
		findings.push({
			level: "warn",
			message: "OpenClaw plugin path is configured, but daemon OpenClaw diagnostics are unavailable.",
			fix: "Update/restart the Signet daemon, then rerun `signet doctor` to verify plugin heartbeat state.",
		});
		return;
	}

	if (health.status === "never-seen") {
		findings.push({
			level: "warn",
			message: "OpenClaw plugin path is configured, but the Signet daemon has not seen a plugin heartbeat.",
			fix: "Restart OpenClaw so the signet-memory plugin can register, then rerun `signet doctor`.",
		});
		return;
	}

	if (health.status === "stale") {
		findings.push({
			level: "warn",
			message: "OpenClaw plugin heartbeat is stale.",
			fix: "Restart OpenClaw or check its plugin logs for signet-memory registration errors.",
		});
	}

	if (health.lastError) {
		findings.push({
			level: "warn",
			message: `OpenClaw plugin reported degraded Signet hook activity: ${health.lastError}`,
			fix: "Check the daemon logs and OpenClaw plugin logs for the failing hook or subsystem.",
		});
	}
}

function addConcurrentInstallationFindings(report: SignetInstallationReport, findings: DoctorFinding[]): void {
	if (report.target.kind !== "native") return;
	for (const duplicate of inactivePackageManagerInstallations(report)) {
		findings.push({
			level: "warn",
			code: "duplicate_signet_installation",
			message: `Another Signet installation is inactive: ${duplicate.executablePath} (${duplicate.method}). Active: ${report.target.executablePath} (native).`,
			fix: duplicate.removalCommand
				? `After verifying the active installation, remove only the duplicate launcher (this keeps signet-mcp available): ${duplicate.removalCommand}`
				: undefined,
		});
	}
}

function addPhysicalMemoryFinding(report: StatusReport, findings: DoctorFinding[]): void {
	const resources = report.daemon.resources;
	const physical = resources?.physicalFootprint;
	if (!report.daemon.running || physical === null || physical === undefined || physical < HIGH_PHYSICAL_MEMORY_MIB) {
		return;
	}

	const rss = resources.rss === null ? "" : `; RSS reports ${formatMemory(resources.rss)}`;
	findings.push({
		level: "warn",
		code: "high_daemon_physical_memory",
		message: `Daemon physical memory is high: ${formatMemory(physical)}${rss}.`,
		fix: "Run `signet daemon restart` to reclaim it, then report recurring growth with the physical-footprint values from `/health`.",
	});
}

function addQueueBacklogFindings(report: StatusReport, findings: DoctorFinding[]): void {
	if (!report.daemon.running) return;
	const queue = report.daemon.queue;
	if (!queue) return;

	const memory = queue.memory;
	const summary = queue.summary;
	const memoryDead = memory?.dead ?? 0;
	const summaryDead = summary?.dead ?? 0;
	const deadTotal = memoryDead + summaryDead;

	const daemonHealth = report.daemon.health;
	if (daemonHealth?.status === "unhealthy") {
		const score = typeof daemonHealth.score === "number" ? ` (score ${daemonHealth.score.toFixed(2)})` : "";
		findings.push({
			level: "error",
			code: "daemon_unhealthy",
			message: `Daemon reports unhealthy composite health${score}.`,
			fix: "Inspect the queue rows in `signet status`; dead jobs can be requeued with `signet repair queue requeue --apply`.",
		});
	}

	if (deadTotal > 0) {
		const lastError = memory?.lastError ?? summary?.lastError;
		const detail = lastError ? ` Last error: ${lastError.slice(0, 160)}` : "";
		const parts: string[] = [];
		if (memoryDead > 0) parts.push(`${memoryDead} memory`);
		if (summaryDead > 0) parts.push(`${summaryDead} summary`);
		findings.push({
			level: "error",
			code: "dead_jobs_backlog",
			message: `${deadTotal} permanently dead processing job(s) (${parts.join(", ")}).${detail}`,
			fix: "Run `signet repair queue requeue --apply` to reset dead jobs, or `signet repair queue cancel --apply` to retire them.",
		});
	}
}

function getDoctorFindings(report: StatusReport, installations: SignetInstallationReport): DoctorFinding[] {
	const findings: DoctorFinding[] = [];
	addConcurrentInstallationFindings(installations, findings);

	if (!report.installed) {
		findings.push({
			level: "error",
			message: "No Signet installation found.",
			fix: "Run `signet setup`.",
		});
		return findings;
	}

	const hasAgentYaml = report.files.find((file) => file.name === "agent.yaml")?.exists ?? false;
	const missingIdentity = report.missingIdentityFiles.filter((file) => file !== "agent.yaml");

	if (!report.validIdentity && (hasAgentYaml || missingIdentity.length > 0)) {
		const missing = missingIdentity.join(", ");
		findings.push({
			level: "error",
			message: `Missing required identity files${missing ? `: ${missing}` : "."}`,
			fix: "Run `signet setup` or restore the missing files.",
		});
	}

	if (!hasAgentYaml) {
		findings.push({
			level: "error",
			message: "agent.yaml is missing.",
			fix: "Run `signet setup` to recreate the manifest.",
		});
	}

	if (!report.db.exists) {
		findings.push({
			level: "error",
			message: "Memory database is missing.",
			fix: "Run `signet setup` to initialize memory storage.",
		});
	}

	if (!report.daemon.running) {
		addDaemonProbeFindings(report, findings);
		if (!report.daemon.probe || report.daemon.probe.status === "absent") {
			findings.push({
				level: "warn",
				message: "Daemon is not running.",
				fix: "Run `signet daemon start`.",
			});
		}
	}

	if (report.db.needsMigration && report.db.schema) {
		findings.push({
			level: "warn",
			message: `Database is still on ${report.db.schema} schema.`,
			fix: "Run `signet migrate-schema`.",
		});
	}

	if (report.db.exists && report.db.memoryCount === 0) {
		findings.push({
			level: "info",
			message: "Memory database is empty.",
			fix: "Use `signet remember` or keep chatting so the daemon can build memory.",
		});
	}

	addOpenClawRuntimeFindings(report, findings);
	addOpenClawHeartbeatFindings(report, findings);
	addPhysicalMemoryFinding(report, findings);
	addQueueBacklogFindings(report, findings);

	if (report.openclawWorkspaceUnprotected) {
		findings.push({
			level: "warn",
			message:
				"OpenClaw points at this Signet workspace, but no git origin remote is configured. Uninstalling OpenClaw can leave this workspace unrecoverable without backup.",
			fix: "Run `git -C <workspace> remote add origin <private-repo-url>` or rerun `signet setup` and create a local snapshot backup.",
		});
	}

	return findings;
}

function formatMemory(valueMiB: number): string {
	return valueMiB >= 1024 ? `${(valueMiB / 1024).toFixed(1)} GiB` : `${valueMiB} MiB`;
}

function readCount(db: ReturnType<typeof Database>, sql: string, deps: StatusDeps): number | null {
	try {
		const raw = db.prepare(sql).get();
		return isRecord(raw) ? deps.parseIntegerValue(raw.count) : null;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
