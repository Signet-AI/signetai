import chalk from "chalk";
import type { Command } from "commander";
import { HermesAgentConnector } from "@signet/connector-hermes-agent";

interface ConnectorInstallOptions {
	url?: string;
	apiKey?: string;
	agentId?: string;
	path?: string;
	profile?: string;
	agent?: string;
	memory?: "isolated" | "shared" | "group";
	group?: string;
}

interface ConnectorDeps {
	readonly agentsDir: string;
	readonly configureHarnessHooks: (harness: string, basePath: string) => Promise<void>;
}

function withTemporaryEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
	const previous = new Map<string, string | undefined>();
	for (const key of Object.keys(values)) {
		previous.set(key, process.env[key]);
		const value = values[key];
		if (typeof value === "string" && value.trim().length > 0) process.env[key] = value.trim();
	}
	return fn().finally(() => {
		for (const [key, value] of previous.entries()) {
			if (value === undefined) Reflect.deleteProperty(process.env, key);
			else process.env[key] = value;
		}
	});
}

async function installConnector(harness: string, options: ConnectorInstallOptions, deps: ConnectorDeps): Promise<void> {
	await withTemporaryEnv(
		{ SIGNET_DAEMON_URL: options.url, SIGNET_API_KEY: options.apiKey, SIGNET_AGENT_ID: options.agentId },
		async () => deps.configureHarnessHooks(harness, options.path ?? deps.agentsDir),
	);
	console.log(chalk.green(`  ✓ ${harness} connector installed`));
}

async function installHermes(options: ConnectorInstallOptions, deps: ConnectorDeps): Promise<void> {
	if (!options.profile) throw new Error("--profile is required for connect hermes");
	const result = await new HermesAgentConnector({ profile: options.profile }).install(options.path ?? deps.agentsDir, {
		agentId: options.agent ?? options.profile,
		memoryPolicy: options.memory,
		policyGroup: options.group,
	});
	for (const warning of result.warnings ?? []) console.warn(chalk.yellow(`  ${warning}`));
	if (!result.success)
		throw new Error(`${result.message}. Repair or rerun the command for the targeted Hermes profile.`);
	console.log(chalk.green(`  ✓ ${result.message}`));
}

async function disconnectHermes(options: ConnectorInstallOptions): Promise<void> {
	if (!options.profile) throw new Error("--profile is required for disconnect hermes");
	const result = await new HermesAgentConnector({ profile: options.profile }).uninstall();
	console.log(chalk.green(`  ✓ Hermes Agent disconnected (${result.filesRemoved.length} file(s) removed)`));
}

function addInstallOptions(command: Command): Command {
	return command
		.option("--url <url>", "Remote Signet daemon URL")
		.option("--api-key <key>", "Signet API key")
		.option("--agent-id <id>", "Signet agent id for this connector")
		.option("--path <path>", "Signet workspace path", undefined);
}

export function registerConnectorCommands(program: Command, deps: ConnectorDeps): void {
	const connector = program.command("connector").description("Manage portable harness connectors");
	addInstallOptions(connector.command("install <harness>").description("Install a harness connector")).action(
		(harness: string, options: ConnectorInstallOptions) => installConnector(harness, options, deps),
	);

	const connect = addInstallOptions(program.command("connect <harness>").description("Install a harness connector"));
	connect
		.option("--profile <name>", "Hermes profile name")
		.option("--agent <name>", "Hermes Signet agent name")
		.option("--memory <policy>", "Hermes memory policy")
		.option("--group <name>", "Hermes group")
		.action((harness: string, options: ConnectorInstallOptions) =>
			harness === "hermes" ? installHermes(options, deps) : installConnector(harness, options, deps),
		);

	const disconnect = program.command("disconnect <harness>").description("Disconnect a harness connector");
	disconnect
		.option("--profile <name>", "Hermes profile name")
		.action((harness: string, options: ConnectorInstallOptions) => {
			if (harness !== "hermes") throw new Error("Only disconnect hermes is supported");
			return disconnectHermes(options);
		});
}
