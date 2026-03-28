import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectSchema, getMissingIdentityFiles, hasValidIdentity } from "@signet/core";
import chalk from "chalk";
import { daemonAccessLines } from "../lib/network.js";
import { getGitRemoteState, getSnapshotProtection, hasOpenClawWorkspaceLink } from "../lib/workspace-protection.js";
import Database from "../sqlite.js";

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
	readonly extraction: {
		readonly configured: string | null;
		readonly effective: string | null;
		readonly fallbackProvider: string | null;
		readonly status: string | null;
		readonly degraded: boolean;
		readonly reason: string | null;
		readonly since: string | null;
	} | null;
	readonly extractionWorker: {
		readonly running: boolean;
		readonly overloaded: boolean;
		readonly loadPerCpu: number | null;
		readonly maxLoadPerCpu: number | null;
		readonly overloadBackoffMs: number | null;
		readonly overloadSince: string | null;
		readonly nextTickInMs: number | null;
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
	// True when an openclaw config was found with both the legacy hook AND the
	// plugin path enabled simultaneously (dual-system misconfiguration).
	readonly openclawDualSystem: boolean;
	readonly openclawWorkspaceLinked: boolean;
	readonly openclawWorkspaceUnprotected: boolean;
}

/**
 * Check candidate openclaw config paths for the dual-system misconfiguration
 * where both the legacy hook and plugin are enabled simultaneously.
 */
function detectOpenClawDualSystem(): boolean {
	const home = homedir();
	const candidates = [
		process.env.OPENCLAW_CONFIG_PATH,
		process.env.CLAWDBOT_CONFIG_PATH,
		join(home, ".openclaw", "openclaw.json"),
		join(home, ".clawdbot", "clawdbot.json"),
	].filter((p): p is string => typeof p === "string" && p.length > 0);

	for (const path of candidates) {
		try {
			if (!existsSync(path)) continue;
			const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			const hooks = raw.hooks as Record<string, unknown> | undefined;
			const internal = hooks?.internal as Record<string, unknown> | undefined;
			const entries = internal?.entries as Record<string, unknown> | undefined;
			const hook = entries?.["signet-memory"] as Record<string, unknown> | undefined;
			const hookEnabled = hook?.enabled === true;

			const plugins = raw.plugins as Record<string, unknown> | undefined;
			const pluginEntries = plugins?.entries as Record<string, unknown> | undefined;
			const plugin = pluginEntries?.["signet-memory-openclaw"] as Record<string, unknown> | undefined;
			const pluginEnabled = plugin?.enabled === true;

			if (hookEnabled && pluginEnabled) return true;
		} catch {
			// Unparseable config — skip
		}
	}
	return false;
}

interface DoctorFinding {
	readonly level: "info" | "warn" | "error";
	readonly message: string;
	readonly fix?: string;
}

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
}

export async function getStatusReport(basePath: string, deps: StatusDeps): Promise<StatusReport> {
	const existing = deps.detectExistingSetup(basePath);
	const installed = existing.agentsDir;
	const files = [
		{ name: "AGENTS.md", exists: existing.agentsMd },
		{ name: "agent.yaml", exists: existing.agentYaml },
		{ name: "memories.db", exists: existing.memoryDb },
	];
	const daemon = await deps.getDaemonStatus();
	const git = getGitRemoteState(basePath);
	const snapshot = getSnapshotProtection(basePath);
	const openclawWorkspaceLinked = hasOpenClawWorkspaceLink(basePath);
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
		openclawDualSystem: detectOpenClawDualSystem(),
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
		const ver = report.daemon.version && report.daemon.version !== "0.0.0" ? ` v${report.daemon.version}` : "";
		console.log(`  ${chalk.green("●")} Daemon ${chalk.green("running")}${chalk.dim(ver)}`);
		console.log(chalk.dim(`    PID: ${report.daemon.pid}`));
		console.log(chalk.dim(`    Uptime: ${deps.formatUptime(report.daemon.uptime || 0)}`));
		for (const line of daemonAccessLines(deps.defaultPort, report.daemon)) {
			console.log(chalk.dim(`    ${line}`));
		}
		const extractionNotice = getExtractionStatusNotice(report.daemon);
		if (extractionNotice) {
			const icon = extractionNotice.level === "error" ? chalk.red("✗") : chalk.yellow("⚠");
			const colorize = extractionNotice.level === "error" ? chalk.red : chalk.yellow;
			console.log(colorize(`    ${icon} ${extractionNotice.title}`));
			console.log(chalk.dim(`      ${extractionNotice.detail}`));
		}
	} else {
		console.log(`  ${chalk.red("○")} Daemon ${chalk.red("stopped")}`);
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
	console.log();
}

export function getExtractionStatusNotice(
	daemon: DaemonStatus,
): { level: "warn" | "error"; title: string; detail: string } | null {
	const extraction = daemon.extraction;
	if (extraction && daemon.running && extraction.status === "blocked") {
		return {
			level: "error",
			title: "Extraction blocked",
			detail: `configured: ${extraction.configured ?? "unknown"}, fallback: ${extraction.fallbackProvider ?? "unknown"}${extraction.reason ? ` — ${extraction.reason}` : ""}`,
		};
	}

	if (extraction && daemon.running && extraction.status === "degraded") {
		return {
			level: "warn",
			title: "Extraction degraded",
			detail: `configured: ${extraction.configured ?? "unknown"}, effective: ${extraction.effective ?? "unknown"}${extraction.reason ? ` — ${extraction.reason}` : ""}`,
		};
	}

	const extractionWorker = daemon.extractionWorker;
	if (extractionWorker && daemon.running && extractionWorker.running && extractionWorker.overloaded) {
		const load = typeof extractionWorker.loadPerCpu === "number" ? extractionWorker.loadPerCpu.toFixed(2) : "unknown";
		const threshold =
			typeof extractionWorker.maxLoadPerCpu === "number" ? extractionWorker.maxLoadPerCpu.toFixed(2) : "unknown";
		const nextTickSecs =
			typeof extractionWorker.nextTickInMs === "number"
				? Math.max(0, Math.ceil(extractionWorker.nextTickInMs / 1000))
				: null;
		return {
			level: "warn",
			title: "Pipeline load-shedding",
			detail: `load/core ${load} > threshold ${threshold}${nextTickSecs !== null ? ` — next tick in ${nextTickSecs}s` : ""}`,
		};
	}

	return null;
}

export async function showDoctor(options: { path?: string; json?: boolean }, deps: StatusDeps): Promise<void> {
	const basePath = deps.normalizeAgentPath(deps.extractPathOption(options) ?? deps.agentsDir);
	const report = await getStatusReport(basePath, deps);
	const findings = getDoctorFindings(report);
	const ok = findings.every((finding) => finding.level !== "error");

	if (options.json) {
		console.log(JSON.stringify({ ok, report, findings }, null, 2));
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

function getDoctorFindings(report: StatusReport): DoctorFinding[] {
	if (!report.installed) {
		return [
			{
				level: "error",
				message: "No Signet installation found.",
				fix: "Run `signet setup`.",
			},
		];
	}

	const findings: DoctorFinding[] = [];
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
		findings.push({
			level: "warn",
			message: "Daemon is not running.",
			fix: "Run `signet daemon start`.",
		});
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

	if (report.openclawDualSystem) {
		findings.push({
			level: "error",
			message:
				"OpenClaw dual-system conflict: legacy hook AND plugin are both enabled. This causes duplicate memories, 2× token burn, and 409 session errors.",
			fix: 'Run `signet setup --harness openclaw` to repair, or set hooks.internal.entries["signet-memory"].enabled = false in your openclaw config.',
		});
	}

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
