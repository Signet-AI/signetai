#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCodeConnector } from "../dist/index.js";

const harness = "opencode";

function usage() {
	console.log(
		"Usage: signet-connector-opencode [install|uninstall|status] [options]\n\nOptions:\n  --url <url>          Remote Signet daemon URL (sets SIGNET_DAEMON_URL)\n  --api-key <key>      Signet API key (sets SIGNET_API_KEY)\n  --token <token>      Backward-compatible alias for --api-key\n  --agent-id <id>      Signet agent id for this connector\n  --path <path>        Signet workspace path (default: SIGNET_PATH or ~/.agents)\n  -h, --help           Show this help\n\nExamples:\n  signet-connector-opencode install --url http://host:3850 --api-key sig_sk_...\n  npx -y @signet/connector-opencode install --url http://host:3850 --api-key sig_sk_...\n",
	);
}

function takeValue(args, index, name) {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
	return value;
}

function parseArgs(argv) {
	const options = { command: "install" };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "install" || arg === "uninstall" || arg === "status") {
			options.command = arg;
			continue;
		}
		if (arg === "-h" || arg === "--help" || arg === "help") {
			options.help = true;
			continue;
		}
		if (arg === "--url" || arg === "--daemon-url") {
			options.url = takeValue(argv, i, arg);
			i++;
			continue;
		}
		if (arg === "--api-key" || arg === "--token") {
			options.apiKey = takeValue(argv, i, arg);
			i++;
			continue;
		}
		if (arg === "--agent-id") {
			options.agentId = takeValue(argv, i, arg);
			i++;
			continue;
		}
		if (arg === "--path" || arg === "-p") {
			options.path = takeValue(argv, i, arg);
			i++;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

function setEnv(name, value) {
	if (typeof value === "string" && value.trim().length > 0) process.env[name] = value.trim();
}

function printList(label, values) {
	if (!Array.isArray(values) || values.length === 0) return;
	console.log(`${label}:`);
	for (const value of values) console.log(`  - ${value}`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	setEnv("SIGNET_DAEMON_URL", options.url);
	setEnv("SIGNET_API_KEY", options.apiKey);
	setEnv("SIGNET_AGENT_ID", options.agentId);
	const basePath = options.path || process.env.SIGNET_PATH || join(homedir(), ".agents");
	const connector = new OpenCodeConnector();
	if (options.command === "status") {
		console.log(connector.isInstalled() ? `${harness}: installed` : `${harness}: not installed`);
		return;
	}
	if (options.command === "uninstall") {
		const result = await connector.uninstall();
		console.log(`${harness}: uninstalled`);
		printList("Files removed", result.filesRemoved);
		printList("Configs patched", result.configsPatched);
		return;
	}
	const result = await connector.install(basePath);
	console.log(result.message || `${harness}: installed`);
	printList("Files written", result.filesWritten);
	printList("Configs patched", result.configsPatched);
	printList("Warnings", result.warnings);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
