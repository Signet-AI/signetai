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
import { dirname, join, resolve, sep } from "node:path";
import {
	BaseConnector,
	type InstallResult,
	type UninstallResult,
	atomicWriteJson,
	resolveSignetWorkspacePath,
} from "@signet/connector-base";
import { expandHome, hasValidIdentity } from "@signet/core";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChildOf(candidate: string, parent: string): boolean {
	const prefix = resolve(parent) + sep;
	return candidate.startsWith(prefix);
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
		const geminiHome = this.getGeminiHome();
		const settings = readGeminiSettings(this.getConfigPath());
		const contextConfig = settings?.context;
		if (isJsonObject(contextConfig)) {
			const fileNames = contextConfig.fileName;
			if (Array.isArray(fileNames) && typeof fileNames[0] === "string") {
				const candidate = resolve(geminiHome, fileNames[0]);
				if (isChildOf(candidate, geminiHome)) {
					return candidate;
				}
			}
		}
		return join(geminiHome, "GEMINI.md");
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

		const warnings: string[] = [];
		const mcpConflict = this.registerMcpServer(geminiHome);
		if (mcpConflict) {
			warnings.push(`Could not parse ${mcpConflict} — MCP server not registered. Fix the file and rerun install.`);
		} else {
			configsPatched.push(this.getConfigPath());
		}

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
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];
		const geminiHome = this.getGeminiHome();
		const signetWorkspace = resolveSignetWorkspacePath();

		if (this.removeMcpServer(geminiHome)) {
			configsPatched.push(this.getConfigPath());
		}

		const geminiMdPath = this.getGeminiMdPath();
		if (existsSync(geminiMdPath)) {
			const raw = readFileSync(geminiMdPath, "utf-8");
			if (raw.includes("Auto-generated from")) {
				rmSync(geminiMdPath);
				filesRemoved.push(geminiMdPath);
			}
		}

		const skillsDir = join(geminiHome, "skills");
		if (existsSync(skillsDir)) {
			this.removeSignetSkillSymlinks(skillsDir, signetWorkspace);
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

	private removeSignetSkillSymlinks(skillsDir: string, signetWorkspace: string): void {
		const signetSkillsSource = resolve(signetWorkspace, "skills");
		let entries: string[];
		try {
			entries = readdirSync(skillsDir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const entryPath = join(skillsDir, entry);
			let stat: ReturnType<typeof lstatSync> | null = null;
			try {
				stat = lstatSync(entryPath);
			} catch {
				continue;
			}
			if (stat?.isSymbolicLink()) {
				try {
					const rawTarget = readlinkSync(entryPath);
					const target = resolve(dirname(entryPath), rawTarget);
					if (isChildOf(target, signetSkillsSource)) {
						unlinkSync(entryPath);
					}
				} catch {}
			}
		}
	}

	private registerMcpServer(geminiHome: string): string | null {
		const settingsPath = join(geminiHome, "settings.json");

		if (existsSync(settingsPath)) {
			const settings = readGeminiSettings(settingsPath);
			if (!settings) {
				return settingsPath;
			}

			const existingMcp = isJsonObject(settings.mcpServers) ? (settings.mcpServers as JsonObject) : {};
			settings.mcpServers = {
				...existingMcp,
				signet: {
					command: "signet-mcp",
					args: [],
				},
			};

			atomicWriteJson(settingsPath, settings);
			return null;
		}

		const settings: JsonObject = {
			mcpServers: {
				signet: {
					command: "signet-mcp",
					args: [],
				},
			},
		};

		mkdirSync(geminiHome, { recursive: true });
		atomicWriteJson(settingsPath, settings);
		return null;
	}

	private removeMcpServer(geminiHome: string): boolean {
		const settingsPath = join(geminiHome, "settings.json");
		const settings = readGeminiSettings(settingsPath);
		if (!settings) return false;

		if (isJsonObject(settings.mcpServers)) {
			const mcp = settings.mcpServers as JsonObject;
			if (!("signet" in mcp)) return false;
			const { signet: _, ...rest } = mcp;
			if (Object.keys(rest).length === 0) {
				const { mcpServers: __, ...withoutMcp } = settings;
				atomicWriteJson(settingsPath, withoutMcp);
			} else {
				settings.mcpServers = rest;
				atomicWriteJson(settingsPath, settings);
			}
			return true;
		}
		return false;
	}

	private generateGeminiMd(basePath: string): string | null {
		const sourcePath = join(basePath, "AGENTS.md");
		if (!existsSync(sourcePath)) return null;

		const raw = readFileSync(sourcePath, "utf-8");
		const userContent = this.stripSignetBlock(raw);
		const header = this.generateHeader(sourcePath);
		const extras = this.composeIdentityExtras(basePath);

		const destPath = this.getGeminiMdPath();
		mkdirSync(dirname(destPath), { recursive: true });
		writeFileSync(destPath, header + userContent + extras);
		return destPath;
	}
}

export const geminiConnector = new GeminiConnector();
export default GeminiConnector;
