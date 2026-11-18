import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, win32 } from "node:path";
import { isExistingFile, isJsonObject, readManagedTrimmedEnv, type ResolvedCommand } from "./config";

export const SIGNET_MCP_STDIO_WORKER_ENV = "SIGNET_MCP_STDIO_WORKER";

export function quoteCommandArg(value: string, platform: NodeJS.Platform = process.platform): string {
	if (/^[A-Za-z0-9_./\\:@+=,-]+$/.test(value)) return value;
	if (platform === "win32") {
		return `"${value.replace(/[%^&|<>!"]/g, (char) => (char === "%" ? "%%" : `^${char}`))}"`;
	}
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function renderCommand(launcher: ResolvedCommand): string {
	return [launcher.command, ...launcher.args].map((arg) => quoteCommandArg(arg)).join(" ");
}

export function parseHookLauncher(command: string): ResolvedCommand | undefined {
	const clean = command
		.trim()
		.replace(
			/^(?:(?:SIGNET_DAEMON_URL|SIGNET_API_KEY|SIGNET_PATH|SIGNET_FETCH_TIMEOUT|SIGNET_SESSION_START_TIMEOUT|SIGNET_PROMPT_SUBMIT_TIMEOUT)=(?:'(?:[^']|'\\'')*'|"[^"]*"|\S+)\s+|set "(?:SIGNET_DAEMON_URL|SIGNET_API_KEY|SIGNET_PATH|SIGNET_FETCH_TIMEOUT|SIGNET_SESSION_START_TIMEOUT|SIGNET_PROMPT_SUBMIT_TIMEOUT)=[^"]*" && )+/i,
			"",
		);
	const args: string[] = [];
	let value = "";
	let quote = "";
	let started = false;
	for (let i = 0; i < clean.length; i++) {
		const char = clean.charAt(i);
		if (!quote && /[$`;&|<>()]/.test(char)) return undefined;
		if (char === "\\" && !quote && clean.charAt(i + 1) === "'") {
			value += "'";
			i++;
			started = true;
			continue;
		}
		if (char === quote) {
			quote = "";
			continue;
		}
		if (!quote && (char === "'" || char === '"')) {
			quote = char;
			started = true;
			continue;
		}
		if (!quote && /\s/.test(char)) {
			if (started && value === "hook") {
				const executable = args.shift();
				const launcher = executable ? { command: executable, args } : undefined;
				return isSignetCliLauncher(launcher) ? launcher : undefined;
			}
			if (started) args.push(value);
			value = "";
			started = false;
			continue;
		}
		value += char;
		started = true;
	}
	return undefined;
}

export function isSignetCliLauncher(launcher: ResolvedCommand | undefined): boolean {
	if (!launcher) return false;
	if (/^signet(?:\.(?:exe|cmd|bat|ps1))?$/i.test(win32.basename(launcher.command))) return launcher.args.length === 0;
	return (
		/^(?:node|bun)(?:\.exe)?$/i.test(win32.basename(launcher.command)) &&
		launcher.args.length === 1 &&
		/(?:^|[\\/])signet\.js$/.test(launcher.args[0] ?? "")
	);
}

export function readMcpLauncher(value: unknown): ResolvedCommand | undefined {
	if (!isJsonObject(value) || typeof value.command !== "string" || !value.command) return undefined;
	const args = value.args ?? [];
	if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) return undefined;
	const env: Record<string, string> = {};
	if (isJsonObject(value.env)) {
		for (const [key, val] of Object.entries(value.env)) {
			if (typeof val === "string" && key !== "SIGNET_API_KEY" && key !== "SIGNET_TOKEN") env[key] = val;
		}
	}
	const launcher = { command: value.command, args, ...(Object.keys(env).length ? { env } : {}) };
	const name = win32.basename(launcher.command);
	if (/^signet-mcp(?:\.exe)?$/i.test(name)) return launcher;
	if (/^signet(?:\.(?:exe|cmd|bat|ps1))?$/i.test(name) && env.SIGNET_MCP_STDIO_WORKER === "1") return launcher;
	if (
		/^(?:node|bun)(?:\.exe)?$/i.test(name) &&
		args.length === 1 &&
		/(?:^|[\\/])(?:dist[\\/]mcp-stdio|signet)\.js$/.test(args[0] ?? "")
	)
		return launcher;
	return undefined;
}

function override(): ResolvedCommand | undefined {
	const value = process.env.SIGNET_HOOK_COMMAND?.trim();
	if (!value) {
		const command = readManagedTrimmedEnv("SIGNET_CLI_PATH");
		return command ? { command, args: [] } : undefined;
	}
	const message =
		"SIGNET_HOOK_COMMAND must be an executable path without whitespace or a nonempty JSON argv array of command and arguments";
	if (!value.startsWith("[")) {
		if (/\s/.test(value)) throw new Error(message);
		return { command: value, args: [] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(message);
	}
	if (!Array.isArray(parsed) || !parsed.every((arg): arg is string => typeof arg === "string") || !parsed[0]?.trim()) {
		throw new Error(message);
	}
	return { command: parsed[0], args: parsed.slice(1) };
}

export function cliFromMcp(launcher: ResolvedCommand | undefined): ResolvedCommand | undefined {
	if (!launcher) return undefined;
	if (
		isSignetCliLauncher(launcher) &&
		(launcher.env?.SIGNET_MCP_STDIO_WORKER === "1" ||
			/^(?:node|bun)(?:\.exe)?$/i.test(win32.basename(launcher.command)))
	) {
		return { command: launcher.command, args: launcher.args };
	}
	if (/^signet-mcp(?:\.exe)?$/i.test(win32.basename(launcher.command))) {
		const cli = { command: launcher.command.replace(/signet-mcp(\.exe)?$/i, "signet$1"), args: launcher.args };
		return isSignetCliLauncher(cli) ? cli : undefined;
	}
	if (launcher.args.length !== 1 || !/(?:^|[\\/])dist[\\/]mcp-stdio\.js$/.test(launcher.args[0] ?? ""))
		return undefined;
	const cli = {
		command: launcher.command,
		args: launcher.args.map((arg) => arg.replace(/dist[\\/]mcp-stdio\.js$/, "bin/signet.js")),
	};
	return isSignetCliLauncher(cli) ? cli : undefined;
}

export function mcpFromCli(launcher: ResolvedCommand | undefined): ResolvedCommand | undefined {
	if (!launcher) return undefined;
	const script = launcher.args.findIndex((arg) => /(?:^|[\\/])signet\.js$/.test(arg));
	if (script >= 0 && /(?:^|[\\/])bin[\\/]signet\.js$/.test(launcher.args[script] ?? ""))
		return {
			command: launcher.command,
			args: launcher.args.map((arg, i) =>
				i === script ? arg.replace(/bin[\\/]signet\.js$/, "dist/mcp-stdio.js") : arg,
			),
		};
	return { ...launcher, env: { ...launcher.env, SIGNET_MCP_STDIO_WORKER: "1" } };
}

function discover(mcp: boolean, runtime?: string | null): ResolvedCommand {
	const roots = [readManagedTrimmedEnv("SIGNET_WRAPPER_DIR"), readManagedTrimmedEnv("SIGNET_DIR")].filter(
		(root): root is string => Boolean(root),
	);
	const entries = [
		...roots.map((root) => join(root, "bin", "signet.js")),
		process.argv[1],
		join(dirname(process.execPath), "..", "bin", "signet.js"),
	];
	const entry = entries.find((path) => path && win32.basename(path) === "signet.js" && isExistingFile(path));
	const script = entry ? (mcp ? join(dirname(entry), "..", "dist", "mcp-stdio.js") : entry) : undefined;
	const host =
		runtime ?? (/^(?:node|bun)(?:\.exe)?$/i.test(win32.basename(process.execPath)) ? process.execPath : undefined);
	if (host && script && isExistingFile(script)) return { command: host, args: [script] };
	const name = process.platform === "win32" ? "signet.exe" : "signet";
	const candidates = [
		...roots.flatMap((root) => [join(root, "native", name), join(root, "bin", name)]),
		process.execPath,
	];
	const native = candidates.find((path) => /^signet(?:\.exe)?$/i.test(win32.basename(path)) && isExistingFile(path));
	if (native) return { command: native, args: [], ...(mcp ? { env: { SIGNET_MCP_STDIO_WORKER: "1" } } : {}) };
	if (mcp && process.platform === "win32")
		console.warn(
			`[signet] Warning: could not resolve mcp-stdio.js from argv[1]="${process.argv[1] ?? ""}". MCP server config will use "signet-mcp" which may fail on Windows without shell:true.`,
		);
	return { command: mcp ? "signet-mcp" : "signet", args: [] };
}

function launcherPathStatus(path: string): "present" | "missing" | "unverified" {
	try {
		if (statSync(path, { throwIfNoEntry: false })) return "present";
	} catch {
		return "unverified";
	}
	const root = parse(path).root;
	const segments = path.slice(root.length).split(/[\\/]/).filter(Boolean);
	return isAbsolute(path) && segments.length >= 2 && existsSync(join(root, ...segments.slice(0, 2)))
		? "missing"
		: "unverified";
}

function reuseLauncher(existing: ResolvedCommand | undefined, mcp: boolean, runtime?: string | null): ResolvedCommand {
	if (!existing) return discover(mcp, runtime);
	const paths = [
		existing.command,
		...(/^(?:node|bun)(?:\.exe)?$/i.test(win32.basename(existing.command)) ? existing.args : []),
	];
	const statuses = paths.map((path, index) =>
		index === 0 && !/[\\/]/.test(path) ? "present" : launcherPathStatus(path),
	);
	if (statuses.includes("missing")) {
		const replacement = discover(mcp, runtime);
		console.warn(
			`[signet] Warning: stale launcher ${renderCommand(existing)} was replaced with ${renderCommand(replacement)}.`,
		);
		return replacement;
	}
	if (statuses.includes("unverified")) {
		console.warn(
			`[signet] Warning: launcher ${renderCommand(existing)} could not be verified from this environment; keeping it. Set SIGNET_HOOK_COMMAND to override it.`,
		);
	}
	return existing;
}

export function resolveSignetCliCommand(existing?: ResolvedCommand, runtime?: string | null): ResolvedCommand {
	return override() ?? reuseLauncher(isSignetCliLauncher(existing) ? existing : undefined, false, runtime);
}

export function resolveSignetMcpCommand(existing?: ResolvedCommand, runtime?: string | null): ResolvedCommand {
	const configured = override();
	if (configured) return mcpFromCli(configured) ?? configured;
	return reuseLauncher(readMcpLauncher(existing), true, runtime);
}
