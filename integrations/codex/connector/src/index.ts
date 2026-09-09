import { spawnSyncHidden as spawnSync } from "@signet/core";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	opendirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
	type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import {
	BaseConnector,
	type InstallResult,
	type UninstallResult,
	atomicWriteJson,
	readTrimmedEnv,
	resolveRemoteDaemonUrl,
	resolveSignetApiKey,
	resolveSignetCliCommand,
	resolveSignetMcpCommand,
} from "@signet/connector-base";
import { expandHome, resolvePromptSubmitTimeoutMs, resolveSessionStartTimeoutMs } from "@signet/core";

export type SignetMcpConfig =
	| {
			readonly command: string;
			readonly args: readonly string[];
			readonly env?: Readonly<Record<string, string>>;
	  }
	| {
			readonly url: string;
			readonly startupTimeoutSec: number;
			readonly toolTimeoutSec: number;
			readonly httpHeaders?: Readonly<Record<string, string>>;
	  };

const CODEX_PLUGIN_MARKETPLACE_NAME = "signet-local";
const CODEX_PLUGIN_NAME = "signet";
const CODEX_PLUGIN_CONFIG_NAME = `${CODEX_PLUGIN_NAME}@${CODEX_PLUGIN_MARKETPLACE_NAME}`;
const CODEX_PLUGIN_VERSION = "0.1.0";
const CODEX_PLUGIN_DESCRIPTION =
	"Connect Codex to the local Signet substrate for source-backed recall, sessions, ontology, skills, and scoped note capture.";
const CODEX_PLUGIN_INTERFACE = {
	displayName: "Signet",
	shortDescription: "Source-backed recall and continuity for Codex",
	longDescription:
		"Signet connects Codex to local source-backed memory, transcript search, ontology, and explicit note capture without replacing Codex native memory.",
	developerName: "Signet",
	category: "Coding",
	capabilities: ["Read", "Write"],
	websiteURL: "https://github.com/Signet-AI/signetai",
	defaultPrompt: ["Recall prior Signet context for this repo"],
	brandColor: "#2563EB",
} as const;
const CODEX_PLUGIN_KEYWORDS = ["signet", "recall", "sources", "sessions", "ontology", "codex"] as const;

interface CodexPluginBundleFile {
	readonly relativePath: string;
	readonly content: string;
}

interface CodexPluginBundleResult {
	readonly marketplaceRoot: string;
	readonly pluginRoot: string;
	readonly filesWritten: readonly string[];
}

interface NativePluginCommandResult {
	readonly success: boolean;
	readonly filesWritten: readonly string[];
	readonly warning?: string;
}

// ---------------------------------------------------------------------------
// Signet command resolution
// ---------------------------------------------------------------------------

/** Resolve the packaged Signet entry used by the compiled CLI.
 *
 * Bun-compiled binaries expose a virtual bunfs path in argv[1], so it cannot be
 * used to locate the installed package. The npm wrapper passes its package root
 * explicitly because it can launch an optional-dependency binary outside that
 * package when postinstall did not link a local native binary. */
function resolveSignetEntry(): string | null {
	const wrapperDir = readTrimmedEnv("SIGNET_WRAPPER_DIR") ?? readTrimmedEnv("SIGNET_DIR");
	const candidates = [
		wrapperDir ? join(wrapperDir, "bin", "signet.js") : null,
		join(dirname(process.execPath), "..", "bin", "signet.js"),
		process.argv[1],
	];
	for (const entry of candidates) {
		if (entry && basename(entry) === "signet.js" && existsSync(entry)) return entry;
	}
	return null;
}

function isExistingFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isScriptRuntime(path: string): boolean {
	if (!isExistingFile(path)) return false;
	return /^(?:node|bun)(?:\.exe)?$/i.test(basename(path));
}

function isNativeSignetBinary(path: string): boolean {
	if (!isExistingFile(path)) return false;
	return /^(?:signet|signet\.exe)$/i.test(basename(path));
}

function resolveSignetNativeBinary(): string | null {
	const wrapperDir = readTrimmedEnv("SIGNET_WRAPPER_DIR");
	const signetDir = readTrimmedEnv("SIGNET_DIR");
	const binaryName = process.platform === "win32" ? "signet.exe" : "signet";
	const roots = [...new Set([wrapperDir, signetDir].filter((root): root is string => Boolean(root)))];
	const candidates = [
		readTrimmedEnv("SIGNET_CLI_PATH"),
		process.execPath,
		...roots.flatMap((root) => [join(root, "native", binaryName), join(root, "bin", binaryName)]),
	];
	for (const candidate of candidates) {
		if (candidate && isNativeSignetBinary(candidate)) return candidate;
	}
	return null;
}

function resolveSignetArgs(runtime: string | null = null): string[] {
	const explicitCli = readTrimmedEnv("SIGNET_CLI_PATH");
	if (explicitCli && isExistingFile(explicitCli)) return [explicitCli];
	const entry = resolveSignetEntry();
	const scriptRuntime = runtime ?? (isScriptRuntime(process.execPath) ? process.execPath : null);
	if (scriptRuntime && entry) return [scriptRuntime, entry];
	const nativeBinary = resolveSignetNativeBinary();
	if (nativeBinary) return [nativeBinary];
	const resolved = resolveSignetCliCommand();
	return [resolved.command, ...resolved.args];
}

/** Resolve signet-mcp as { command, args } for Codex config.toml.
 *  Codex expects `command` as a string and `args` as a separate array. */
function resolveSignetMcp(runtime: string | null = null): SignetMcpConfig {
	const remoteDaemonUrl = resolveRemoteDaemonUrl();
	if (remoteDaemonUrl) {
		const apiKey = readAuthTokenEnv();
		return {
			url: `${remoteDaemonUrl}/mcp`,
			startupTimeoutSec: 10,
			toolTimeoutSec: 30,
			...(apiKey ? { httpHeaders: { Authorization: `Bearer ${apiKey}` } } : {}),
		};
	}
	const entry = resolveSignetEntry();
	const mcpEntry = entry ? join(dirname(entry), "..", "dist", "mcp-stdio.js") : null;
	const scriptRuntime = runtime ?? (isScriptRuntime(process.execPath) ? process.execPath : null);
	if (scriptRuntime && mcpEntry && existsSync(mcpEntry)) return { command: scriptRuntime, args: [mcpEntry] };
	const nativeBinary = resolveSignetNativeBinary();
	if (nativeBinary) {
		return { command: nativeBinary, args: [], env: { SIGNET_MCP_STDIO_WORKER: "1" } };
	}
	return resolveSignetMcpCommand();
}

const CODEX_RUNTIME_SCAN_DEPTH = 8;
const CODEX_RUNTIME_SCAN_ENTRY_LIMIT = 4_096;
const CODEX_PACKAGE_ROOT_SCAN_LIMIT = 4_096;
const CODEX_APP_PATH_LIMIT = 32;

function uniquePaths(paths: readonly (string | undefined)[]): string[] {
	return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}

function readBoundedDirectoryEntries(root: string, limit: number): Dirent[] {
	if (limit <= 0) return [];
	let directory: ReturnType<typeof opendirSync> | undefined;
	const entries: Dirent[] = [];
	try {
		directory = opendirSync(root);
		while (entries.length < limit) {
			const entry = directory.readSync();
			if (!entry) break;
			entries.push(entry);
		}
	} catch {
		return [];
	} finally {
		try {
			directory?.closeSync();
		} catch {
			// Ignore directories that disappear or become inaccessible during the scan.
		}
	}
	return entries;
}

let cachedWindowsAppxInstallRoots: string[] | undefined;

interface WindowsAppxQueryResult {
	readonly status: number | null;
	readonly stdout: string;
}

type WindowsAppxQuery = (command: string) => WindowsAppxQueryResult;

const WINDOWS_APPX_DISCOVERY_COMMAND =
	"Get-AppxPackage | Where-Object { $_.Name -eq 'OpenAI.Codex' -or $_.Name -eq 'OpenAI.ChatGPT' -or $_.Name -eq 'OpenAI.ChatGPT-Desktop' } | ForEach-Object { $_.InstallLocation }";

export function resolveWindowsAppxInstallRoots(
	platform: NodeJS.Platform = process.platform,
	query?: WindowsAppxQuery,
): string[] {
	if (platform !== "win32") return [];
	if (!query && cachedWindowsAppxInstallRoots !== undefined) return cachedWindowsAppxInstallRoots;
	try {
		const result = query
			? query(WINDOWS_APPX_DISCOVERY_COMMAND)
			: spawnSync(
					"powershell.exe",
					["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_APPX_DISCOVERY_COMMAND],
					{ encoding: "utf-8", timeout: 5_000 },
				);
		if (result.status !== 0) return query ? [] : (cachedWindowsAppxInstallRoots = []);
		const roots = uniquePaths(result.stdout.split(/\r?\n/).map((path) => path.trim())).slice(0, CODEX_APP_PATH_LIMIT);
		return query ? roots : (cachedWindowsAppxInstallRoots = roots);
	} catch {
		return query ? [] : (cachedWindowsAppxInstallRoots = []);
	}
}

function defaultCodexDesktopAppPaths(platform: NodeJS.Platform = process.platform): readonly string[] {
	const overrides = [readTrimmedEnv("CODEX_APP_PATH"), readTrimmedEnv("CHATGPT_APP_PATH")];
	if (platform === "win32") {
		const localAppData = readTrimmedEnv("LOCALAPPDATA") ?? join(homedir(), "AppData", "Local");
		const programFiles = readTrimmedEnv("PROGRAMFILES");
		const programFilesX86 = readTrimmedEnv("PROGRAMFILES(X86)");
		return uniquePaths([
			...overrides,
			...resolveWindowsAppxInstallRoots(platform),
			join(localAppData, "Programs", "OpenAI", "Codex"),
			join(localAppData, "Programs", "OpenAI", "ChatGPT"),
			join(localAppData, "OpenAI", "Codex"),
			join(localAppData, "OpenAI", "ChatGPT"),
			programFiles ? join(programFiles, "OpenAI", "Codex") : undefined,
			programFiles ? join(programFiles, "OpenAI", "ChatGPT") : undefined,
			programFilesX86 ? join(programFilesX86, "OpenAI", "Codex") : undefined,
			programFilesX86 ? join(programFilesX86, "OpenAI", "ChatGPT") : undefined,
			programFiles ? join(programFiles, "WindowsApps") : undefined,
			programFilesX86 ? join(programFilesX86, "WindowsApps") : undefined,
			join(localAppData, "Packages"),
		]);
	}
	if (platform === "linux") {
		return uniquePaths([
			...overrides,
			"/usr/lib/chatgpt",
			"/opt/chatgpt",
			"/usr/local/lib/chatgpt",
			join(homedir(), ".local", "share", "chatgpt"),
			join(homedir(), ".local", "lib", "chatgpt"),
			"/usr/lib/codex",
			"/opt/codex",
		]);
	}
	return uniquePaths([
		...overrides,
		join(homedir(), "Applications", "Codex.app"),
		join(homedir(), "Applications", "ChatGPT.app"),
		"/Applications/Codex.app",
		"/Applications/ChatGPT.app",
	]);
}

function codexDesktopResourceRoots(appPath: string, platform: NodeJS.Platform): string[] {
	const isWindowsPackageParent = platform === "win32" && /[\\/]((?:windowsapps)|(?:packages))[\\/]*$/i.test(appPath);
	const roots =
		platform === "darwin"
			? [join(appPath, "Contents", "Resources")]
			: isWindowsPackageParent
				? []
				: [
						join(appPath, "resources"),
						join(appPath, "app"),
						join(appPath, "app", "resources"),
						join(appPath, "Contents", "Resources"),
						appPath,
					];
	if (isWindowsPackageParent) {
		for (const entry of readBoundedDirectoryEntries(appPath, CODEX_PACKAGE_ROOT_SCAN_LIMIT)) {
			if (entry.isDirectory() && /^OpenAI\.(?:Codex|ChatGPT)(?:[-_.]|$)/i.test(entry.name)) {
				const packageRoot = join(appPath, entry.name);
				roots.push(
					packageRoot,
					join(packageRoot, "resources"),
					join(packageRoot, "app"),
					join(packageRoot, "app", "resources"),
					join(packageRoot, "Contents", "Resources"),
				);
			}
		}
	}
	return uniquePaths(roots);
}

interface RuntimeScanBudget {
	remaining: number;
}

function codexDesktopExecutableCandidates(
	root: string,
	executableNames: ReadonlySet<string>,
	depth = 0,
	budget: RuntimeScanBudget = { remaining: CODEX_RUNTIME_SCAN_ENTRY_LIMIT },
): string[] {
	if (depth > CODEX_RUNTIME_SCAN_DEPTH || budget.remaining <= 0 || !existsSync(root)) return [];
	const candidates: string[] = [];
	const entries = readBoundedDirectoryEntries(root, budget.remaining);
	for (const entry of entries) {
		if (budget.remaining <= 0) break;
		budget.remaining -= 1;
		const path = join(root, entry.name);
		if ((entry.isFile() || entry.isSymbolicLink()) && executableNames.has(entry.name.toLowerCase()))
			candidates.push(path);
		try {
			if (!statSync(path).isDirectory()) continue;
			candidates.push(...codexDesktopExecutableCandidates(path, executableNames, depth + 1, budget));
		} catch {
			// Ignore broken symlinks and files that disappear while scanning.
		}
	}
	return candidates;
}

function codexDesktopNodeCandidates(
	root: string,
	depth = 0,
	platform: NodeJS.Platform = process.platform,
	budget: RuntimeScanBudget = { remaining: CODEX_RUNTIME_SCAN_ENTRY_LIMIT },
): string[] {
	const nodeNames = platform === "win32" ? new Set(["node", "node.exe"]) : new Set(["node"]);
	return codexDesktopExecutableCandidates(root, nodeNames, depth, budget);
}

function isUsableNodeRuntime(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		const result = spawnSync(path, ["--version"], { encoding: "utf-8", timeout: 5_000 });
		return result.status === 0 && /^v\d+\.\d+\.\d+/.test(result.stdout.trim());
	} catch {
		return false;
	}
}

export function resolveCodexDesktopNode(
	appPaths: readonly string[] = defaultCodexDesktopAppPaths(),
	validate: (path: string) => boolean = isUsableNodeRuntime,
	platform: NodeJS.Platform = process.platform,
): string | null {
	const seen = new Set<string>();
	for (const appPath of appPaths) {
		const budget: RuntimeScanBudget = { remaining: CODEX_RUNTIME_SCAN_ENTRY_LIMIT };
		const candidates = codexDesktopResourceRoots(appPath, platform).flatMap((root) =>
			codexDesktopNodeCandidates(root, 0, platform, budget),
		);
		for (const candidate of candidates) {
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			if (validate(candidate)) return candidate;
		}
	}
	return null;
}

function codexDesktopCliCandidates(appPath: string, platform: NodeJS.Platform = process.platform): string[] {
	const executableNames = platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
	const names = new Set(executableNames);
	const budget: RuntimeScanBudget = { remaining: CODEX_RUNTIME_SCAN_ENTRY_LIMIT };
	return uniquePaths(
		codexDesktopResourceRoots(appPath, platform).flatMap((root) => [
			...executableNames.flatMap((name) => [join(root, name), join(root, "bin", name)]),
			...codexDesktopExecutableCandidates(root, names, 0, budget),
		]),
	);
}

function pathExecutableCandidates(command: string, platform: NodeJS.Platform = process.platform): string[] {
	const commandNames =
		platform === "win32" ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command];
	const pathDelimiter = platform === "win32" ? ";" : delimiter;
	return (process.env.PATH ?? "")
		.split(pathDelimiter)
		.filter((directory) => directory.length > 0)
		.flatMap((directory) => commandNames.map((name) => join(directory, name)));
}

function isUsableCodexCli(path: string, platform: NodeJS.Platform = process.platform): boolean {
	if (!isExistingFile(path)) return false;
	try {
		const invocation = codexCommandInvocation(path, ["plugin", "--help"], platform);
		const result = spawnSync(invocation.command, invocation.args, {
			encoding: "utf-8",
			timeout: 5_000,
			env: invocation.env,
		});
		return result.status === 0 && `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().length > 0;
	} catch {
		return false;
	}
}

/** Resolve a plugin-capable Codex executable used for native plugin management.
 *
 * ChatGPT.app bundles the same Codex CLI used by the standalone Codex app,
 * but it is not guaranteed to be exposed as a shell command in every desktop
 * launch environment. Prefer an explicit override, then bundled app paths,
 * then the user's PATH so Work/Codex mode and the standalone CLI share one
 * install path.
 */
export function resolveCodexCli(
	appPaths: readonly string[] = defaultCodexDesktopAppPaths(),
	validate: (path: string) => boolean = isUsableCodexCli,
	platform: NodeJS.Platform = process.platform,
): string | null {
	const explicit = readTrimmedEnv("CODEX_CLI_PATH");
	const candidates = [
		explicit,
		...appPaths.flatMap((appPath) => codexDesktopCliCandidates(appPath, platform)),
		...pathExecutableCandidates("codex", platform),
	].filter((candidate): candidate is string => Boolean(candidate));
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		if (validate(candidate)) return candidate;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Codex plugin bundle generation
// ---------------------------------------------------------------------------

function codexPluginBundleFiles(
	signetArgs: readonly string[],
	mcp: SignetMcpConfig,
	remoteDaemonUrl: string | null,
	windowsHookCommand: string | null,
): CodexPluginBundleFile[] {
	const hookFile = buildHooksFile([...signetArgs], remoteDaemonUrl, windowsHookCommand);
	const mcpServer =
		"url" in mcp
			? {
					url: mcp.url,
					startup_timeout_sec: mcp.startupTimeoutSec,
					tool_timeout_sec: mcp.toolTimeoutSec,
					...(mcp.httpHeaders ? { http_headers: mcp.httpHeaders } : {}),
				}
			: {
					command: mcp.command,
					args: mcp.args,
					...(mcp.env ? { env: mcp.env } : {}),
				};
	const pluginMetadata = {
		name: CODEX_PLUGIN_NAME,
		version: CODEX_PLUGIN_VERSION,
		description: CODEX_PLUGIN_DESCRIPTION,
		author: { name: "Signet" },
		homepage: "https://github.com/Signet-AI/signetai",
		repository: "https://github.com/Signet-AI/signetai",
		license: "Apache-2.0",
		keywords: CODEX_PLUGIN_KEYWORDS,
	};
	return [
		{
			relativePath: ".agents/plugins/marketplace.json",
			content: `${JSON.stringify(
				{
					name: CODEX_PLUGIN_MARKETPLACE_NAME,
					interface: { displayName: "Signet Local" },
					plugins: [
						{
							name: CODEX_PLUGIN_NAME,
							source: { source: "local", path: `./plugins/${CODEX_PLUGIN_NAME}` },
							policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
							category: "Coding",
						},
					],
				},
				null,
				2,
			)}\n`,
		},
		{
			relativePath: `plugins/${CODEX_PLUGIN_NAME}/.codex-plugin/plugin.json`,
			content: `${JSON.stringify(
				{
					...pluginMetadata,
					skills: "./skills/",
					mcpServers: "./.mcp.json",
					interface: CODEX_PLUGIN_INTERFACE,
				},
				null,
				2,
			)}\n`,
		},
		{
			relativePath: `plugins/${CODEX_PLUGIN_NAME}/.mcp.json`,
			content: `${JSON.stringify({ mcpServers: { signet: mcpServer } }, null, 2)}\n`,
		},
		{
			relativePath: `plugins/${CODEX_PLUGIN_NAME}/hooks/hooks.json`,
			content: `${JSON.stringify(hookFile, null, 2)}\n`,
		},
		{
			relativePath: `plugins/${CODEX_PLUGIN_NAME}/skills/signet-recall/SKILL.md`,
			content: [
				"---",
				"name: signet-recall",
				"description: Use Signet-specific recall and source search from Codex without confusing it with Codex native memory.",
				"---",
				"",
				"# Signet Recall",
				"",
				"Use `signet_recall` for explicit Signet recall. Ask natural questions with an entity, event, and timeframe when possible. Use `signet_source_search` when the answer should come from source-backed artifacts rather than ordinary saved memories.",
				"",
				"Do not treat Codex native memory and Signet memory as competing stores. Codex native memory is a source that Signet can index with provenance.",
				"",
			].join("\n"),
		},
		{
			relativePath: `plugins/${CODEX_PLUGIN_NAME}/skills/signet-sessions/SKILL.md`,
			content: [
				"---",
				"name: signet-sessions",
				"description: Search Signet transcript/session evidence from Codex.",
				"---",
				"",
				"# Signet Sessions",
				"",
				"Use `signet_session_search` when prior transcript evidence matters. Keep transcript lookup separate from memory recall; do not fold session search into ordinary memory search.",
				"",
			].join("\n"),
		},
		{
			relativePath: `plugins/${CODEX_PLUGIN_NAME}/skills/signet-ontology/SKILL.md`,
			content: [
				"---",
				"name: signet-ontology",
				"description: Navigate Signet ontology and knowledge graph state from Codex.",
				"---",
				"",
				"# Signet Ontology",
				"",
				"Use Signet ontology tools for reviewed structured facts, claim history, entity dependencies, and graph hygiene. Raw Codex memory files are evidence, not ontology by themselves.",
				"",
			].join("\n"),
		},
		{
			relativePath: `plugins/${CODEX_PLUGIN_NAME}/skills/signet-save-note/SKILL.md`,
			content: [
				"---",
				"name: signet-save-note",
				"description: Save explicit notes into Codex native memory through Signet.",
				"---",
				"",
				"# Signet Save Note",
				"",
				"Use `signet_save_note` only for explicit durable notes. It writes small ad-hoc markdown notes under Codex native memory extensions and never edits Codex-generated `MEMORY.md` or `memory_summary.md`.",
				"",
			].join("\n"),
		},
	];
}

export function writeCodexPluginBundle(input: {
	readonly codexHome: string;
	readonly signetArgs?: readonly string[];
	readonly mcp?: SignetMcpConfig;
	readonly remoteDaemonUrl?: string | null;
	readonly windowsHookCommand?: string | null;
}): CodexPluginBundleResult {
	const marketplaceRoot = join(input.codexHome, ".tmp", "signet-plugin-marketplace");
	const pluginRoot = join(marketplaceRoot, "plugins", CODEX_PLUGIN_NAME);
	const filesWritten: string[] = [];
	const signetArgs = input.signetArgs ?? resolveSignetArgs();
	const remoteDaemonUrl = input.remoteDaemonUrl ?? resolveRemoteDaemonUrl();
	const windowsHookCommand =
		input.windowsHookCommand === undefined
			? writeWindowsHookWrapper(input.codexHome, signetArgs, remoteDaemonUrl)
			: input.windowsHookCommand;
	for (const file of codexPluginBundleFiles(
		signetArgs,
		input.mcp ?? resolveSignetMcp(),
		remoteDaemonUrl,
		windowsHookCommand,
	)) {
		const path = join(marketplaceRoot, file.relativePath);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, file.content, "utf-8");
		filesWritten.push(path);
	}
	if (windowsHookCommand && !filesWritten.includes(windowsHookCommand)) filesWritten.push(windowsHookCommand);
	return { marketplaceRoot, pluginRoot, filesWritten };
}

// ---------------------------------------------------------------------------
// hooks.json management
//
// Codex expects hooks.json with this shape (from codex-rs/hooks/src/engine/config.rs):
//
//   {
//     "hooks": {
//       "SessionStart": [{ "hooks": [{ "type": "command", "command": "...", "timeout": N }] }],
//       "UserPromptSubmit": [...],
//       "PreToolUse": [...],
//       "Stop": [...]
//     }
//   }
//
// Event names are PascalCase. Inner handler arrays use "hooks" (not "handlers").
// Each handler is a tagged union with "type": "command" and "command" as a string.
// ---------------------------------------------------------------------------

const HOOK_EVENT_KEYS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"] as const;
const CODEX_SESSION_START_GRACE_SECONDS = 5;
const CODEX_PROMPT_SUBMIT_GRACE_SECONDS = 2;
const SESSION_END_TIMEOUT_SECONDS = 30;
const NOTIFICATION_HOOK_TIMEOUT_SECONDS = 5;

interface MatcherGroup {
	matcher?: string;
	hooks: HandlerConfig[];
}

interface HandlerConfig {
	type: "command";
	command: string;
	commandWindows?: string;
	timeout?: number;
}

interface HooksFile {
	description?: string;
	hooks?: Record<string, MatcherGroup[]>;
	[key: string]: unknown;
}

interface HookTrustEntry {
	readonly key: string;
	readonly trustedHash: string;
}

function readTimeoutEnv(name: string): string {
	const value = process.env[name];
	return typeof value === "string" ? value.trim() : "";
}

function resolveCodexSessionStartTimeoutSeconds(): number {
	const raw = readTimeoutEnv("SIGNET_SESSION_START_TIMEOUT") || readTimeoutEnv("SIGNET_FETCH_TIMEOUT");
	return Math.ceil(resolveSessionStartTimeoutMs(raw) / 1000) + CODEX_SESSION_START_GRACE_SECONDS;
}

function resolveCodexPromptSubmitTimeoutSeconds(): number {
	return (
		Math.ceil(resolvePromptSubmitTimeoutMs(readTimeoutEnv("SIGNET_PROMPT_SUBMIT_TIMEOUT")) / 1000) +
		CODEX_PROMPT_SUBMIT_GRACE_SECONDS
	);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellCommandArg(value: string, platform: NodeJS.Platform = process.platform): string {
	if (/^[A-Za-z0-9_./\\:@+=,-]+$/.test(value)) return value;
	if (platform === "win32") {
		const escaped = value.replace(/[%^&|<>!"]/g, (character) => {
			if (character === "%") return "%%";
			if (character === "!") return "^!";
			if (character === '"') return '^"';
			return `^${character}`;
		});
		return `"${escaped}"`;
	}
	return shellQuote(value);
}

function cmdEnvQuote(value: string): string {
	return value.replace(/[%^"&|<>!]/g, (character) => {
		if (character === "%") return "%%";
		if (character === "!") return "^!";
		return `^${character}`;
	});
}

function windowsBatchArg(value: string): string {
	if (/^[A-Za-z0-9_./\\:@+=,-]+$/.test(value)) return value;
	return `"${cmdEnvQuote(value)}"`;
}

function windowsBatchEntrypoint(value: string): string {
	return /\.(?:cmd|bat)$/i.test(value) ? "call " : "";
}

function windowsCmdEnvironmentValue(value: string): string {
	if (value.includes('"')) throw new Error("Windows command arguments cannot contain double quotes");
	return `"${value}"`;
}

interface CodexCommandInvocation {
	readonly command: string;
	readonly args: string[];
	readonly env: NodeJS.ProcessEnv;
}

function codexCommandInvocation(
	command: string,
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
	environment: NodeJS.ProcessEnv = process.env,
): CodexCommandInvocation {
	if (platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
		// Keep user-controlled paths and arguments out of cmd.exe's command string.
		// The quoted environment values survive cmd.exe expansion without Node's
		// Windows argument quoting turning embedded quotes into backslashes.
		const commandVariable = "SIGNET_CODEX_SHIM_COMMAND";
		const env: NodeJS.ProcessEnv = {
			...environment,
			[commandVariable]: windowsCmdEnvironmentValue(command),
		};
		const invocationArgs = ["/d", "/v:off", "/s", "/c", `%SIGNET_CODEX_SHIM_COMMAND%`];
		for (const [index, arg] of args.entries()) {
			const argumentVariable = `SIGNET_CODEX_SHIM_ARG_${index}`;
			env[argumentVariable] = windowsCmdEnvironmentValue(arg);
			invocationArgs.push(`%${argumentVariable}%`);
		}
		return {
			command: "cmd.exe",
			args: invocationArgs,
			env,
		};
	}
	return { command, args: [...args], env: environment };
}

function readAuthTokenEnv(): string | undefined {
	return resolveSignetApiKey();
}

function withRemoteDaemonEnv(
	command: string,
	remoteDaemonUrl: string | null,
	platform: NodeJS.Platform = process.platform,
): string {
	const apiKey = readAuthTokenEnv();
	if (!remoteDaemonUrl && !apiKey) return command;
	if (platform === "win32") {
		const vars = [
			...(remoteDaemonUrl ? [`set "SIGNET_DAEMON_URL=${cmdEnvQuote(remoteDaemonUrl)}"`] : []),
			...(apiKey ? [`set "SIGNET_API_KEY=${cmdEnvQuote(apiKey)}"`] : []),
		];
		return `${vars.join(" && ")} && ${command}`;
	}
	return [
		...(remoteDaemonUrl ? [`SIGNET_DAEMON_URL=${shellQuote(remoteDaemonUrl)}`] : []),
		...(apiKey ? [`SIGNET_API_KEY=${shellQuote(apiKey)}`] : []),
		command,
	].join(" ");
}

function writeWindowsHookWrapper(
	codexHome: string,
	signetArgs: readonly string[],
	remoteDaemonUrl: string | null,
): string | null {
	if (process.platform !== "win32") return null;

	const apiKey = readAuthTokenEnv();
	const wrapperRoot = join(codexHome, ".tmp", "signet-plugin-marketplace", "runtime");
	const identity = JSON.stringify({ signetArgs, remoteDaemonUrl });
	const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
	const wrapperPath = join(wrapperRoot, `signet-codex-hook-${digest}.cmd`);
	mkdirSync(wrapperRoot, { recursive: true });
	try {
		for (const entry of readdirSync(wrapperRoot, { withFileTypes: true })) {
			if (
				entry.isFile() &&
				/^signet-codex-hook-[0-9a-f]{16}\.cmd$/i.test(entry.name) &&
				entry.name !== basename(wrapperPath)
			) {
				rmSync(join(wrapperRoot, entry.name), { force: true });
			}
		}
	} catch {
		// The current wrapper is still usable if an older generated wrapper cannot be removed.
	}

	const lines = ["@echo off", "setlocal"];
	if (remoteDaemonUrl) lines.push(`set "SIGNET_DAEMON_URL=${cmdEnvQuote(remoteDaemonUrl)}"`);
	if (apiKey) lines.push(`set "SIGNET_API_KEY=${cmdEnvQuote(apiKey)}"`);
	const invocation = signetArgs.map(windowsBatchArg).join(" ");
	lines.push(`${windowsBatchEntrypoint(signetArgs[0] ?? "")}${invocation} %*`);
	lines.push("exit /b %ERRORLEVEL%", "");
	writeFileSync(wrapperPath, `${lines.join("\r\n")}`, "utf-8");
	return wrapperPath;
}

export function buildHooksFile(
	signetArgs: string[],
	remoteDaemonUrl: string | null = resolveRemoteDaemonUrl(),
	windowsHookCommand: string | null = null,
	platform: NodeJS.Platform = process.platform,
): HooksFile {
	const cmd = (subcommand: string, secs: number, codexJson = true, extraArgs: readonly string[] = []): MatcherGroup => {
		const hookArgs = ["hook", subcommand, "-H", "codex", ...extraArgs, ...(codexJson ? ["--codex-json"] : [])];
		const args = [...signetArgs, ...hookArgs];
		const command = withRemoteDaemonEnv(
			args.map((arg) => shellCommandArg(arg, platform)).join(" "),
			remoteDaemonUrl,
			platform,
		);
		const commandWindows =
			platform === "win32"
				? windowsHookCommand
					? [
							shellCommandArg(windowsHookCommand, "win32"),
							...hookArgs.map((arg) => shellCommandArg(arg, "win32")),
						].join(" ")
					: withRemoteDaemonEnv(args.map((arg) => shellCommandArg(arg, "win32")).join(" "), remoteDaemonUrl, "win32")
				: undefined;
		return {
			hooks: [
				{
					type: "command",
					command,
					...(commandWindows ? { commandWindows } : {}),
					timeout: secs,
				},
			],
		};
	};
	return {
		hooks: {
			SessionStart: [cmd("session-start", resolveCodexSessionStartTimeoutSeconds())],
			UserPromptSubmit: [cmd("user-prompt-submit", resolveCodexPromptSubmitTimeoutSeconds())],
			PreToolUse: [cmd("notifications", NOTIFICATION_HOOK_TIMEOUT_SECONDS, true, ["--hook", "PreToolUse"])],
			Stop: [cmd("session-end", SESSION_END_TIMEOUT_SECONDS, false)],
		},
	};
}

function readHooksFile(path: string): HooksFile | null {
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as HooksFile;
	} catch {
		return null;
	}
}

function hasLegacySignetMarker(file: HooksFile): boolean {
	return Object.hasOwn(file, "_signet");
}

function writeHooksFile(path: string, file: HooksFile): void {
	mkdirSync(join(path, ".."), { recursive: true });
	atomicWriteJson(path, file);
}

const SIGNET_HOOK_SUBCOMMANDS = ["session-start", "user-prompt-submit", "notifications", "session-end"] as const;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSignetHookCommand(cmd: string): boolean {
	let normalized = cmd.trim().replace(/\s+/g, " ");
	for (let i = 0; i < 2; i++) {
		normalized = normalized.replace(/^(?:SIGNET_DAEMON_URL|SIGNET_API_KEY)=(?:'[^']*'|"[^"]*"|\S+)\s+/i, "");
		normalized = normalized.replace(/^set "(?:SIGNET_DAEMON_URL|SIGNET_API_KEY)=[^"]*" && /i, "");
	}
	return SIGNET_HOOK_SUBCOMMANDS.some((subcommand) => {
		const hook = `hook\\s+${escapeRegExp(subcommand)}\\b`;
		const bare = new RegExp(`^(?:signet|signet\\.(?:cmd|ps1|bat|exe))\\s+${hook}`, "i");
		if (bare.test(normalized)) return true;

		const quotedBare = new RegExp(`^["'][^"']*[\\\\/]signet(?:\\.(?:cmd|ps1|bat|exe))?["']\\s+${hook}`, "i");
		if (quotedBare.test(normalized)) return true;

		const absoluteBinary = new RegExp(`^(?:[^\\s"']*[\\\\/]signet(?:\\.(?:cmd|ps1|bat|exe))?)\\s+${hook}`, "i");
		if (absoluteBinary.test(normalized)) return true;

		const windowsWrapper = new RegExp(
			`^(?:"[^"]*[\\\\/]signet-codex-hook-[^"]+\\.cmd"|'[^']*[\\\\/]signet-codex-hook-[^']+\\.cmd'|\\S*[\\\\/]signet-codex-hook-[^\\s]+\\.cmd)\\s+${hook}`,
			"i",
		);
		if (windowsWrapper.test(normalized)) return true;

		const nodeShim = new RegExp(
			`^(?:"[^"]*[\\\\/]?node(?:\\.exe)?"|'[^']*[\\\\/]?node(?:\\.exe)?'|\\S*[\\\\/]?node(?:\\.exe)?)\\s+(?:"[^"]*[\\\\/]signet\\.js"|'[^']*[\\\\/]signet\\.js'|\\S*[\\\\/]signet\\.js)\\s+${hook}`,
			"i",
		);
		return nodeShim.test(normalized);
	});
}

function isSignetHookHandler(handler: unknown): handler is HandlerConfig {
	if (typeof handler !== "object" || handler === null) return false;
	const record = handler as Record<string, unknown>;
	return [record.command, record.commandWindows].some(
		(command): command is string => typeof command === "string" && isSignetHookCommand(command),
	);
}

function isLegacySignetHookHandler(handler: unknown): boolean {
	if (typeof handler !== "object" || handler === null) return false;
	const command = (handler as Record<string, unknown>).command;
	return Array.isArray(command) && isSignetHookCommand(command.join(" "));
}

function isSignetMatcherGroup(group: unknown): boolean {
	if (typeof group !== "object" || group === null) return false;
	const hooksArr = (group as Record<string, unknown>).hooks;
	if (!Array.isArray(hooksArr)) return false;
	return hooksArr.some(isSignetHookHandler);
}

function commandExecutable(command: string): string | null {
	let normalized = command.trim();
	for (let i = 0; i < 2; i++) {
		normalized = normalized.replace(/^(?:SIGNET_DAEMON_URL|SIGNET_API_KEY)=(?:'[^']*'|"[^"]*"|\S+)\s+/i, "");
		normalized = normalized.replace(/^set "(?:SIGNET_DAEMON_URL|SIGNET_API_KEY)=[^"]*" && /i, "");
	}
	const match = normalized.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
	return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function hasMissingRuntime(command: string): boolean {
	const executable = commandExecutable(command);
	return Boolean(executable && /[\\/]/.test(executable) && !existsSync(executable));
}

function hasMissingSignetRuntime(file: HooksFile | null, configPath: string): boolean {
	for (const groups of Object.values(file?.hooks ?? {})) {
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			if (typeof group !== "object" || group === null || !Array.isArray(group.hooks)) continue;
			for (const handler of group.hooks) {
				for (const command of [handler?.command, handler?.commandWindows]) {
					if (typeof command === "string" && isSignetHookCommand(command) && hasMissingRuntime(command)) {
						return true;
					}
				}
			}
		}
	}

	if (!existsSync(configPath)) return false;
	let inSignetMcpSection = false;
	for (const line of readFileSync(configPath, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "[mcp_servers.signet]") {
			inSignetMcpSection = true;
			continue;
		}
		if (inSignetMcpSection && trimmed.startsWith("[")) break;
		if (!inSignetMcpSection) continue;
		const command = trimmed.match(/^command\s*=\s*['"]([^'"]+)['"]/)?.[1];
		if (typeof command === "string") return hasMissingRuntime(command);
	}
	return false;
}

function isLegacySignetMatcherGroup(group: unknown): boolean {
	if (typeof group !== "object" || group === null) return false;
	const handlers = (group as Record<string, unknown>).handlers;
	if (!Array.isArray(handlers)) return false;
	return handlers.some(isLegacySignetHookHandler);
}

function removeSignetHandlersFromGroup(group: unknown): unknown | null {
	if (typeof group !== "object" || group === null) return group;
	const record = group as Record<string, unknown>;
	const hooks = Array.isArray(record.hooks) ? record.hooks : null;
	const legacyHandlers = Array.isArray(record.handlers) ? record.handlers : null;
	if (!hooks && !legacyHandlers && !Object.hasOwn(record, "_signet")) return group;

	const remainingHooks = hooks ? hooks.filter((handler) => !isSignetHookHandler(handler)) : null;
	const remainingLegacyHandlers = legacyHandlers
		? legacyHandlers.filter((handler) => !isLegacySignetHookHandler(handler))
		: null;
	if ((remainingHooks?.length ?? 0) + (remainingLegacyHandlers?.length ?? 0) === 0) return null;

	const { _signet: _legacyGroupMarker, ...withoutMarker } = record;
	if (hooks) withoutMarker.hooks = remainingHooks;
	if (legacyHandlers) withoutMarker.handlers = remainingLegacyHandlers;
	return withoutMarker as unknown as MatcherGroup;
}

function removeSignetEntries(file: HooksFile): HooksFile {
	const { _signet: _legacyMarker, ...withoutMarker } = file;
	const cleaned: HooksFile = { ...withoutMarker, hooks: file.hooks ? structuredClone(file.hooks) : undefined };
	const events = cleaned.hooks;
	if (!events || typeof events !== "object") return cleaned;

	for (const key of Object.keys(events)) {
		const groups = events[key];
		if (!Array.isArray(groups)) continue;
		const filtered = groups.map(removeSignetHandlersFromGroup).filter((group): group is MatcherGroup => group !== null);
		if (filtered.length === 0) {
			delete events[key];
		} else {
			(events as Record<string, unknown>)[key] = filtered;
		}
	}

	if (Object.keys(events).length === 0) cleaned.hooks = undefined;
	return cleaned;
}

const CODEX_HOOK_EVENT_LABELS: Record<(typeof HOOK_EVENT_KEYS)[number], string> = {
	SessionStart: "session_start",
	UserPromptSubmit: "user_prompt_submit",
	PreToolUse: "pre_tool_use",
	Stop: "stop",
};

function canonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJson);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => [key, canonicalJson((value as Record<string, unknown>)[key])]),
	);
}

function codexHookHash(eventName: (typeof HOOK_EVENT_KEYS)[number], handler: HandlerConfig): string {
	const command = process.platform === "win32" ? (handler.commandWindows ?? handler.command) : handler.command;
	const identity = {
		event_name: CODEX_HOOK_EVENT_LABELS[eventName],
		hooks: [
			{
				type: "command",
				command,
				timeout: Math.max(handler.timeout ?? 600, 1),
				async: false,
			},
		],
	};
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(canonicalJson(identity)))
		.digest("hex")}`;
}

function buildHookTrustEntries(hooksPath: string, file: HooksFile): HookTrustEntry[] {
	const entries: HookTrustEntry[] = [];
	const events = file.hooks;
	if (!events || typeof events !== "object") return entries;

	for (const eventName of HOOK_EVENT_KEYS) {
		const groups = events[eventName] ?? [];
		for (const [groupIndex, group] of groups.entries()) {
			if (!isSignetMatcherGroup(group)) continue;
			for (const [handlerIndex, handler] of group.hooks.entries()) {
				if (!isSignetHookHandler(handler)) continue;
				entries.push({
					key: `${hooksPath}:${CODEX_HOOK_EVENT_LABELS[eventName]}:${groupIndex}:${handlerIndex}`,
					trustedHash: codexHookHash(eventName, handler),
				});
			}
		}
	}

	return entries;
}

function tomlDottedKeyQuote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function patchHookTrustState(path: string, entries: readonly HookTrustEntry[]): boolean {
	if (entries.length === 0 || !existsSync(path)) return false;

	const content = readFileSync(path, "utf-8");
	const lines = content.split("\n");
	const filtered: string[] = [];
	let skipping = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[hooks.state.") && trimmed.endsWith("]")) {
			skipping = entries.some((entry) => trimmed.includes(tomlDottedKeyQuote(entry.key)));
			if (skipping) continue;
		} else if (skipping && trimmed.startsWith("[") && trimmed.endsWith("]")) {
			skipping = false;
		}

		if (!skipping) filtered.push(line);
	}

	const existing = `${filtered
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
	const blocks = entries
		.map((entry) =>
			[
				`[hooks.state.${tomlDottedKeyQuote(entry.key)}]`,
				"enabled = true",
				`trusted_hash = ${tomlQuote(entry.trustedHash)}`,
			].join("\n"),
		)
		.join("\n\n");
	let updated = `${existing.trimEnd()}\n\n${blocks}\n`;
	if (content.includes("# Signet MCP server") && !updated.includes("# Signet MCP server")) {
		updated = updated.replace("[mcp_servers.signet]", "# Signet MCP server\n[mcp_servers.signet]");
	}
	if (updated === content) return false;
	writeFileSync(path, updated);
	return true;
}

function removeHookTrustState(path: string, entries: readonly HookTrustEntry[]): boolean {
	if (entries.length === 0 || !existsSync(path)) return false;

	const content = readFileSync(path, "utf-8");
	const lines = content.split("\n");
	const filtered: string[] = [];
	let skipping = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[hooks.state.") && trimmed.endsWith("]")) {
			skipping = entries.some((entry) => trimmed.includes(tomlDottedKeyQuote(entry.key)));
			if (skipping) continue;
		} else if (skipping && trimmed.startsWith("[") && trimmed.endsWith("]")) {
			skipping = false;
		}

		if (!skipping) filtered.push(line);
	}

	const updated = `${filtered
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
	if (updated === content) return false;
	writeFileSync(path, updated);
	return true;
}

function migrateLegacyHooksFile(file: HooksFile): HooksFile {
	const legacyKeys = ["sessionStart", "userPromptSubmit", "stop"] as const;
	const hasLegacy = legacyKeys.some(
		(k) =>
			Array.isArray((file as Record<string, unknown>)[k]) &&
			((file as Record<string, unknown>)[k] as unknown[]).some(isLegacySignetMatcherGroup),
	);
	if (!hasLegacy) return file;

	const migrated = structuredClone(file);
	for (const key of legacyKeys) delete migrated[key];
	return migrated;
}

// ---------------------------------------------------------------------------
// MCP server registration (config.toml)
// ---------------------------------------------------------------------------

function tomlQuote(s: string): string {
	// Use TOML literal strings (single-quoted) to avoid backslash escaping
	if (!s.includes("'")) return `'${s}'`;
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function tomlInlineArray(items: readonly string[]): string {
	return `[${items.map(tomlQuote).join(", ")}]`;
}

export function buildMcpBlock(mcp: SignetMcpConfig): string {
	if ("url" in mcp) {
		return [
			"# Signet MCP server",
			"[mcp_servers.signet]",
			`url = ${tomlQuote(mcp.url)}`,
			`startup_timeout_sec = ${mcp.startupTimeoutSec}`,
			`tool_timeout_sec = ${mcp.toolTimeoutSec}`,
			"",
			...(mcp.httpHeaders
				? [
						"[mcp_servers.signet.http_headers]",
						...Object.entries(mcp.httpHeaders).map(([key, value]) => `${key} = ${tomlQuote(value)}`),
						"",
					]
				: []),
		].join("\n");
	}
	let block = `# Signet MCP server\n[mcp_servers.signet]\ncommand = ${tomlQuote(mcp.command)}\n`;
	if (mcp.args.length > 0) {
		block += `args = ${tomlInlineArray(mcp.args)}\n`;
	}
	if (mcp.env && Object.keys(mcp.env).length > 0) {
		block += `\n[mcp_servers.signet.env]\n`;
		block += Object.entries(mcp.env)
			.map(([key, value]) => `${key} = ${tomlQuote(value)}`)
			.join("\n");
		block += "\n";
	}
	return block;
}

function patchConfigToml(path: string, mcp: SignetMcpConfig): boolean {
	const dir = join(path, "..");
	mkdirSync(dir, { recursive: true });

	const block = buildMcpBlock(mcp);

	if (!existsSync(path)) {
		writeFileSync(path, block);
		return true;
	}

	const content = readFileSync(path, "utf-8");

	if (!content.includes("[mcp_servers.signet]")) {
		writeFileSync(path, `${content.trimEnd()}\n\n${block}`);
		return true;
	}

	// Section exists but may be stale (e.g. old array-format command).
	// Remove and re-add with correct format.
	unpatchConfigToml(path);
	const updated = existsSync(path) ? readFileSync(path, "utf-8").trim() : "";
	const prefix = updated.length > 0 ? `${updated}\n\n` : "";
	writeFileSync(path, prefix + block);
	return true;
}

function unpatchConfigToml(path: string): boolean {
	if (!existsSync(path)) return false;
	const content = readFileSync(path, "utf-8");
	if (!content.includes("[mcp_servers.signet]")) return false;

	// Remove the signet MCP block — handles both with and without comment
	const lines = content.split("\n");
	const filtered: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (line.trim() === "# Signet MCP server") continue;
		if (line.trim() === "[mcp_servers.signet]") {
			inSection = true;
			continue;
		}
		// Skip all lines belonging to the signet section and descendant child tables
		if (inSection) {
			if (line.match(/^\s*\[/)) {
				if (line.trim().startsWith("[mcp_servers.signet.")) {
					continue;
				}
				inSection = false;
			} else {
				continue;
			}
		}
		filtered.push(line);
	}
	writeFileSync(
		path,
		`${filtered
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd()}\n`,
	);
	return true;
}

function removeTomlSection(content: string, header: string): string {
	if (!content.includes(header)) return content;
	const sectionName = header.slice(1, -1);
	const lines = content.split("\n");
	const filtered: string[] = [];
	let inSection = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === header) {
			inSection = true;
			continue;
		}
		if (inSection && trimmed.startsWith("[") && trimmed.endsWith("]")) {
			const candidate = trimmed.slice(1, -1);
			if (candidate === sectionName || candidate.startsWith(`${sectionName}.`)) continue;
			inSection = false;
		}
		if (!inSection) filtered.push(line);
	}
	return `${filtered
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
}

function unpatchNativePluginConfig(path: string): boolean {
	if (!existsSync(path)) return false;
	const marketplaceHeader = `[marketplaces.${CODEX_PLUGIN_MARKETPLACE_NAME}]`;
	const pluginHeader = `[plugins."${CODEX_PLUGIN_CONFIG_NAME}"]`;
	const content = readFileSync(path, "utf-8");
	const updated = removeTomlSection(removeTomlSection(content, marketplaceHeader), pluginHeader);
	if (updated === content) return false;
	writeFileSync(path, updated);
	return true;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class CodexConnector extends BaseConnector {
	readonly name = "Codex";
	readonly harnessId = "codex";

	protected getCodexHome(): string {
		const configured = readTrimmedEnv("CODEX_HOME");
		return configured ? expandHome(configured) : join(homedir(), ".codex");
	}

	protected getCodexDesktopAppPaths(): readonly string[] {
		return defaultCodexDesktopAppPaths();
	}

	protected resolveCodexDesktopNode(): string | null {
		return resolveCodexDesktopNode(this.getCodexDesktopAppPaths());
	}

	protected resolveCodexCli(): string | null {
		return resolveCodexCli(this.getCodexDesktopAppPaths());
	}

	protected supportsNativePluginInstall(): boolean {
		if (readTrimmedEnv("SIGNET_CODEX_DISABLE_NATIVE_PLUGIN") === "1") return false;
		const codex = this.resolveCodexCli();
		if (!codex) return false;
		try {
			const env = { ...process.env, CODEX_HOME: this.getCodexHome() };
			const invocation = codexCommandInvocation(codex, ["plugin", "--help"], process.platform, env);
			const result = spawnSync(invocation.command, invocation.args, {
				stdio: "ignore",
				timeout: 15_000,
				env: invocation.env,
			});
			return result.status === 0 && !result.error;
		} catch {
			return false;
		}
	}

	protected nativePluginProvidesHooks(): boolean {
		return readTrimmedEnv("SIGNET_CODEX_FORCE_COMPAT_HOOKS") !== "1";
	}

	protected installNativePlugin(codexHome: string, marketplaceRoot: string): NativePluginCommandResult {
		const codex = this.resolveCodexCli();
		if (!codex) {
			return {
				success: false,
				filesWritten: [],
				warning: "Codex native plugin install skipped because no usable Codex executable was found",
			};
		}
		let marketplaceResult: ReturnType<typeof spawnSync> | null = null;
		let marketplaceError: unknown = null;
		try {
			const env = { ...process.env, CODEX_HOME: codexHome };
			const invocation = codexCommandInvocation(
				codex,
				["plugin", "marketplace", "add", marketplaceRoot],
				process.platform,
				env,
			);
			marketplaceResult = spawnSync(invocation.command, invocation.args, {
				encoding: "utf-8",
				timeout: 15_000,
				env: invocation.env,
			});
		} catch (error) {
			marketplaceError = error;
		}
		if (marketplaceError || !marketplaceResult) {
			return {
				success: false,
				filesWritten: [],
				warning: `Codex native plugin marketplace registration failed; falling back to compatibility hooks/MCP: ${String(marketplaceError ?? "command did not return a result")}`,
			};
		}
		const marketplaceOutput = `${marketplaceResult.stdout ?? ""}\n${marketplaceResult.stderr ?? ""}`;
		if (marketplaceResult.status !== 0 || marketplaceResult.error) {
			return {
				success: false,
				filesWritten: [],
				warning: `Codex native plugin marketplace registration failed; falling back to compatibility hooks/MCP: ${
					marketplaceResult.error?.message ?? (marketplaceOutput.trim() || "command timed out")
				}`,
			};
		}
		let result: ReturnType<typeof spawnSync> | null = null;
		let installError: unknown = null;
		try {
			const env = { ...process.env, CODEX_HOME: codexHome };
			const invocation = codexCommandInvocation(
				codex,
				["plugin", "add", CODEX_PLUGIN_CONFIG_NAME],
				process.platform,
				env,
			);
			result = spawnSync(invocation.command, invocation.args, {
				encoding: "utf-8",
				timeout: 15_000,
				env: invocation.env,
			});
		} catch (error) {
			installError = error;
		}
		if (installError || !result) {
			return {
				success: false,
				filesWritten: [],
				warning: `Codex native plugin install failed; falling back to compatibility hooks/MCP: ${String(installError ?? "command did not return a result")}`,
			};
		}
		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
		if (result.status !== 0 || result.error) {
			return {
				success: false,
				filesWritten: [],
				warning: `Codex native plugin install failed; falling back to compatibility hooks/MCP: ${
					result.error?.message ?? (output.trim() || "command timed out")
				}`,
			};
		}
		const installedRoot = output.match(/Installed plugin root:\s*(.+)/)?.[1]?.trim();
		return {
			success: true,
			filesWritten: installedRoot ? [installedRoot] : [],
		};
	}

	protected removeNativePlugin(codexHome: string): void {
		const codex = this.resolveCodexCli();
		if (!codex) return;
		const env = { ...process.env, CODEX_HOME: codexHome };
		const options = { stdio: "ignore" as const, timeout: 15_000 };
		try {
			const removePlugin = codexCommandInvocation(
				codex,
				["plugin", "remove", CODEX_PLUGIN_CONFIG_NAME],
				process.platform,
				env,
			);
			spawnSync(removePlugin.command, removePlugin.args, { ...options, env: removePlugin.env });
			const removeMarketplace = codexCommandInvocation(
				codex,
				["plugin", "marketplace", "remove", CODEX_PLUGIN_MARKETPLACE_NAME],
				process.platform,
				env,
			);
			spawnSync(removeMarketplace.command, removeMarketplace.args, { ...options, env: removeMarketplace.env });
		} catch {
			// Uninstall still removes Signet-owned compatibility state below.
		}
	}

	private getHooksJsonPath(): string {
		return join(this.getCodexHome(), "hooks.json");
	}

	getConfigPath(): string {
		return join(this.getCodexHome(), "config.toml");
	}

	private installCompatibilityHooks(
		signetArgs: string[],
		filesWritten: string[],
		configsPatched: string[],
		warnings: string[],
		windowsHookCommand: string | null = null,
	): void {
		const hooksPath = this.getHooksJsonPath();
		const existing = readHooksFile(hooksPath);

		if (existing) {
			const migrated = migrateLegacyHooksFile(existing);
			const cleaned = removeSignetEntries(migrated);
			const hasHooks = cleaned.hooks && Object.keys(cleaned.hooks).length > 0;
			if (hasHooks) {
				const signet = buildHooksFile(signetArgs, resolveRemoteDaemonUrl(), windowsHookCommand);
				const merged: HooksFile = { ...cleaned };
				merged.hooks = { ...(cleaned.hooks as Record<string, MatcherGroup[]>) };
				for (const key of HOOK_EVENT_KEYS) {
					const current = merged.hooks[key] ?? [];
					const ours = signet.hooks?.[key] ?? [];
					(merged.hooks as Record<string, MatcherGroup[]>)[key] = [...current, ...ours];
				}
				writeHooksFile(hooksPath, merged);
				warnings.push("Merged Signet hooks into existing hooks.json — existing hooks preserved");
			} else {
				const signet = buildHooksFile(signetArgs, resolveRemoteDaemonUrl(), windowsHookCommand);
				writeHooksFile(hooksPath, { ...cleaned, hooks: signet.hooks });
			}
		} else {
			writeHooksFile(hooksPath, buildHooksFile(signetArgs, resolveRemoteDaemonUrl(), windowsHookCommand));
		}
		filesWritten.push(hooksPath);

		const configPath = this.getConfigPath();
		const installedHooks = readHooksFile(hooksPath);
		if (
			installedHooks &&
			patchHookTrustState(configPath, buildHookTrustEntries(hooksPath, installedHooks)) &&
			!configsPatched.includes(configPath)
		) {
			configsPatched.push(configPath);
		}
	}

	private removeCompatibilityHooks(configsPatched: string[]): void {
		const hooksPath = this.getHooksJsonPath();
		const existing = readHooksFile(hooksPath);
		const hookTrustEntries = existing ? buildHookTrustEntries(hooksPath, existing) : [];
		if (existing) {
			const hasMarker = hasLegacySignetMarker(existing);
			const events = existing.hooks;
			const hasHandlers =
				events &&
				typeof events === "object" &&
				Object.values(events as Record<string, unknown[]>).some(
					(groups) => Array.isArray(groups) && groups.some(isSignetMatcherGroup),
				);
			if (hasMarker || hasHandlers) {
				const cleaned = removeSignetEntries(existing);
				const remaining = Object.keys(cleaned).filter((k) => k !== "hooks");
				const hooksRemain = cleaned.hooks && Object.keys(cleaned.hooks as Record<string, unknown>).length > 0;
				if (remaining.length === 0 && !hooksRemain) {
					rmSync(hooksPath, { force: true });
				} else {
					writeHooksFile(hooksPath, cleaned);
				}
				if (!configsPatched.includes(hooksPath)) {
					configsPatched.push(hooksPath);
				}
			}
		}

		const configPath = this.getConfigPath();
		if (removeHookTrustState(configPath, hookTrustEntries) && !configsPatched.includes(configPath)) {
			configsPatched.push(configPath);
		}
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const configsPatched: string[] = [];
		const warnings: string[] = [];
		const expandedBasePath = expandHome(basePath || join(homedir(), ".agents"));
		const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
		if (strippedAgentsPath !== null) {
			filesWritten.push(strippedAgentsPath);
		}

		const codexHome = this.getCodexHome();
		mkdirSync(codexHome, { recursive: true });

		const configPath = this.getConfigPath();
		const staleRuntime = hasMissingSignetRuntime(readHooksFile(this.getHooksJsonPath()), configPath);
		const runtime = this.resolveCodexDesktopNode();
		const signetArgs = resolveSignetArgs(runtime);
		const remoteDaemonUrl = resolveRemoteDaemonUrl();
		const windowsHookCommand = writeWindowsHookWrapper(codexHome, signetArgs, remoteDaemonUrl);
		const mcp = resolveSignetMcp(runtime);
		if (staleRuntime) {
			warnings.push(
				runtime
					? "Detected a missing Signet Codex runtime path; refreshed only Signet-owned hooks and MCP configuration."
					: "Detected a missing Signet Codex runtime path; no replacement Codex runtime was found, so Signet commands use the PATH fallback.",
			);
		}
		const nativePluginSupported = this.supportsNativePluginInstall();

		if (nativePluginSupported) {
			const bundle = writeCodexPluginBundle({
				codexHome,
				signetArgs,
				mcp,
				remoteDaemonUrl,
				windowsHookCommand,
			});
			filesWritten.push(...bundle.filesWritten);
			if (unpatchConfigToml(this.getConfigPath()) && !configsPatched.includes(this.getConfigPath())) {
				configsPatched.push(this.getConfigPath());
			}
			const pluginInstall = this.installNativePlugin(codexHome, bundle.marketplaceRoot);
			filesWritten.push(...pluginInstall.filesWritten);
			if (pluginInstall.warning) warnings.push(pluginInstall.warning);
			if (pluginInstall.success) {
				if (
					existsSync(this.getConfigPath()) &&
					readFileSync(this.getConfigPath(), "utf-8").includes(`[plugins."${CODEX_PLUGIN_CONFIG_NAME}"]`) &&
					!configsPatched.includes(this.getConfigPath())
				) {
					configsPatched.push(this.getConfigPath());
				}
				if (this.nativePluginProvidesHooks()) {
					this.removeCompatibilityHooks(configsPatched);
				} else {
					this.installCompatibilityHooks(signetArgs, filesWritten, configsPatched, warnings, windowsHookCommand);
					warnings.push(
						"Codex plugin support detected, but lifecycle hooks still require the compatibility hooks.json path in this Codex version",
					);
				}

				return {
					success: true,
					message: this.nativePluginProvidesHooks()
						? "Codex integration installed — native plugin bundle"
						: "Codex integration installed — native plugin bundle + compatibility hooks",
					filesWritten,
					configsPatched,
					warnings,
				};
			}
			// The CLI may have partially registered the marketplace before failing.
			// Remove only the Signet-owned sections before falling back.
			if (unpatchNativePluginConfig(this.getConfigPath()) && !configsPatched.includes(this.getConfigPath())) {
				configsPatched.push(this.getConfigPath());
			}
		}

		// 1. Install hooks.json (native Codex hook system)
		if (windowsHookCommand && !filesWritten.includes(windowsHookCommand)) filesWritten.push(windowsHookCommand);
		this.installCompatibilityHooks(signetArgs, filesWritten, configsPatched, warnings, windowsHookCommand);

		// 2. Symlink skills directory
		const skillsResult = this.symlinkSkills(expandedBasePath, codexHome);
		if (!skillsResult) {
			warnings.push("Failed to symlink skills directory");
		}

		// 3. Register MCP server in config.toml
		if (patchConfigToml(configPath, mcp)) {
			configsPatched.push(configPath);
		}
		const installedHooks = readHooksFile(this.getHooksJsonPath());
		if (
			installedHooks &&
			patchHookTrustState(configPath, buildHookTrustEntries(this.getHooksJsonPath(), installedHooks)) &&
			!configsPatched.includes(configPath)
		) {
			configsPatched.push(configPath);
		}

		return {
			success: true,
			message: "Codex integration installed — native hooks + MCP server",
			filesWritten,
			configsPatched,
			warnings,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];

		// 1. Remove hooks.json (or clean Signet entries from merged file)
		const hooksPath = this.getHooksJsonPath();
		const existing = readHooksFile(hooksPath);
		const hookTrustEntries = existing ? buildHookTrustEntries(hooksPath, existing) : [];
		if (existing) {
			const hasMarker = hasLegacySignetMarker(existing);
			const events = existing.hooks;
			const hasHandlers =
				events &&
				typeof events === "object" &&
				Object.values(events as Record<string, unknown[]>).some(
					(groups) => Array.isArray(groups) && groups.some(isSignetMatcherGroup),
				);
			if (hasMarker || hasHandlers) {
				const cleaned = removeSignetEntries(existing);
				const remaining = Object.keys(cleaned).filter((k) => k !== "hooks");
				const hooksRemain = cleaned.hooks && Object.keys(cleaned.hooks as Record<string, unknown>).length > 0;
				if (remaining.length === 0 && !hooksRemain) {
					rmSync(hooksPath, { force: true });
					filesRemoved.push(hooksPath);
				} else {
					writeHooksFile(hooksPath, cleaned);
					configsPatched.push(hooksPath);
				}
			}
		}

		// 2. Remove skills symlink
		const skillsLink = join(this.getCodexHome(), "skills");
		if (existsSync(skillsLink)) {
			rmSync(skillsLink, { force: true });
			filesRemoved.push(skillsLink);
		}

		// 3. Remove MCP server from config.toml
		const configPath = this.getConfigPath();
		this.removeNativePlugin(this.getCodexHome());
		if (unpatchNativePluginConfig(configPath)) {
			configsPatched.push(configPath);
		}
		if (removeHookTrustState(configPath, hookTrustEntries)) {
			configsPatched.push(configPath);
		}
		if (unpatchConfigToml(configPath) && !configsPatched.includes(configPath)) {
			configsPatched.push(configPath);
		}
		const pluginMarketplace = join(this.getCodexHome(), ".tmp", "signet-plugin-marketplace");
		if (existsSync(pluginMarketplace)) {
			rmSync(pluginMarketplace, { recursive: true, force: true });
			filesRemoved.push(pluginMarketplace);
		}

		return { filesRemoved, configsPatched };
	}

	isInstalled(): boolean {
		const configPath = this.getConfigPath();
		if (
			existsSync(configPath) &&
			readFileSync(configPath, "utf-8").includes(`[plugins."${CODEX_PLUGIN_CONFIG_NAME}"]`)
		) {
			return true;
		}
		const file = readHooksFile(this.getHooksJsonPath());
		if (!file) return false;
		const events = file.hooks;
		if (!events || typeof events !== "object") return false;
		return Object.values(events as Record<string, unknown[]>).some(
			(groups) => Array.isArray(groups) && groups.some(isSignetMatcherGroup),
		);
	}
}
