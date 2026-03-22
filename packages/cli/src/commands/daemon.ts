import type { Command } from "commander";
import {
	type LogOptions,
	type PathOptions,
	type RestartOptions,
	type StatusOptions,
	withJson,
	withLogOptions,
	withPath,
} from "./shared.js";

interface DaemonDeps {
	readonly doRestart: (options?: RestartOptions) => Promise<void>;
	readonly doStart: (options?: PathOptions) => Promise<void>;
	readonly doStop: (options?: PathOptions) => Promise<void>;
	readonly showLogs: (options: LogOptions) => Promise<void>;
	readonly showStatus: (options: StatusOptions) => Promise<void>;
}

export function registerDaemonCommands(program: Command, deps: DaemonDeps): void {
	const daemonCmd = program.command("daemon").description("Manage the Signet daemon");

	const start = daemonCmd.command("start").description("Start the daemon").action(deps.doStart);
	withPath(start);

	const stop = daemonCmd.command("stop").description("Stop the daemon").action(deps.doStop);
	withPath(stop);

	const restart = daemonCmd
		.command("restart")
		.description("Restart the daemon")
		.option("--no-openclaw", "Skip OpenClaw restart prompt")
		.action(deps.doRestart);
	withPath(restart);

	const status = daemonCmd.command("status").description("Show daemon status").action(deps.showStatus);
	withJson(withPath(status));

	const logs = daemonCmd.command("logs").description("View daemon logs").action(deps.showLogs);
	withLogOptions(logs);

	const startAlias = program
		.command("start")
		.description("Start the daemon (alias for: signet daemon start)")
		.action(deps.doStart);
	withPath(startAlias);

	const stopAlias = program
		.command("stop")
		.description("Stop the daemon (alias for: signet daemon stop)")
		.action(deps.doStop);
	withPath(stopAlias);

	const restartAlias = program
		.command("restart")
		.description("Restart the daemon (alias for: signet daemon restart)")
		.option("--no-openclaw", "Skip OpenClaw restart prompt")
		.action(deps.doRestart);
	withPath(restartAlias);

	const logsAlias = program
		.command("logs")
		.description("View daemon logs (alias for: signet daemon logs)")
		.action(deps.showLogs);
	withLogOptions(logsAlias);
}
