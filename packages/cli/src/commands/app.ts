import type { Command } from "commander";
import { withJson, withPath } from "./shared.js";

interface SetupOptions {
	path?: string;
	nonInteractive?: boolean;
	name?: string;
	description?: string;
	deploymentType?: string;
	networkMode?: string;
	harness?: string[];
	embeddingProvider?: string;
	embeddingModel?: string;
	extractionProvider?: string;
	extractionModel?: string;
	searchBalance?: string;
	openclawRuntimePath?: string;
	configureOpenclawWorkspace?: boolean;
	openDashboard?: boolean;
	skipGit?: boolean;
	allowUnprotectedWorkspace?: boolean;
	createLocalBackup?: boolean;
}

interface PathOptions {
	path?: string;
}

interface StatusOptions extends PathOptions {
	json?: boolean;
}

interface AppDeps {
	readonly collectListOption: (value: string, previous: string[]) => string[];
	readonly configureAgent: () => Promise<void>;
	readonly launchDashboard: (options: PathOptions) => Promise<void>;
	readonly migrateSchema: (options: PathOptions) => Promise<void>;
	readonly setupWizard: (options: SetupOptions) => Promise<void>;
	readonly showDoctor: (options: StatusOptions) => Promise<void>;
	readonly showStatus: (options: StatusOptions) => Promise<void>;
	readonly syncTemplates: () => Promise<void>;
}

export function registerAppCommands(program: Command, deps: AppDeps): void {
	program
		.command("setup")
		.description("Setup wizard (interactive by default)")
		.option("-p, --path <path>", "Base path for agent files")
		.option("--non-interactive", "Run setup without prompts")
		.option("--name <name>", "Agent name (non-interactive mode)")
		.option("--description <description>", "Agent description (non-interactive mode)")
		.option(
			"--deployment-type <type>",
			"Deployment context (local, vps, server). Adjusts non-interactive inferred defaults.",
		)
		.option("--network-mode <mode>", "Daemon network mode in non-interactive mode (localhost, tailscale)")
		.option(
			"--harness <harness>",
			"Harness to configure (repeatable or comma-separated: claude-code, codex, opencode, openclaw, oh-my-pi, forge)",
			deps.collectListOption,
			[],
		)
		.option(
			"--embedding-provider <provider>",
			"Embedding provider in non-interactive mode (native, ollama, openai, none)",
		)
		.option("--embedding-model <model>", "Embedding model in non-interactive mode")
		.option(
			"--extraction-provider <provider>",
			"Extraction provider in non-interactive mode (claude-code, codex, ollama, opencode, openrouter, none)",
		)
		.option("--extraction-model <model>", "Extraction model in non-interactive mode")
		.option("--search-balance <alpha>", "Search balance alpha in non-interactive mode (0-1)")
		.option("--openclaw-runtime-path <mode>", "OpenClaw runtime path in non-interactive mode (plugin, legacy)")
		.option(
			"--configure-openclaw-workspace",
			"Patch discovered OpenClaw configs to use the selected setup path in non-interactive mode",
		)
		.option("--open-dashboard", "Open dashboard after setup in non-interactive mode")
		.option("--skip-git", "Skip git initialization and setup commits in non-interactive mode")
		.option(
			"--allow-unprotected-workspace",
			"Allow setup to finish without remote origin or local snapshot when OpenClaw points at this workspace",
		)
		.option(
			"--create-local-backup",
			"Create a local snapshot backup automatically when OpenClaw points at this workspace and no origin remote exists",
		)
		.action(deps.setupWizard);

	const dashboard = program
		.command("dashboard")
		.alias("ui")
		.description("Open the web dashboard")
		.action(deps.launchDashboard);
	withPath(dashboard);

	const status = program.command("status").description("Show agent and daemon status").action(deps.showStatus);
	withJson(withPath(status));

	const doctor = program
		.command("doctor")
		.description("Run local health checks and suggest fixes")
		.action(deps.showDoctor);
	withJson(withPath(doctor));

	const migrate = program
		.command("migrate-schema")
		.description("Migrate database to unified schema")
		.action(deps.migrateSchema);
	withPath(migrate);

	program.command("configure").alias("config").description("Configure agent settings").action(deps.configureAgent);

	program.command("sync").description("Sync built-in templates and skills").action(deps.syncTemplates);
}
