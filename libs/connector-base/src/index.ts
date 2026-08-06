/**
 * @signet/connector-base
 *
 * Base class for Signet harness connectors. Provides shared functionality
 * that all connectors need (Signet block handling, skills symlinking),
 * allowing concrete connectors to focus on harness-specific logic.
 *
 * @example
 * ```typescript
 * import { BaseConnector, InstallResult } from '@signet/connector-base';
 *
 * class MyConnector extends BaseConnector {
 *   readonly name = "my-harness";
 *   readonly harnessId = "myharness";
 *
 *   async install(basePath: string): Promise<InstallResult> {
 *     // harness-specific setup
 *   }
 *
 *   async uninstall(): Promise<void> {
 *     // harness-specific cleanup
 *   }
 *
 *   isInstalled(): boolean {
 *     // check if already set up
 *   }
 *
 *   getConfigPath(): string {
 *     // return harness config file path
 *   }
 * }
 * ```
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Base Connector
// ============================================================================

/**
 * Abstract base class for Signet harness connectors.
 *
 * Provides:
 * - stripSignetBlock() - remove existing Signet blocks before re-injection
 * - stripLegacySignetBlock() - migrate old SIGNET block out of AGENTS.md
 * - symlinkSkills() - symlink skills directory to harness-specific location
 *
 * Subclasses must implement:
 * - name - human-readable harness name
 * - harnessId - machine identifier for the harness
 * - install() - harness-specific setup
 * - uninstall() - harness-specific cleanup
 * - isInstalled() - check if integration exists
 * - getConfigPath() - return path to harness config
 */
export abstract class BaseConnector {
	/**
	 * Human-readable name for the harness (e.g., "Claude Code")
	 */
	abstract readonly name: string;

	/**
	 * Machine identifier (e.g., "claude-code")
	 */
	abstract readonly harnessId: string;

	// ==========================================================================
	// Shared implementations (provided by base class)
	// ==========================================================================

	/**
	 * Strip existing Signet blocks from content.
	 *
	 * Call this before re-injecting the block to prevent duplication
	 * when re-running install or sync operations.
	 */
	protected stripSignetBlock(content: string): string {
		return stripSignetBlock(content);
	}

	/**
	 * Strip legacy SIGNET block markers from AGENTS.md in place.
	 *
	 * Returns the path when a write occurred, otherwise null.
	 */
	protected stripLegacySignetBlock(basePath: string): string | null {
		const agentsPath = join(basePath, "AGENTS.md");
		if (!existsSync(agentsPath)) return null;
		const raw = readFileSync(agentsPath, "utf-8");
		const cleaned = stripSignetBlock(raw);
		if (cleaned === raw) return null;
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

	/**
	 * Symlink skills from source to target directory.
	 *
	 * Each subdirectory in sourceDir becomes a symlink in targetDir.
	 * Existing symlinks are replaced; real directories are skipped.
	 */
	protected symlinkSkills(sourceDir: string, targetDir: string, options?: SymlinkOptions): SymlinkResult {
		return symlinkSkills(sourceDir, targetDir, options);
	}

	/**
	 * Generate the auto-generated file header.
	 *
	 * @param sourcePath - Path to the source file being generated from
	 * @param targetName - Name of the target harness
	 */
	protected generateHeader(sourcePath: string, targetName?: string): string {
		const name = targetName || this.name;
		// Strip CR/LF so a malformed path can't break out of comment lines
		const safe = (p: string) => p.replace(/[\n\r]/g, "");
		const root = dirname(sourcePath);
		return `# Auto-generated from ${safe(sourcePath)}
# Source: ${safe(sourcePath)}
# Generated: ${new Date().toISOString()}
# DO NOT EDIT - changes will be overwritten
# Edit the source files in ${safe(root)}/ instead

`;
	}

	/**
	 * Read and compose additional identity files (SOUL.md, IDENTITY.md,
	 * USER.md, MEMORY.md) into a single string with section headers.
	 *
	 * @param basePath - Path to the Signet workspace or equivalent identity directory
	 */
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
			} catch {
				// Skip unreadable files
			}
		}

		return parts.join("\n");
	}

	// ==========================================================================
	// Abstract methods (must be implemented by subclasses)
	// ==========================================================================

	/**
	 * Install the connector for this harness.
	 *
	 * Should:
	 * - Configure hooks in the harness config
	 * - Generate any necessary files (CLAUDE.md, AGENTS.md, etc.)
	 * - Set up skills symlinks
	 *
	 * Must be idempotent - safe to run multiple times.
	 */
	abstract install(basePath: string): Promise<InstallResult>;

	/**
	 * Remove the connector integration.
	 *
	 * Should:
	 * - Remove hooks from harness config
	 * - Remove generated files (but not user data)
	 * - Optionally remove skills symlinks
	 */
	abstract uninstall(): Promise<UninstallResult>;

	/**
	 * Check if the connector is already installed.
	 */
	abstract isInstalled(): boolean;

	/**
	 * Get the path to the harness's main config file.
	 */
	abstract getConfigPath(): string;
}

// ==========================================================================
// Shared helpers
// ==========================================================================

/**
 * Check whether file content was generated by Signet.
 * Matches both connector-generated headers ("# Auto-generated from")
 * and daemon-generated headers ("# AUTO-GENERATED from ... by Signet").
 * Uses a strict two-line pattern to avoid matching user-owned files that
 * happen to contain the phrase "auto-generated" somewhere in their body.
 */
export function isSignetGeneratedFile(raw: string): boolean {
	const lines = raw.split("\n").slice(0, 6);
	return lines.some(
		(line, i) =>
			// Daemon-generated: "# AUTO-GENERATED from <path> by Signet"
			/^#\s+AUTO-GENERATED\s+from\s+.*\s+by\s+Signet/i.test(line) ||
			// Connector-generated: "# Auto-generated from <path>" followed by "# Source: <path>" on the next line
			(/^#\s+Auto-generated\s+from\s+/.test(line) && i + 1 < lines.length && /^#\s+Source:\s+/.test(lines[i + 1])),
	);
}

// ============================================================================
// Atomic file write — prevents TOCTOU corruption when multiple
// connector runs race on the same config file. Writes to a temp file
// then renames (atomic on POSIX, near-atomic on Windows).
// ============================================================================

export function atomicWriteText(path: string, content: string, mode?: number): void {
	const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
	let writeMode = mode;
	if (writeMode === undefined) {
		try {
			writeMode = statSync(path).mode & 0o777;
		} catch {
			// New files use the process umask.
		}
	}
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

export type ResolvedCommand = { readonly command: string; readonly args: readonly string[] };

function resolvePackagedSignetCommand(
	bareCommand: string,
	scriptDirectory: "bin" | "dist",
	scriptName: string,
	warnOnFallback: boolean,
): ResolvedCommand {
	if (process.platform !== "win32") return { command: bareCommand, args: [] };

	const cliEntry = process.argv[1] ?? "";
	const scriptPath = join(cliEntry, "..", "..", scriptDirectory, scriptName);
	if (cliEntry && existsSync(scriptPath)) return { command: process.execPath, args: [scriptPath] };

	if (warnOnFallback) {
		console.warn(
			`[signet] Warning: could not resolve ${scriptName} from argv[1]="${cliEntry}". ` +
				`MCP server config will use "${bareCommand}" which may fail on Windows without shell:true.`,
		);
	}
	return { command: bareCommand, args: [] };
}

/** Resolve the signet-mcp stdio command, including the packaged Windows entry point. */
export function resolveSignetMcpCommand(): ResolvedCommand {
	return resolvePackagedSignetCommand("signet-mcp", "dist", "mcp-stdio.js", true);
}

/** Resolve the Signet CLI command for hook invocation. */
export function resolveSignetCliCommand(): ResolvedCommand {
	return resolvePackagedSignetCommand("signet", "bin", "signet.js", false);
}

// ============================================================================
// Shared managed-extension utilities (used by connector-pi, connector-oh-my-pi)
// ============================================================================

export const MANAGED_DAEMON_URL_DEFAULT = "http://127.0.0.1:3850";
export const MANAGED_AGENT_ID_DEFAULT = "default";

/** Narrow an unknown value to a plain record (shared by connectors, #957). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `candidate` is strictly inside `parent` on the filesystem (shared, #957). */
export function isChildOf(candidate: string, parent: string): boolean {
	const rel = relative(parent, candidate);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Read a non-empty, trimmed env var (shared by connectors, #957).
 * Newlines are stripped so multi-line values cannot smuggle into single-line
 * config surfaces (the behavior forge/opencode standardized on).
 */
export function readTrimmedEnv(name: string): string | undefined {
	const value = process.env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().replace(/[\r\n]+/g, "");
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @deprecated Use `readTrimmedEnv` (same semantics, canonical name).
 */
export function readManagedTrimmedEnv(name: string): string | undefined {
	return readTrimmedEnv(name);
}

function isExistingDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function resolveSignetWorkspacePath(home = homedir()): string {
	// Delegates to the canonical resolver in @signet/core (issue #956). Connectors
	// are install-time operations, so they fail loud on a malformed workspace.json
	// (strict) and treat a stale env override as unset so it is not re-embedded
	// into a managed extension (requireExistingEnvPath, issue #1016). A persisted
	// workspace.json value is still trusted verbatim: it is an explicit,
	// admin-authored override, and buildManagedExtensionEnvBootstrap re-checks
	// existence before baking any path into an extension.
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

export function buildManagedExtensionEnvBootstrap(env: {
	readonly signetPath: string;
	readonly daemonUrl: string;
	readonly agentId: string;
	readonly apiKey?: string;
}): string {
	const daemonUrl = JSON.stringify(env.daemonUrl);
	const agentId = JSON.stringify(env.agentId);
	const apiKey = env.apiKey ? JSON.stringify(env.apiKey) : null;

	// Decide whether to bake SIGNET_PATH into the extension:
	//  - default workspace (homedir/.agents): never bake it. The managed
	//    pi/oh-my-pi extension derives join(homedir(), ".agents") at runtime when
	//    SIGNET_PATH is unset, and any signet subprocess it spawns falls back to
	//    the same default via the CLI/core resolution. Omitting the setter keeps
	//    a synced or cloned agents directory valid across machines whose home
	//    directory differs from the install host (issue #1015).
	//  - a path that does not exist on disk: never bake it, so a stale path from
	//    a migrated/legacy extension is not re-embedded on the next sync (the
	//    self-perpetuating feedback loop, issue #1016). The extension/runtime
	//    then resolves a valid default workspace instead.
	// Only an explicitly configured, existing workspace is baked in.
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
${signetPathBlock}		if (!__signetReadEnv("SIGNET_DAEMON_URL")) {
			Reflect.set(__signetRuntimeEnv, "SIGNET_DAEMON_URL", ${daemonUrl});
		}
		if (!__signetReadEnv("SIGNET_AGENT_ID")) {
			Reflect.set(__signetRuntimeEnv, "SIGNET_AGENT_ID", ${agentId});
		}
		if (${apiKey} && !__signetReadEnv("SIGNET_API_KEY") && !__signetReadEnv("SIGNET_TOKEN")) {
			Reflect.set(__signetRuntimeEnv, "SIGNET_API_KEY", ${apiKey});
		}
	}
}`;
}

export function managedExtensionFilePath(agentDir: string, filename: string): string {
	return join(agentDir, "extensions", filename);
}

/**
 * Build a managed extension file: a header naming the package/entry/marker,
 * the Signet env bootstrap, then the embedded bundle. Shared by the pi and
 * oh-my-pi connectors, which differ only in those constants (#957).
 */
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

// ============================================================================
// Shared npm connector installer runner
// ============================================================================

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
	apiKey?: string;
	agentId?: string;
	path?: string;
}

function connectorInstallerUsage(harness: string, options: ConnectorInstallerOptions): string {
	const commandName = options.commandName ?? `signet-connector-${harness}`;
	const packageName = options.packageName ?? `@signet/connector-${harness}`;
	return `Usage: ${commandName} [install|uninstall|status] [options]

Options:
  --url <url>          Remote Signet daemon URL (sets SIGNET_DAEMON_URL)
  --api-key <key>      Signet API key (sets SIGNET_API_KEY)
  --token <token>      Backward-compatible alias for --api-key
  --agent-id <id>      Signet agent id for this connector
  --path <path>        Signet workspace path (default: SIGNET_PATH or ~/.agents)
  -h, --help           Show this help

Examples:
  ${commandName} install --url http://host:3850 --api-key sig_sk_...
  npx -y ${packageName} install --url http://host:3850 --api-key sig_sk_...
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
		if (arg === "--api-key" || arg === "--token") {
			options.apiKey = takeConnectorInstallerValue(argv, i, arg);
			i++;
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
		setConnectorInstallerEnv("SIGNET_API_KEY", parsed.apiKey);
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

// ============================================================================
// Re-exports
// ============================================================================

export type { SymlinkOptions, SymlinkResult };
