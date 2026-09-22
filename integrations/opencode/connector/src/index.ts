import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import {
	BaseConnector,
	type InstallResult,
	type UninstallResult,
	atomicWriteJson,
	atomicWriteText,
	buildSignetRuntimeEnv,
	isJsonObject,
	isSignetGeneratedFile,
	readTrimmedEnv,
	resolveRemoteDaemonUrl,
	resolveSignetMcpCommand,
} from "@signet/connector-base";
import { parseLenientJsonObject } from "@signet/connector-base/lenient-json";
import {
	OPENCODE_PIPELINE_AGENT,
	OPENCODE_PIPELINE_SYSTEM_PROMPT,
	expandHome,
	hasValidIdentity,
	loadIdentityMode,
} from "@signet/core";
import { applyEdits, modify } from "jsonc-parser/lib/esm/main.js";
import { PLUGIN_BUNDLE } from "./plugin-bundle.js";

type JsonObject = Record<string, unknown>;

const API_KEY_FILE_NAME = ".signet-api-key";

function buildPluginBundle(apiKeyFilePath?: string): string {
	const env = buildSignetRuntimeEnv();
	if (apiKeyFilePath) Reflect.deleteProperty(env, "SIGNET_API_KEY");
	const assignments = Object.entries(env).map(
		([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`,
	);
	if (apiKeyFilePath) {
		assignments.unshift('import { readFileSync as __signetReadFileSync } from "node:fs";');
		assignments.push(
			`process.env["SIGNET_API_KEY"] = __signetReadFileSync(${JSON.stringify(apiKeyFilePath)}, "utf-8").trim();`,
		);
	}
	if (assignments.length === 0) return PLUGIN_BUNDLE;
	return `${assignments.join("\n")}\n${PLUGIN_BUNDLE}`;
}

function formattingOptions(source: string): { insertSpaces: boolean; tabSize: number; eol: string } {
	const indent = source.match(/(?:^|\r?\n)([\t ]+)"/)?.[1];
	return {
		insertSpaces: !indent?.includes("\t"),
		tabSize: indent && !indent.includes("\t") ? indent.length : 2,
		eol: source.includes("\r\n") ? "\r\n" : "\n",
	};
}

function writeConfigValue(configPath: string, path: readonly (string | number)[], value: unknown): void {
	const raw = readFileSync(configPath, "utf-8");
	const hasBom = raw.startsWith("\uFEFF");
	const source = hasBom ? raw.slice(1) : raw;
	const edits = modify(source, [...path], value, { formattingOptions: formattingOptions(source) });
	if (edits.length === 0) return;
	const updated = applyEdits(source, edits);
	atomicWriteText(configPath, hasBom ? `\uFEFF${updated}` : updated);
}

function configuredDaemonUrl(): string | undefined {
	return resolveRemoteDaemonUrl() ?? undefined;
}
export class OpenCodeConnector extends BaseConnector {
	readonly name = "OpenCode";
	readonly harnessId = "opencode";

	getIconAsset(): string {
		return "opencode.svg";
	}

	protected getOpenCodePath(): string {
		return join(homedir(), ".config", "opencode");
	}

	getConfigPath(): string {
		const opencodePath = this.getOpenCodePath();
		for (const candidate of this.getConfigCandidates(opencodePath)) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}
		return join(opencodePath, "opencode.jsonc");
	}

	private getPluginsPath(opencodePath: string): string {
		return join(opencodePath, "plugins");
	}

	private getPluginFilePath(opencodePath: string): string {
		return join(this.getPluginsPath(opencodePath), "signet.mjs");
	}

	private getApiKeyFilePath(opencodePath: string): string {
		return join(this.getPluginsPath(opencodePath), API_KEY_FILE_NAME);
	}

	private getPluginConfigEntry(opencodePath: string): string {
		return `./${relative(opencodePath, this.getPluginFilePath(opencodePath)).replaceAll("\\", "/")}`;
	}
	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const expandedBasePath = expandHome(basePath || join(homedir(), ".agents"));
		const daemonUrl = configuredDaemonUrl();
		const identityAvailable = hasValidIdentity(expandedBasePath);
		const identityMode = identityAvailable ? loadIdentityMode(expandedBasePath) : undefined;

		if (!identityAvailable && !daemonUrl) {
			return {
				success: false,
				message: `No valid Signet identity found at ${expandedBasePath}`,
				filesWritten,
			};
		}

		const opencodePath = this.getOpenCodePath();
		const pluginsPath = this.getPluginsPath(opencodePath);
		this.validateConfigCandidates(opencodePath);

		if (identityAvailable) {
			const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
			if (strippedAgentsPath !== null) {
				filesWritten.push(strippedAgentsPath);
			}
		}

		if (!existsSync(opencodePath)) {
			mkdirSync(opencodePath, { recursive: true });
		}

		if (!existsSync(pluginsPath)) {
			mkdirSync(pluginsPath, { recursive: true });
		}
		this.migrateFromLegacy(opencodePath);
		const apiKey = readTrimmedEnv("SIGNET_API_KEY") ?? readTrimmedEnv("SIGNET_TOKEN");
		const apiKeyFilePath = this.getApiKeyFilePath(opencodePath);
		if (apiKey) {
			atomicWriteText(apiKeyFilePath, `${apiKey}\n`, 0o600);
			filesWritten.push(apiKeyFilePath);
		} else if (existsSync(apiKeyFilePath)) {
			rmSync(apiKeyFilePath);
		}
		const pluginFilePath = this.getPluginFilePath(opencodePath);
		writeFileSync(pluginFilePath, buildPluginBundle(apiKey ? apiKeyFilePath : undefined));
		filesWritten.push(pluginFilePath);
		this.ensureConfigFile(opencodePath);
		this.registerPlugin(opencodePath);
		if (identityMode === "managed") {
			const agentsMdPath = await this.generateAgentsMd(expandedBasePath);
			if (agentsMdPath) {
				filesWritten.push(agentsMdPath);
			}
		} else {
			const staleAgentsMd = join(this.getOpenCodePath(), "AGENTS.md");
			if (existsSync(staleAgentsMd)) {
				try {
					const raw = readFileSync(staleAgentsMd, "utf-8");
					if (isSignetGeneratedFile(raw)) {
						rmSync(staleAgentsMd);
					}
				} catch {}
			}
		}
		this.registerMcpServer(opencodePath, daemonUrl, apiKey ? `./plugins/${API_KEY_FILE_NAME}` : undefined);
		this.registerPipelineAgent(opencodePath);
		const skillsSource = join(expandedBasePath, "skills");
		const skillsDest = join(opencodePath, "skills");
		if (identityAvailable && existsSync(skillsSource)) {
			this.symlinkSkills(skillsSource, skillsDest);
		}

		return {
			success: true,
			message: "OpenCode integration installed successfully",
			filesWritten,
		};
	}
	async uninstall(): Promise<UninstallResult> {
		const opencodePath = this.getOpenCodePath();
		const filesRemoved: string[] = [];

		const pluginFilePath = this.getPluginFilePath(opencodePath);
		if (existsSync(pluginFilePath)) {
			rmSync(pluginFilePath);
			filesRemoved.push(pluginFilePath);
		}

		const apiKeyFilePath = this.getApiKeyFilePath(opencodePath);
		if (existsSync(apiKeyFilePath)) {
			rmSync(apiKeyFilePath);
			filesRemoved.push(apiKeyFilePath);
		}

		const agentsMdPath = join(opencodePath, "AGENTS.md");
		if (existsSync(agentsMdPath)) {
			try {
				const raw = readFileSync(agentsMdPath, "utf-8");
				if (isSignetGeneratedFile(raw)) {
					rmSync(agentsMdPath);
					filesRemoved.push(agentsMdPath);
				}
			} catch {}
		}

		this.migrateFromLegacy(opencodePath);
		this.removePlugin(opencodePath);
		this.removeMcpServer(opencodePath);
		this.removePipelineAgent(opencodePath);

		return { filesRemoved };
	}
	isInstalled(): boolean {
		return existsSync(this.getPluginFilePath(this.getOpenCodePath()));
	}
	static isHarnessInstalled(): boolean {
		const opencodePath = join(homedir(), ".config", "opencode");
		const candidates = [
			join(opencodePath, "opencode.json"),
			join(opencodePath, "opencode.jsonc"),
			join(opencodePath, "config.json"),
		];

		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				return true;
			}
		}

		return false;
	}
	private migrateFromLegacy(opencodePath: string): void {
		const legacyPluginPath = join(opencodePath, "memory.mjs");
		if (existsSync(legacyPluginPath)) rmSync(legacyPluginPath);

		for (const configPath of this.getConfigCandidates(opencodePath)) {
			if (!existsSync(configPath)) continue;
			const config = this.readConfigForCleanup(configPath);
			if (!config) continue;
			for (const key of ["plugin", "plugins"] as const) {
				const entries = Array.isArray(config[key]) ? config[key] : [];
				this.removeArrayEntries(configPath, key, entries, (entry) => this.isLegacyPluginEntry(entry));
			}
		}
	}

	private readConfig(configPath: string): JsonObject {
		try {
			return parseLenientJsonObject(readFileSync(configPath, "utf-8"), { label: "OpenCode config" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Cannot update OpenCode config ${configPath}: ${message}`);
		}
	}

	private validateConfigCandidates(opencodePath: string): void {
		for (const configPath of this.getConfigCandidates(opencodePath)) {
			if (existsSync(configPath)) this.readConfig(configPath);
		}
	}

	private readConfigForCleanup(configPath: string): JsonObject | undefined {
		try {
			return this.readConfig(configPath);
		} catch (error) {
			console.warn(`[signet] Warning: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	private isLegacyPluginEntry(entry: unknown): boolean {
		if (typeof entry !== "string") return false;
		const trimmed = entry.trim();
		return trimmed === "./memory.mjs" || trimmed === "memory.mjs" || trimmed.endsWith("/memory.mjs");
	}

	private pluginSpecifier(entry: unknown): string | undefined {
		if (typeof entry === "string") return entry;
		if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
		return undefined;
	}

	private removeArrayEntries(
		configPath: string,
		key: string,
		entries: readonly unknown[],
		shouldRemove: (entry: unknown) => boolean,
	): void {
		for (let index = entries.length - 1; index >= 0; index--) {
			if (shouldRemove(entries[index])) writeConfigValue(configPath, [key, index], undefined);
		}
	}

	private registerPlugin(opencodePath: string): void {
		const pluginEntry = this.getPluginConfigEntry(opencodePath);
		this.removePlugin(opencodePath);
		const configPath = this.getConfigPath();
		const config = this.readConfig(configPath);
		const entries = Array.isArray(config.plugin) ? config.plugin : [];
		if (Array.isArray(config.plugin)) {
			writeConfigValue(configPath, ["plugin", entries.length], pluginEntry);
		} else {
			writeConfigValue(configPath, ["plugin"], [pluginEntry]);
		}
	}

	private removePlugin(opencodePath: string): void {
		const pluginEntry = this.getPluginConfigEntry(opencodePath);
		for (const configPath of this.getConfigCandidates(opencodePath)) {
			if (!existsSync(configPath)) continue;
			const config = this.readConfigForCleanup(configPath);
			if (!config) continue;
			const entries = Array.isArray(config.plugin) ? config.plugin : [];
			this.removeArrayEntries(configPath, "plugin", entries, (entry) => this.pluginSpecifier(entry) === pluginEntry);
		}
	}

	private registerMcpServer(opencodePath: string, daemonUrl?: string, apiKeyFile?: string): void {
		this.removeMcpServer(opencodePath);
		const configPath = this.getConfigPath();
		this.readConfig(configPath);

		if (daemonUrl) {
			writeConfigValue(configPath, ["mcp", "signet"], {
				type: "remote",
				url: `${daemonUrl}/mcp`,
				...(apiKeyFile ? { headers: { Authorization: `Bearer {file:${apiKeyFile}}` } } : {}),
				oauth: false,
				enabled: true,
			});
			return;
		}

		const resolvedMcp = resolveSignetMcpCommand();
		const mcpCommand = [resolvedMcp.command, ...resolvedMcp.args];
		const environment = buildSignetRuntimeEnv();
		if (apiKeyFile) environment.SIGNET_API_KEY = `{file:${apiKeyFile}}`;
		writeConfigValue(configPath, ["mcp", "signet"], {
			type: "local",
			command: mcpCommand,
			...(Object.keys(environment).length > 0 ? { environment } : {}),
			enabled: true,
		});
	}

	private removeMcpServer(opencodePath: string): void {
		for (const configPath of this.getConfigCandidates(opencodePath)) {
			if (!existsSync(configPath)) continue;
			const config = this.readConfigForCleanup(configPath);
			if (!config || !isJsonObject(config.mcp) || !("signet" in config.mcp)) continue;
			if (Object.keys(config.mcp).length === 1) {
				writeConfigValue(configPath, ["mcp"], undefined);
			} else {
				writeConfigValue(configPath, ["mcp", "signet"], undefined);
			}
		}
	}

	private static readonly PIPELINE_AGENT_CONFIG: JsonObject = {
		prompt: OPENCODE_PIPELINE_SYSTEM_PROMPT,
		permission: { "*": "deny" },
		hidden: true,
		steps: 1,
		mode: "all",
	};

	private registerPipelineAgent(opencodePath: string): void {
		this.removePipelineAgent(opencodePath);
		const configPath = this.getConfigPath();
		this.readConfig(configPath);
		writeConfigValue(configPath, ["agent", OPENCODE_PIPELINE_AGENT], {
			...OpenCodeConnector.PIPELINE_AGENT_CONFIG,
		});
	}

	private removePipelineAgent(opencodePath: string): void {
		for (const configPath of this.getConfigCandidates(opencodePath)) {
			if (!existsSync(configPath)) continue;
			const config = this.readConfigForCleanup(configPath);
			if (!config || !isJsonObject(config.agent) || !(OPENCODE_PIPELINE_AGENT in config.agent)) continue;
			if (Object.keys(config.agent).length === 1) {
				writeConfigValue(configPath, ["agent"], undefined);
			} else {
				writeConfigValue(configPath, ["agent", OPENCODE_PIPELINE_AGENT], undefined);
			}
		}
	}

	private ensureConfigFile(opencodePath: string): void {
		for (const candidate of this.getConfigCandidates(opencodePath)) {
			if (existsSync(candidate)) return;
		}
		mkdirSync(opencodePath, { recursive: true });
		atomicWriteJson(join(opencodePath, "opencode.jsonc"), {});
	}

	private getConfigCandidates(opencodePath: string): string[] {
		return [
			join(opencodePath, "opencode.jsonc"),
			join(opencodePath, "opencode.json"),
			join(opencodePath, "config.json"),
		];
	}
	private async generateAgentsMd(basePath: string): Promise<string | null> {
		const sourcePath = join(basePath, "AGENTS.md");

		if (!existsSync(sourcePath)) {
			return null;
		}

		const raw = readFileSync(sourcePath, "utf-8");
		const userContent = this.stripSignetBlock(raw);
		const header = this.generateHeader(sourcePath);
		const extras = this.composeIdentityExtras(basePath);

		const destPath = join(this.getOpenCodePath(), "AGENTS.md");
		writeFileSync(destPath, header + userContent + extras);

		return destPath;
	}
}

export const opencodeConnector = new OpenCodeConnector();
export default OpenCodeConnector;
