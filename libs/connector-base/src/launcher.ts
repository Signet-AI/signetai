import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject, readManagedTrimmedEnv, type ResolvedCommand } from "./index";

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
			/^(?:(?:SIGNET_DAEMON_URL|SIGNET_API_KEY)=(?:'(?:[^']|'\\'')*'|"[^"]*"|\S+)\s+|set "(?:SIGNET_DAEMON_URL|SIGNET_API_KEY)=[^"]*" && )+/i,
			"",
		);
	const args: string[] = [];
	let value = "";
	let quote = "";
	let started = false;
	for (let i = 0; i < clean.length; i++) {
		const char = clean.charAt(i);
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
				return executable ? { command: executable, args } : undefined;
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
	if (/^signet(?:\.(?:exe|cmd|bat|ps1))?$/i.test(basename(launcher.command))) return true;
	return (
		/^(?:node|bun)(?:\.exe)?$/i.test(basename(launcher.command)) &&
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
	return { command: value.command, args, ...(Object.keys(env).length ? { env } : {}) };
}

function override(): ResolvedCommand | undefined {
	const command = readManagedTrimmedEnv("SIGNET_HOOK_COMMAND");
	if (!command) return undefined;
	if (!command.startsWith("[")) return { command, args: [] };
	const parsed: unknown = JSON.parse(command);
	if (!Array.isArray(parsed) || !parsed.every((arg): arg is string => typeof arg === "string") || !parsed[0]) {
		throw new Error("SIGNET_HOOK_COMMAND must be an executable path or a nonempty JSON array of command and arguments");
	}
	return { command: parsed[0], args: parsed.slice(1) };
}

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? "";
}

export function cliFromMcp(launcher: ResolvedCommand | undefined): ResolvedCommand | undefined {
	if (!launcher) return undefined;
	if (launcher.env?.SIGNET_MCP_STDIO_WORKER === "1") return { command: launcher.command, args: launcher.args };
	if (/signet-mcp(?:\.exe)?$/.test(launcher.command))
		return { command: launcher.command.replace(/signet-mcp/, "signet"), args: launcher.args };
	const script = launcher.args.findIndex((arg) => /dist[\\/]mcp-stdio\.js$/.test(arg));
	if (script < 0) return undefined;
	return {
		command: launcher.command,
		args: launcher.args.map((arg, i) => (i === script ? arg.replace(/dist[\\/]mcp-stdio\.js$/, "bin/signet.js") : arg)),
	};
}

export function mcpFromCli(launcher: ResolvedCommand | undefined): ResolvedCommand | undefined {
	if (!launcher) return undefined;
	const script = launcher.args.findIndex((arg) => /(?:^|[\\/])signet\.js$/.test(arg));
	if (script >= 0)
		return {
			command: launcher.command,
			args: launcher.args.map((arg, i) =>
				i === script ? arg.replace(/bin[\\/]signet\.js$/, "dist/mcp-stdio.js") : arg,
			),
		};
	return { ...launcher, env: { ...launcher.env, SIGNET_MCP_STDIO_WORKER: "1" } };
}

function file(path: string | undefined): path is string {
	if (!path) return false;
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function discover(mcp: boolean, runtime?: string | null): ResolvedCommand {
	const explicit = readManagedTrimmedEnv("SIGNET_CLI_PATH");
	if (file(explicit)) return { command: explicit, args: [], ...(mcp ? { env: { SIGNET_MCP_STDIO_WORKER: "1" } } : {}) };
	const roots = [readManagedTrimmedEnv("SIGNET_WRAPPER_DIR"), readManagedTrimmedEnv("SIGNET_DIR")].filter(
		(root): root is string => Boolean(root),
	);
	const entries = [
		...roots.map((root) => join(root, "bin", "signet.js")),
		process.argv[1],
		join(dirname(process.execPath), "..", "bin", "signet.js"),
	];
	const entry = entries.find((path) => path && basename(path) === "signet.js" && file(path));
	const script = entry ? (mcp ? join(dirname(entry), "..", "dist", "mcp-stdio.js") : entry) : undefined;
	const host = runtime ?? (/^(?:node|bun)(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : undefined);
	if (host && script && existsSync(script)) return { command: host, args: [script] };
	const name = process.platform === "win32" ? "signet.exe" : "signet";
	const candidates = [
		...roots.flatMap((root) => [join(root, "native", name), join(root, "bin", name)]),
		process.execPath,
	];
	const native = candidates.find((path) => /^signet(?:\.exe)?$/i.test(basename(path)) && file(path));
	if (native) return { command: native, args: [], ...(mcp ? { env: { SIGNET_MCP_STDIO_WORKER: "1" } } : {}) };
	if (mcp && process.platform === "win32")
		console.warn(
			`[signet] Warning: could not resolve mcp-stdio.js from argv[1]="${process.argv[1] ?? ""}". MCP server config will use "signet-mcp" which may fail on Windows without shell:true.`,
		);
	return { command: mcp ? "signet-mcp" : "signet", args: [] };
}

export function resolveSignetCliCommand(existing?: ResolvedCommand, runtime?: string | null): ResolvedCommand {
	return override() ?? existing ?? discover(false, runtime);
}

export function resolveSignetMcpCommand(existing?: ResolvedCommand, runtime?: string | null): ResolvedCommand {
	const configured = override();
	if (configured) return mcpFromCli(configured) ?? configured;
	return existing ?? discover(true, runtime);
}
