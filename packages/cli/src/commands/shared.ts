import type { Command } from "commander";

export interface PathOptions {
	path?: string;
}

export interface StatusOptions extends PathOptions {
	json?: boolean;
}

export interface RestartOptions extends PathOptions {
	openclaw?: boolean;
}

export interface LogOptions extends PathOptions {
	lines?: string;
	follow?: boolean;
	level?: string;
	category?: string;
}

export function withPath(cmd: Command): Command {
	return cmd.option("-p, --path <path>", "Base path for agent files");
}

export function withJson(cmd: Command): Command {
	return cmd.option("--json", "Output as JSON");
}

export function withLogOptions(cmd: Command): Command {
	return withPath(cmd)
		.option("-n, --lines <lines>", "Number of lines to show", "50")
		.option("-f, --follow", "Follow log output in real-time")
		.option("-l, --level <level>", "Filter by level (debug, info, warn, error)")
		.option("-c, --category <category>", "Filter by category (daemon, api, memory, sync, git, watcher)");
}
