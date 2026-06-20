import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	BaseConnector,
	type InstallResult,
	type UninstallResult,
	atomicWriteJson,
	isSignetGeneratedFile,
	resolveSignetApiKey,
	resolveSignetWorkspacePath,
} from "@signet/connector-base";
import { expandHome, hasValidIdentity, loadIdentityMode, resolveSignetDaemonUrl } from "@signet/core";

const SIGNET_FORGE_MARKER = "Managed by Signet (@signet/connector-forge)";

type JsonObject = Record<string, unknown>;

interface ForgeMcpStdioServer {
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
}

interface ForgeMcpHttpServer {
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
}

type ForgeMcpServer = ForgeMcpStdioServer | ForgeMcpHttpServer;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedEnv(name: string): string | undefined {
	const value = process.env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().replace(/[\r\n]+/g, "");
	return trimmed.length > 0 ? trimmed : undefined;
}

function getHomeDir(): string {
	const home = readTrimmedEnv("HOME");
	return home ?? homedir();
}

function readJsonObject(path: string): JsonObject {
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
	if (!isJsonObject(parsed)) {
		throw new Error("Forge MCP config must be a top-level object");
	}
	return parsed;
}

function readMcpServers(config: JsonObject): JsonObject {
	if (!("mcpServers" in config)) return {};
	if (isJsonObject(config.mcpServers)) return { ...config.mcpServers };
	throw new Error("Forge MCP config field 'mcpServers' must be an object");
}

function signetRuntimeEnv(basePath: string): Record<string, string> {
	const env: Record<string, string> = { SIGNET_PATH: basePath };
	const daemonUrl = readTrimmedEnv("SIGNET_DAEMON_URL");
	const apiKey = readTrimmedEnv("SIGNET_API_KEY") ?? readTrimmedEnv("SIGNET_TOKEN");
	const agentId = readTrimmedEnv("SIGNET_AGENT_ID");
	if (daemonUrl) env.SIGNET_DAEMON_URL = daemonUrl;
	if (apiKey) env.SIGNET_API_KEY = apiKey;
	if (agentId) env.SIGNET_AGENT_ID = agentId;
	return env;
}

function resolveRemoteDaemonUrl(): string | null {
	return readTrimmedEnv("SIGNET_DAEMON_URL") ? resolveSignetDaemonUrl() : null;
}

function resolveSignetMcp(): ForgeMcpStdioServer {
	if (process.platform !== "win32") return { command: "signet-mcp", args: [] };
	const cliEntry = process.argv[1] || "";
	const mcpJs = join(cliEntry, "..", "..", "dist", "mcp-stdio.js");
	if (existsSync(mcpJs)) return { command: process.execPath, args: [mcpJs] };
	console.warn(
		`[signet] Warning: could not resolve mcp-stdio.js from argv[1]="${cliEntry}". ` +
			`MCP server config will use "signet-mcp" which may fail on Windows without shell:true.`,
	);
	return { command: "signet-mcp", args: [] };
}

function buildMcpServer(basePath: string): ForgeMcpServer {
	const remoteDaemonUrl = resolveRemoteDaemonUrl();
	if (remoteDaemonUrl) {
		const apiKey = resolveSignetApiKey();
		return {
			url: `${remoteDaemonUrl}/mcp`,
			...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
		};
	}
	const mcp = resolveSignetMcp();
	return {
		command: mcp.command,
		...(mcp.args && mcp.args.length > 0 ? { args: mcp.args } : {}),
		env: signetRuntimeEnv(basePath),
	};
}

function isChildOf(candidate: string, parent: string): boolean {
	const rel = relative(parent, candidate);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export class ForgeConnector extends BaseConnector {
	readonly name = "ForgeCode";
	readonly harnessId = "forge";

	protected getForgeHome(): string {
		const configured = readTrimmedEnv("FORGE_CONFIG");
		if (configured) return resolve(expandHome(configured));

		const legacyPath = join(getHomeDir(), "forge");
		if (existsSync(legacyPath)) return legacyPath;

		return join(getHomeDir(), ".forge");
	}

	getConfigPath(): string {
		return this.getMcpConfigPath();
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const configsPatched: string[] = [];
		const expandedBasePath = expandHome(basePath || join(getHomeDir(), ".agents"));
		const identityMode = loadIdentityMode(expandedBasePath);

		if (!hasValidIdentity(expandedBasePath)) {
			return {
				success: false,
				message: `No valid Signet identity found at ${expandedBasePath}`,
				filesWritten,
				configsPatched,
			};
		}

		let config: JsonObject;
		try {
			config = readJsonObject(this.getMcpConfigPath());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: `Failed to read ForgeCode MCP config: ${message}`,
				filesWritten,
				configsPatched,
			};
		}

		const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
		if (strippedAgentsPath !== null) filesWritten.push(strippedAgentsPath);

		const forgeHome = this.getForgeHome();
		mkdirSync(forgeHome, { recursive: true });

		if (identityMode === "managed") {
			const agentsPath = this.generateAgentsMd(expandedBasePath);
			if (agentsPath) filesWritten.push(agentsPath);
		} else {
			const staleAgentsPath = this.getAgentsPath();
			if (existsSync(staleAgentsPath)) {
				try {
					const raw = readFileSync(staleAgentsPath, "utf-8");
					if (isSignetGeneratedFile(raw) || raw.includes(SIGNET_FORGE_MARKER)) rmSync(staleAgentsPath);
				} catch {
					// Non-fatal; keep unreadable user files in place.
				}
			}
		}

		try {
			this.registerMcpServer(config, expandedBasePath);
			atomicWriteJson(this.getMcpConfigPath(), config);
			configsPatched.push(this.getMcpConfigPath());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: `ForgeCode integration install failed: ${message}`,
				filesWritten,
				configsPatched,
			};
		}

		const skillsSource = join(expandedBasePath, "skills");
		if (existsSync(skillsSource)) {
			this.symlinkSkills(skillsSource, this.getSkillsPath());
		}

		return {
			success: true,
			message: "ForgeCode integration installed successfully",
			filesWritten,
			configsPatched,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];

		const agentsPath = this.getAgentsPath();
		if (existsSync(agentsPath)) {
			try {
				const raw = readFileSync(agentsPath, "utf-8");
				if (isSignetGeneratedFile(raw) || raw.includes(SIGNET_FORGE_MARKER)) {
					rmSync(agentsPath, { force: true });
					filesRemoved.push(agentsPath);
				}
			} catch {
				// Non-fatal; keep unreadable user files in place.
			}
		}

		let config: JsonObject | null = null;
		if (existsSync(this.getMcpConfigPath())) {
			try {
				config = readJsonObject(this.getMcpConfigPath());
			} catch {
				config = null;
			}
		}

		const signetPath = config ? this.extractSignetPath(config) : null;
		this.removeSkillSymlinks(filesRemoved, signetPath);

		if (config) {
			try {
				const patched = this.removeMcpServer(config);
				if (patched) {
					if (Object.keys(config).length === 0) {
						rmSync(this.getMcpConfigPath(), { force: true });
						filesRemoved.push(this.getMcpConfigPath());
					} else {
						atomicWriteJson(this.getMcpConfigPath(), config);
						configsPatched.push(this.getMcpConfigPath());
					}
				}
			} catch {
				// Non-fatal; leave user config untouched on parse/shape errors.
			}
		}

		return { filesRemoved, configsPatched };
	}

	isInstalled(): boolean {
		try {
			const config = readJsonObject(this.getMcpConfigPath());
			return "signet" in readMcpServers(config);
		} catch {
			return false;
		}
	}

	static isHarnessInstalled(): boolean {
		const home = getHomeDir();
		return (
			existsSync(readTrimmedEnv("FORGE_CONFIG") ?? "") ||
			existsSync(join(home, "forge", ".mcp.json")) ||
			existsSync(join(home, ".forge", ".mcp.json")) ||
			existsSync(join(home, "forge")) ||
			existsSync(join(home, ".forge"))
		);
	}

	private getAgentsPath(): string {
		return join(this.getForgeHome(), "AGENTS.md");
	}

	private getSkillsPath(): string {
		return join(this.getForgeHome(), "skills");
	}

	private getMcpConfigPath(): string {
		return join(this.getForgeHome(), ".mcp.json");
	}

	private generateAgentsMd(basePath: string): string | null {
		const sourcePath = join(basePath, "AGENTS.md");
		if (!existsSync(sourcePath)) return null;

		const raw = readFileSync(sourcePath, "utf-8");
		const userContent = this.stripSignetBlock(raw).trim();
		const extras = this.composeIdentityExtras(basePath);
		const body = extras ? `${userContent}${extras}` : userContent;
		const header = this.generateHeader(sourcePath, this.name);
		const targetPath = this.getAgentsPath();
		writeFileSync(targetPath, `# ${SIGNET_FORGE_MARKER}\n${header}${body}\n`, "utf-8");
		return targetPath;
	}

	private registerMcpServer(config: JsonObject, basePath: string): void {
		const servers = readMcpServers(config);
		servers.signet = buildMcpServer(basePath);
		config.mcpServers = servers;
	}

	private removeMcpServer(config: JsonObject): boolean {
		const servers = readMcpServers(config);
		if (!("signet" in servers)) return false;
		const { signet: _, ...rest } = servers;
		if (Object.keys(rest).length === 0) {
			delete config.mcpServers;
		} else {
			config.mcpServers = rest;
		}
		return true;
	}

	private extractSignetPath(config: JsonObject): string | null {
		const servers = config.mcpServers;
		if (!isJsonObject(servers)) return null;
		const signet = servers.signet;
		if (!isJsonObject(signet)) return null;
		const env = signet.env;
		if (!isJsonObject(env)) return null;
		const value = env.SIGNET_PATH;
		return typeof value === "string" && value.length > 0 ? value : null;
	}

	private removeSkillSymlinks(filesRemoved: string[], signetPath: string | null): void {
		const skillsDir = this.getSkillsPath();
		if (!existsSync(skillsDir)) return;
		const skillsSource = resolve(signetPath ?? resolveSignetWorkspacePath(), "skills");

		let entries: string[];
		try {
			entries = readdirSync(skillsDir);
		} catch {
			return;
		}

		for (const entry of entries) {
			const entryPath = join(skillsDir, entry);
			try {
				if (!lstatSync(entryPath).isSymbolicLink()) continue;
				const rawTarget = readlinkSync(entryPath);
				const target = resolve(skillsDir, rawTarget);
				if (!isChildOf(target, skillsSource)) continue;
				unlinkSync(entryPath);
				filesRemoved.push(entryPath);
			} catch {
				// Ignore individual broken or unreadable symlinks.
			}
		}

		try {
			if (readdirSync(skillsDir).length === 0) rmSync(skillsDir, { recursive: true, force: true });
		} catch {
			// Non-fatal.
		}
	}
}

export const forgeConnector = new ForgeConnector();
export default ForgeConnector;
