import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseConnector, type InstallResult, type UninstallResult, atomicWriteJson } from "@signet/connector-base";
import { expandHome, hasValidIdentity } from "@signet/core";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readGeminiSettings(settingsPath: string): JsonObject | null {
	if (!existsSync(settingsPath)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
		return isJsonObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export class GeminiConnector extends BaseConnector {
	readonly name = "Gemini";
	readonly harnessId = "gemini";

	private getGeminiHome(): string {
		return join(homedir(), ".gemini");
	}

	getConfigPath(): string {
		return join(this.getGeminiHome(), "settings.json");
	}

	private getGeminiMdPath(): string {
		const settings = readGeminiSettings(this.getConfigPath());
		const contextConfig = settings?.context;
		if (isJsonObject(contextConfig)) {
			const fileNames = contextConfig.fileName;
			if (Array.isArray(fileNames) && typeof fileNames[0] === "string") {
				return join(this.getGeminiHome(), fileNames[0]);
			}
		}
		return join(this.getGeminiHome(), "GEMINI.md");
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const configsPatched: string[] = [];
		const expandedBasePath = expandHome(basePath || join(homedir(), ".agents"));

		if (!hasValidIdentity(expandedBasePath)) {
			return {
				success: false,
				message: `No valid Signet identity found at ${expandedBasePath}`,
				filesWritten,
			};
		}

		const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
		if (strippedAgentsPath !== null) {
			filesWritten.push(strippedAgentsPath);
		}

		const geminiHome = this.getGeminiHome();
		if (!existsSync(geminiHome)) {
			mkdirSync(geminiHome, { recursive: true });
		}

		this.registerMcpServer(geminiHome);
		configsPatched.push(this.getConfigPath());

		const geminiMdPath = this.generateGeminiMd(expandedBasePath);
		if (geminiMdPath) {
			filesWritten.push(geminiMdPath);
		}

		const skillsSource = join(expandedBasePath, "skills");
		const skillsDest = join(geminiHome, "skills");
		if (existsSync(skillsSource)) {
			this.symlinkSkills(skillsSource, skillsDest);
		}

		return {
			success: true,
			message: "Gemini CLI integration installed — MCP server + GEMINI.md + skills",
			filesWritten,
			configsPatched,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];
		const geminiHome = this.getGeminiHome();

		this.removeMcpServer(geminiHome);
		configsPatched.push(this.getConfigPath());

		const geminiMdPath = this.getGeminiMdPath();
		if (existsSync(geminiMdPath)) {
			const raw = readFileSync(geminiMdPath, "utf-8");
			if (raw.includes("Auto-generated from")) {
				rmSync(geminiMdPath);
				filesRemoved.push(geminiMdPath);
			}
		}

		const skillsLink = join(geminiHome, "skills");
		if (existsSync(skillsLink)) {
			rmSync(skillsLink, { force: true, recursive: true });
			filesRemoved.push(skillsLink);
		}

		return { filesRemoved, configsPatched };
	}

	isInstalled(): boolean {
		const settings = readGeminiSettings(this.getConfigPath());
		if (!settings) return false;
		const mcpServers = settings.mcpServers;
		return isJsonObject(mcpServers) && "signet" in mcpServers;
	}

	static isHarnessInstalled(): boolean {
		return existsSync(join(homedir(), ".gemini", "settings.json"));
	}

	private registerMcpServer(geminiHome: string): void {
		const settingsPath = join(geminiHome, "settings.json");
		const settings = readGeminiSettings(settingsPath) ?? {};

		const existingMcp = isJsonObject(settings.mcpServers) ? (settings.mcpServers as JsonObject) : {};
		settings.mcpServers = {
			...existingMcp,
			signet: {
				command: "signet-mcp",
				args: [],
			},
		};

		mkdirSync(geminiHome, { recursive: true });
		atomicWriteJson(settingsPath, settings);
	}

	private removeMcpServer(geminiHome: string): void {
		const settingsPath = join(geminiHome, "settings.json");
		const settings = readGeminiSettings(settingsPath);
		if (!settings) return;

		if (isJsonObject(settings.mcpServers)) {
			const mcp = settings.mcpServers as JsonObject;
			const { signet: _, ...rest } = mcp;
			if (Object.keys(rest).length === 0) {
				const { mcpServers: __, ...withoutMcp } = settings;
				atomicWriteJson(settingsPath, withoutMcp);
			} else {
				settings.mcpServers = rest;
				atomicWriteJson(settingsPath, settings);
			}
		}
	}

	private generateGeminiMd(basePath: string): string | null {
		const sourcePath = join(basePath, "AGENTS.md");
		if (!existsSync(sourcePath)) return null;

		const raw = readFileSync(sourcePath, "utf-8");
		const userContent = this.stripSignetBlock(raw);
		const header = this.generateHeader(sourcePath);
		const extras = this.composeIdentityExtras(basePath);

		const destPath = this.getGeminiMdPath();
		writeFileSync(destPath, header + userContent + extras);
		return destPath;
	}
}

export const geminiConnector = new GeminiConnector();
export default GeminiConnector;
