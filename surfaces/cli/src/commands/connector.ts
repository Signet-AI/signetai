import chalk from "chalk";
import type { Command } from "commander";

interface ConnectorInstallOptions {
	url?: string;
	apiKey?: string;
	agentId?: string;
	path?: string;
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
		if (typeof value === "string" && value.trim().length > 0) {
			process.env[key] = value.trim();
		}
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
		{
			SIGNET_DAEMON_URL: options.url,
			SIGNET_API_KEY: options.apiKey,
			SIGNET_AGENT_ID: options.agentId,
		},
		async () => deps.configureHarnessHooks(harness, options.path ?? deps.agentsDir),
	);
	console.log(chalk.green(`  ✓ ${harness} connector installed`));
}

function addInstallOptions(command: Command): Command {
	return command
		.option("--url <url>", "Remote Signet daemon URL (sets SIGNET_DAEMON_URL for the installed connector)")
		.option("--api-key <key>", "Signet API key (sets SIGNET_API_KEY for the installed connector)")
		.option("--agent-id <id>", "Signet agent id for this connector")
		.option("--path <path>", "Signet workspace path", undefined);
}

export function registerConnectorCommands(program: Command, deps: ConnectorDeps): void {
	const connector = program.command("connector").description("Manage portable harness connectors");

	addInstallOptions(connector.command("install <harness>").description("Install a harness connector")).action(
		(harness: string, options: ConnectorInstallOptions) => installConnector(harness, options, deps),
	);

	addInstallOptions(program.command("connect <harness>").description("Install a harness connector (alias for connector install)")).action(
		(harness: string, options: ConnectorInstallOptions) => installConnector(harness, options, deps),
	);
}
