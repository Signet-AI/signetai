import { detectSchema, getMissingIdentityFiles, hasValidIdentity } from "@signet/core";
import chalk from "chalk";
import { join } from "node:path";
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

export async function showStatus(
	options: { path?: string; json?: boolean },
	deps: StatusDeps,
): Promise<void> {
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
		console.log(chalk.dim(`    Dashboard: http://localhost:${deps.defaultPort}`));
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
	console.log();
}

export async function showDoctor(
	options: { path?: string; json?: boolean },
	deps: StatusDeps,
): Promise<void> {
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
