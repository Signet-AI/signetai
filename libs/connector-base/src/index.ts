export { captureRemoteSessionEnd } from "./capture";
import { cliFromMcp, resolveSignetCliCommand } from "./launcher";
import type { ResolvedCommand } from "./config";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { isJsonObject, readManagedTrimmedEnv } from "./config";
export { isJsonObject, isExistingFile, readTrimmedEnv, readManagedTrimmedEnv, type ResolvedCommand } from "./config";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fstatSync,
	ftruncateSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
	type SymlinkOptions,
	type SymlinkResult,
	resolveSignetDaemonUrl as resolveCoreSignetDaemonUrl,
	resolveWorkspacePath,
	stripSignetBlock,
	symlinkSkills,
} from "@signet/core";

export interface InstallResult {
	success: boolean;
	message: string;
	filesWritten: string[];
	configsPatched?: string[];
	warnings?: string[];
}

export interface UninstallResult {
	filesRemoved: string[];
	configsPatched?: string[];
}

export type ConnectorHealthStatus = "healthy" | "degraded" | "unhealthy" | "needs-auth" | "unknown";

export interface ConnectorHealth {
	status: ConnectorHealthStatus;
	message: string;
}

export interface ConnectorRecoveryCapabilities {
	repair: boolean;
	reinitialize: boolean;
	reinitializeRequiresConfirmation: boolean;
}
export abstract class BaseConnector {
	abstract readonly name: string;
	abstract readonly harnessId: string;
	getIconAsset(): string | null {
		return null;
	}
	protected stripSignetBlock(content: string): string {
		return stripSignetBlock(content);
	}
	protected stripLegacySignetBlock(basePath: string): string | null {
		const agentsPath = join(basePath, "AGENTS.md");
		if (!existsSync(agentsPath)) return null;
		const raw = readFileSync(agentsPath, "utf-8");
		const cleaned = stripSignetBlock(raw);
		if (cleaned === raw) return null;
		const root = realpathSync(basePath);
		const parent = realpathSync(dirname(agentsPath));
		const rel = relative(root, join(parent, "AGENTS.md"));
		if (rel.startsWith("..") || isAbsolute(rel)) {
			throw new Error(`Target path escapes validated root: ${agentsPath}`);
		}
		const tmp = join(basePath, `.${randomBytes(6).toString("hex")}.tmp`);
		try {
			writeFileSync(tmp, cleaned, "utf-8");
			renameSync(tmp, agentsPath);
		} catch (err) {
			try {
				unlinkSync(tmp);
			} catch {}
			throw err;
		}
		return agentsPath;
	}
	protected symlinkSkills(sourceDir: string, targetDir: string, options?: SymlinkOptions): SymlinkResult {
		return symlinkSkills(sourceDir, targetDir, options);
	}
	protected generateHeader(sourcePath: string, targetName?: string): string {
		const name = targetName || this.name;
		const safe = (p: string) => p.replace(/[\n\r]/g, "");
		const root = dirname(sourcePath);
		return `# Auto-generated from ${safe(sourcePath)}
# Source: ${safe(sourcePath)}
# Generated: ${new Date().toISOString()}
# DO NOT EDIT - changes will be overwritten
# Edit the source files in ${safe(root)}/ instead

`;
	}
	protected composeIdentityExtras(basePath: string): string {
		const files = ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"] as const;
		const parts: string[] = [];

		for (const name of files) {
			const filePath = join(basePath, name);
			if (!existsSync(filePath)) continue;
			try {
				const content = readFileSync(filePath, "utf-8").trim();
				if (!content) continue;
				const header = name.replace(".md", "");
				parts.push(`\n## ${header}\n\n${content}`);
			} catch {}
		}

		return parts.join("\n");
	}
	abstract install(basePath: string): Promise<InstallResult>;
	abstract uninstall(): Promise<UninstallResult>;
	abstract isInstalled(): boolean;
	isDetected(): boolean {
		return existsSync(this.getConfigPath());
	}
	async inspectHealth(): Promise<ConnectorHealth> {
		try {
			if (this.isInstalled()) {
				return {
					status: "unknown",
					message: "Signet integration files are installed. This connector does not check runtime health.",
				};
			}
			if (this.isDetected()) {
				return { status: "degraded", message: "Harness detected; Signet integration is not configured." };
			}
			return { status: "unhealthy", message: "Signet integration is not installed." };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { status: "unknown", message: `Health inspection failed: ${message}` };
		}
	}
	getRecoveryCapabilities(): ConnectorRecoveryCapabilities {
		return {
			repair: true,
			reinitialize: true,
			reinitializeRequiresConfirmation: true,
		};
	}
	async repair(basePath: string): Promise<InstallResult> {
		return this.install(basePath);
	}
	async reinitialize(basePath: string): Promise<InstallResult> {
		return this.install(basePath);
	}
	getInstallPaths(): readonly string[] {
		return this.getConfigPaths();
	}
	getConfigPaths(): readonly string[] {
		return [this.getConfigPath()];
	}
	abstract getConfigPath(): string;
}
export function isSignetGeneratedFile(raw: string): boolean {
	const lines = raw.split("\n").slice(0, 6);
	return lines.some((line, i) => {
		const nextLine = lines[i + 1];
		return (
			/^#\s+AUTO-GENERATED\s+from\s+.*\s+by\s+Signet/i.test(line) ||
			(/^#\s+Auto-generated\s+from\s+/.test(line) && /^#\s+Source:\s+/.test(nextLine ?? ""))
		);
	});
}

function containsSignetApiKey(content: string): boolean {
	const key = resolveSignetApiKey();
	if (key === undefined) return false;
	if (!/^[A-Za-z0-9._~+/=-]+$/.test(key)) return true;
	return content.includes(key);
}

export function keepSignetApiKeyFilePrivate(path: string): void {
	let mode: number;
	try {
		mode = statSync(path).mode & 0o777;
	} catch {
		return;
	}
	if ((mode & 0o077) === 0 || !containsSignetApiKey(readFileSync(path, "utf-8"))) return;
	chmodSync(path, mode & 0o700);
}

export function writeConfigText(path: string, content: string): void {
	if (!containsSignetApiKey(content)) {
		writeFileSync(path, content, "utf-8");
		return;
	}
	const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT, 0o600);
	try {
		const mode = fstatSync(fd).mode & 0o777;
		if ((mode & 0o077) !== 0) fchmodSync(fd, mode & 0o700);
		const bytes = Buffer.from(content, "utf-8");
		let offset = 0;
		while (offset < bytes.length) {
			const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
			if (written <= 0) throw new Error(`Write made no progress: ${path}`);
			offset += written;
		}
		ftruncateSync(fd, bytes.length);
	} finally {
		closeSync(fd);
	}
}

export function atomicWriteText(path: string, content: string, mode?: number): void {
	const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
	let writeMode = mode;
	if (writeMode === undefined) {
		try {
			writeMode = statSync(path).mode & 0o777;
		} catch {}
	}
	if (containsSignetApiKey(content)) writeMode = (writeMode ?? 0o600) & 0o700;
	try {
		writeFileSync(tmp, content, { encoding: "utf-8", mode: writeMode });
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {}
		throw err;
	}
}

export function atomicWriteJson(path: string, data: unknown, indent: number | string = 2): void {
	atomicWriteText(path, `${JSON.stringify(data, null, indent)}\n`);
}

export {
	SIGNET_MCP_STDIO_WORKER_ENV,
	isSignetCliLauncher,
	cliFromMcp,
	mcpFromCli,
	parseHookLauncher,
	quoteCommandArg,
	readMcpLauncher,
	renderCommand,
	resolveSignetCliCommand,
	resolveSignetMcpCommand,
} from "./launcher";

export function resolveHarnessMcpCommand(
	harness: string,
	existing?: ResolvedCommand,
	runtime: string | null = null,
): ResolvedCommand {
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(harness)) throw new Error("Invalid MCP harness");
	const cli = resolveSignetCliCommand(cliFromMcp(existing), runtime);
	const owned = new Set([
		"SIGNET_API_KEY",
		"SIGNET_TOKEN",
		"SIGNET_API_KEY_FILE",
		"SIGNET_DAEMON_URL",
		"SIGNET_AGENT_ID",
		"SIGNET_AGENT_WORKSPACE",
		"SIGNET_MCP_STDIO_WORKER",
	]);
	const env = Object.fromEntries(Object.entries(existing?.env ?? {}).filter(([key]) => !owned.has(key)));
	return {
		command: cli.command,
		args: [...cli.args, "connector", "mcp", harness],
		...(Object.keys(env).length ? { env } : {}),
	};
}
export const MANAGED_DAEMON_URL_DEFAULT = "http://127.0.0.1:3850";
export const MANAGED_AGENT_ID_DEFAULT = "default";
export function isChildOf(candidate: string, parent: string): boolean {
	const rel = relative(parent, candidate);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function isExistingDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function resolveSignetWorkspacePath(home = homedir()): string {
	return resolveWorkspacePath({ home, strict: true, requireExistingEnvPath: true }).path;
}

export function resolveSignetDaemonUrl(): string {
	return resolveCoreSignetDaemonUrl();
}

export function resolveSignetAgentId(): string {
	return readManagedTrimmedEnv("SIGNET_AGENT_ID") ?? MANAGED_AGENT_ID_DEFAULT;
}

export function resolveSignetApiKey(): string | undefined {
	return readManagedTrimmedEnv("SIGNET_API_KEY") ?? readManagedTrimmedEnv("SIGNET_TOKEN");
}
export async function resolveInstallApiKey(): Promise<{ readonly apiKey?: string; readonly warning?: string }> {
	return {};
}

export function buildSignetRuntimeEnv(
	opts: { readonly basePath?: string; readonly apiKey?: string | null } = {},
): Record<string, string> {
	const env: Record<string, string> = {};
	if (opts.basePath) env.SIGNET_PATH = opts.basePath;

	return env;
}
export function resolveRemoteDaemonUrl(): string | null {
	return readManagedTrimmedEnv("SIGNET_DAEMON_URL") ? resolveSignetDaemonUrl() : null;
}

export function buildManagedExtensionEnvBootstrap(env: {
	readonly signetPath: string;
	readonly daemonUrl: string;
	readonly agentId: string;
	readonly apiKey?: string;
}): string {
	const isDefaultWorkspace = env.signetPath === join(homedir(), ".agents");
	const workspaceExists = isExistingDirectory(env.signetPath);
	if (!isDefaultWorkspace && !workspaceExists) {
		console.warn(
			`[signet] resolved workspace "${env.signetPath}" does not exist; not embedding it in the managed extension to avoid propagating a stale path (issue #1016).`,
		);
	}
	const signetPathBlock =
		isDefaultWorkspace || !workspaceExists
			? ""
			: `\t\tif (!__signetReadEnv("SIGNET_PATH")) {\n\t\t\tReflect.set(__signetRuntimeEnv, "SIGNET_PATH", ${JSON.stringify(env.signetPath)});\n\t\t}\n`;

	return `const __signetRuntimeProcess = Reflect.get(globalThis, "process");
if (__signetRuntimeProcess && typeof __signetRuntimeProcess === "object") {
	const __signetRuntimeEnv = Reflect.get(__signetRuntimeProcess, "env");
	const __signetReadEnv = (key) => {
		if (!__signetRuntimeEnv || typeof __signetRuntimeEnv !== "object") return undefined;
		const value = Reflect.get(__signetRuntimeEnv, key);
		return typeof value === "string" && value.trim().length > 0 ? value : undefined;
	};
	if (__signetRuntimeEnv && typeof __signetRuntimeEnv === "object") {
${signetPathBlock}
	}
}`;
}

export function managedExtensionFilePath(agentDir: string, filename: string): string {
	return join(agentDir, "extensions", filename);
}
export function buildManagedExtensionContent(params: {
	readonly bundle: string;
	readonly marker: string;
	readonly packageName: string;
	readonly entry: string;
	readonly env: {
		readonly signetPath: string;
		readonly daemonUrl: string;
		readonly agentId: string;
		readonly apiKey?: string;
	};
}): string {
	if (params.bundle.length === 0) {
		throw new Error(
			`Bundled extension content is empty. Rebuild ${params.packageName} and rerun the connector build so ${params.entry} is embedded.`,
		);
	}
	const bootstrap = buildManagedExtensionEnvBootstrap(params.env);
	return `// ${params.marker}
// Managed by Signet (${params.packageName})
// Source: ${params.entry}
// DO NOT EDIT - this file is overwritten by Signet setup/sync.

${bootstrap}

${params.bundle}`;
}

export function isManagedExtensionFile(filePath: string, marker: string): boolean {
	const content = readManagedExtensionFile(filePath);
	return content?.includes(marker) ?? false;
}

function readManagedExtensionFile(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

export function removeManagedExtensionFile(filePath: string, marker: string): boolean {
	const content = readManagedExtensionFile(filePath);
	if (!content?.includes(marker)) return false;
	unlinkSync(filePath);
	return true;
}

export function writeManagedExtensionFile(filePath: string, content: string): boolean {
	if (readManagedExtensionFile(filePath) !== content) {
		atomicWriteText(filePath, content, 0o600);
		return true;
	}
	if ((statSync(filePath).mode & 0o077) !== 0) chmodSync(filePath, 0o600);
	return false;
}

export interface ConnectorInstallerOptions {
	readonly commandName?: string;
	readonly packageName?: string;
	readonly label?: string;
}

type ConnectorConstructor = new () => BaseConnector;

interface ParsedConnectorInstallerArgs {
	command: "install" | "uninstall" | "status";
	help?: boolean;
	url?: string;
	apiKeyStdin?: boolean;
	agentId?: string;
	path?: string;
}

function connectorInstallerUsage(harness: string, options: ConnectorInstallerOptions): string {
	const commandName = options.commandName ?? `signet-connector-${harness}`;
	const packageName = options.packageName ?? `@signet/connector-${harness}`;
	return `Usage: ${commandName} [install|uninstall|status] [options]

Options:
  --url <url>          Remote Signet daemon URL (sets SIGNET_DAEMON_URL)
  --api-key-stdin      Read the credential from stdin; never put it in argv
  --agent-id <id>      Signet agent id for this connector
  --path <path>        Signet workspace path (default: SIGNET_PATH or ~/.agents)
  -h, --help           Show this help

Examples:
  ${commandName} install --url http://host:3850 --api-key-stdin
  npx -y ${packageName} install --url http://host:3850 --api-key-stdin
`;
}

function takeConnectorInstallerValue(args: readonly string[], index: number, name: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
	return value;
}

function parseConnectorInstallerArgs(argv: readonly string[]): ParsedConnectorInstallerArgs {
	const options: ParsedConnectorInstallerArgs = { command: "install" };
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
			options.url = takeConnectorInstallerValue(argv, i, arg);
			i++;
			continue;
		}
		if (arg === "--api-key" || arg === "--token")
			throw new Error("Inline credentials are not supported; use --api-key-stdin or signet login");
		if (arg === "--api-key-stdin") {
			options.apiKeyStdin = true;
			continue;
		}

		if (arg === "--agent-id") {
			options.agentId = takeConnectorInstallerValue(argv, i, arg);
			i++;
			continue;
		}
		if (arg === "--path" || arg === "-p") {
			options.path = takeConnectorInstallerValue(argv, i, arg);
			i++;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

function setConnectorInstallerEnv(name: string, value: string | undefined): void {
	if (typeof value === "string" && value.trim().length > 0) process.env[name] = value.trim();
}

function printConnectorInstallerList(label: string, values: readonly string[] | undefined): void {
	if (!Array.isArray(values) || values.length === 0) return;
	console.log(`${label}:`);
	for (const value of values) console.log(`  - ${value}`);
}

export function runConnectorInstaller(
	harness: string,
	ConnectorClass: ConnectorConstructor,
	options: ConnectorInstallerOptions = {},
): void {
	const label = options.label ?? harness;
	async function main(): Promise<void> {
		const parsed = parseConnectorInstallerArgs(process.argv.slice(2));
		if (parsed.help) {
			console.log(connectorInstallerUsage(harness, options));
			return;
		}
		setConnectorInstallerEnv("SIGNET_DAEMON_URL", parsed.url);

		setConnectorInstallerEnv("SIGNET_AGENT_ID", parsed.agentId);
		const basePath = parsed.path || process.env.SIGNET_PATH || join(homedir(), ".agents");
		const connector = new ConnectorClass();

		if (parsed.command === "status") {
			console.log(connector.isInstalled() ? `${label}: installed` : `${label}: not installed`);
			return;
		}

		if (parsed.command === "uninstall") {
			const result = await connector.uninstall();
			console.log(`${label}: uninstalled`);
			printConnectorInstallerList("Files removed", result.filesRemoved);
			printConnectorInstallerList("Configs patched", result.configsPatched);
			return;
		}

		if (parsed.url || parsed.apiKeyStdin || process.env.SIGNET_DAEMON_URL) {
			const cli = resolveSignetCliCommand();
			const args = [
				...cli.args,
				"connect",
				harness,
				"--path",
				basePath,
				...(parsed.url ? ["--url", parsed.url] : []),
				...(parsed.agentId ? ["--agent", parsed.agentId] : []),
				...(parsed.apiKeyStdin ? ["--api-key-stdin"] : []),
			];
			const child = spawn(cli.command, args, { stdio: "inherit", env: process.env });
			process.exitCode = await new Promise<number>((accept, reject) => {
				child.once("error", reject);
				child.once("exit", (code) => accept(code ?? 1));
			});
			return;
		}
		const result = await connector.install(basePath);
		console.log(result.message || `${label}: installed`);
		printConnectorInstallerList("Files written", result.filesWritten);
		printConnectorInstallerList("Configs patched", result.configsPatched);
		printConnectorInstallerList("Warnings", result.warnings);
	}

	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

export type { SymlinkOptions, SymlinkResult };
