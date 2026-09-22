import { spawnHidden as spawn } from "@signet/core";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	BaseConnector,
	type InstallResult,
	type UninstallResult,
	atomicWriteJson,
	isSignetGeneratedFile,
	resolveSignetMcpCommand,
} from "@signet/connector-base";
import { expandHome, resolvePromptSubmitTimeoutMs, resolveSessionStartTimeoutMs } from "@signet/core";

export interface ConnectorConfig {
	daemonUrl?: string;
	hooks?: {
		sessionStart?: boolean;
		userPromptSubmit?: boolean;
		preCompact?: boolean;
		sessionEnd?: boolean;
	};
}

export interface SessionContext {
	projectPath?: string;
	sessionId?: string;
	harness?: string;
	transcriptPath?: string;
}

export interface SessionStartResult {
	identity: {
		name: string;
		description?: string;
	};
	memories: Array<{
		id: number;
		content: string;
		type: string;
		importance: number;
		created_at: string;
	}>;
	recentContext?: string;
	stableSystemPrompt?: string;
	dynamicContext?: string;
	inject: string;
	contextHash?: string;
	contextVersion?: number;
}

export interface SessionEndResult {
	success: boolean;
	memoriesExtracted: number;
}

export interface SessionEndFireAndForgetPayload {
	harness: "claude-code";
	sessionId?: string;
	transcriptPath?: string;
}

type DetachedSpawn = typeof spawn;

const SESSION_END_FIRE_AND_FORGET_SCRIPT = `
void (async () => {
  const url = process.env.SIGNET_SESSION_END_URL;
  const body = process.env.SIGNET_SESSION_END_BODY;
  if (!url || !body) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
})();
`;
export function dispatchSessionEndFireAndForget(
	daemonUrl: string,
	payload: SessionEndFireAndForgetPayload,
	spawnImpl: DetachedSpawn = spawn,
): boolean {
	try {
		const url = `${daemonUrl.replace(/\/$/, "")}/api/hooks/session-end`;
		const body = JSON.stringify(payload);
		const child = spawnImpl(process.execPath, ["--eval", SESSION_END_FIRE_AND_FORGET_SCRIPT], {
			detached: true,
			stdio: "ignore",
			env: {
				...process.env,
				SIGNET_SESSION_END_URL: url,
				SIGNET_SESSION_END_BODY: body,
			},
		});
		child.unref();
		return true;
	} catch (error) {
		console.warn("[signet] session-end fire-and-forget dispatch failed:", error);
		return false;
	}
}
function sessionStartHookTimeout(): number {
	const raw = process.env.SIGNET_SESSION_START_TIMEOUT ?? process.env.SIGNET_FETCH_TIMEOUT;
	return resolveSessionStartTimeoutMs(raw) + 2_000;
}

function userPromptSubmitHookTimeout(): number {
	return resolvePromptSubmitTimeoutMs(process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT) + 2_000;
}
export class ClaudeCodeConnector extends BaseConnector {
	readonly name = "Claude Code";
	readonly harnessId = "claude-code";

	getIconAsset(): string {
		return "claude.svg";
	}

	private config: ConnectorConfig;
	private daemonUrl: string;

	constructor(config: ConnectorConfig = {}) {
		super();
		this.config = config;
		this.daemonUrl = config.daemonUrl || "http://127.0.0.1:3850";
	}
	async install(basePath: string): Promise<InstallResult> {
		const expandedBasePath = expandHome(basePath);
		const filesWritten: string[] = [];
		const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
		if (strippedAgentsPath !== null) {
			filesWritten.push(strippedAgentsPath);
		}
		await this.configureHooks(expandedBasePath);
		const settingsPath = this.getConfigPath();
		filesWritten.push(settingsPath);
		const staleClaude = join(homedir(), ".claude", "CLAUDE.md");
		try {
			if (existsSync(staleClaude)) {
				const content = readFileSync(staleClaude, "utf-8");
				if (isSignetGeneratedFile(content)) {
					unlinkSync(staleClaude);
				}
			}
		} catch {}
		const sourceSkillsDir = join(expandedBasePath, "skills");
		const targetSkillsDir = join(homedir(), ".claude", "skills");
		this.symlinkSkills(sourceSkillsDir, targetSkillsDir);

		return {
			success: true,
			message: "Claude Code integration installed successfully",
			filesWritten,
		};
	}
	async uninstall(): Promise<UninstallResult> {
		const settingsPath = this.getConfigPath();
		const filesRemoved: string[] = [];

		if (!existsSync(settingsPath)) {
			return { filesRemoved };
		}

		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			if (settings.hooks) {
				settings.hooks.SessionStart = undefined;
				settings.hooks.UserPromptSubmit = undefined;
				settings.hooks.PreToolUse = undefined;
				settings.hooks.PreCompaction = undefined;
				settings.hooks.PreCompact = undefined;
				settings.hooks.SessionEnd = undefined;
				if (Object.keys(settings.hooks).length === 0) {
					settings.hooks = undefined;
				}
			}

			atomicWriteJson(settingsPath, settings);
			filesRemoved.push(settingsPath);
		} catch {}
		this.removeMcpServer();

		return { filesRemoved };
	}
	isInstalled(): boolean {
		const settingsPath = this.getConfigPath();

		if (!existsSync(settingsPath)) return false;

		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			const cmd = settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? "";
			return cmd.includes("hook session-start");
		} catch {
			return false;
		}
	}
	getConfigPath(): string {
		return join(homedir(), ".claude", "settings.json");
	}
	async onSessionStart(ctx: SessionContext): Promise<SessionStartResult | null> {
		try {
			const res = await fetch(`${this.daemonUrl}/api/hooks/session-start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					harness: "claude-code",
					project: ctx.projectPath,
					sessionKey: ctx.sessionId,
				}),
				signal: AbortSignal.timeout(5000),
			});

			if (!res.ok) {
				console.warn("[signet] Session start hook failed:", res.status);
				return null;
			}

			return (await res.json()) as SessionStartResult;
		} catch (e) {
			console.warn("[signet] Session start hook error:", e);
			return null;
		}
	}

	protected dispatchSessionEnd(payload: SessionEndFireAndForgetPayload): boolean {
		return dispatchSessionEndFireAndForget(this.daemonUrl, payload);
	}
	async onSessionEnd(ctx: SessionContext): Promise<SessionEndResult> {
		const dispatched = this.dispatchSessionEnd({
			harness: "claude-code",
			sessionId: ctx.sessionId,
			transcriptPath: ctx.transcriptPath,
		});

		return { success: dispatched, memoriesExtracted: 0 };
	}
	private async configureHooks(_basePath: string): Promise<void> {
		const settingsPath = this.getConfigPath();
		const claudeDir = join(homedir(), ".claude");

		mkdirSync(claudeDir, { recursive: true });

		let settings: Record<string, unknown> = {};
		if (existsSync(settingsPath)) {
			try {
				settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			} catch {
				settings = {};
			}
		}

		const hooksConfig = this.config.hooks || {
			sessionStart: true,
			userPromptSubmit: true,
			preCompact: true,
			sessionEnd: true,
		};
		let signetCmd = "signet";
		if (process.platform === "win32") {
			const cliEntry = process.argv[1] || "";
			const signetJs = join(cliEntry, "..", "..", "bin", "signet.js");
			if (existsSync(signetJs)) {
				signetCmd = `"${process.execPath}" "${signetJs}"`;
			}
		}
		const pwdExpr = process.platform === "win32" ? "%CD%" : "$(pwd)";

		const hooks: Record<string, unknown[]> = {};

		if (hooksConfig.sessionStart !== false) {
			hooks.SessionStart = [
				{
					hooks: [
						{
							type: "command",
							command: `${signetCmd} hook session-start -H claude-code --project "${pwdExpr}"`,
							timeout: sessionStartHookTimeout(),
						},
					],
				},
			];
		}

		if (hooksConfig.userPromptSubmit !== false) {
			hooks.UserPromptSubmit = [
				{
					hooks: [
						{
							type: "command",
							command: `${signetCmd} hook user-prompt-submit -H claude-code --project "${pwdExpr}"`,
							timeout: userPromptSubmitHookTimeout(),
						},
					],
				},
			];
		}

		if (hooksConfig.userPromptSubmit !== false) {
			hooks.PreToolUse = [
				{
					hooks: [
						{
							type: "command",
							command: `${signetCmd} hook notifications -H claude-code --hook PreToolUse --project "${pwdExpr}" --hook-json`,
							timeout: 3000,
						},
					],
				},
			];
		}

		if (hooksConfig.preCompact !== false) {
			hooks.PreCompact = [
				{
					hooks: [
						{
							type: "command",
							command: `${signetCmd} hook pre-compaction -H claude-code --project "${pwdExpr}"`,
							timeout: 3000,
						},
					],
				},
			];
		}

		if (hooksConfig.sessionEnd !== false) {
			hooks.SessionEnd = [
				{
					hooks: [
						{
							type: "command",
							command: `${signetCmd} hook session-end -H claude-code`,
							timeout: 15000,
						},
					],
				},
			];
		}

		settings.hooks = {
			...(settings.hooks as Record<string, unknown>),
			...hooks,
		};
		const { PreCompaction: _legacyPreCompaction, ...hooksWithoutLegacy } = settings.hooks as Record<string, unknown>;
		settings.hooks = hooksWithoutLegacy;

		atomicWriteJson(settingsPath, settings);
		this.registerMcpServer();
	}
	private registerMcpServer(): void {
		const claudeJsonPath = join(homedir(), ".claude.json");

		let config: Record<string, unknown> = {};
		if (existsSync(claudeJsonPath)) {
			try {
				config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
			} catch {
				return;
			}
		}

		const mcp = resolveSignetMcpCommand();

		const existingMcp = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
		config.mcpServers = {
			...existingMcp,
			signet: {
				type: "stdio",
				command: mcp.command,
				args: mcp.args,
				env: {},
			},
		};

		atomicWriteJson(claudeJsonPath, config);
	}
	private removeMcpServer(): void {
		const claudeJsonPath = join(homedir(), ".claude.json");

		if (!existsSync(claudeJsonPath)) return;

		let config: Record<string, unknown>;
		try {
			config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
		} catch {
			return;
		}

		if (config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)) {
			const mcp = config.mcpServers as Record<string, unknown>;
			const { signet: _signetMcp, ...restMcp } = mcp;
			if (Object.keys(restMcp).length === 0) {
				const { mcpServers: _mcpServers, ...restConfig } = config;
				config = restConfig;
			} else {
				config.mcpServers = restMcp;
			}
			atomicWriteJson(claudeJsonPath, config);
		}
	}
}
export function createConnector(config?: ConnectorConfig): ClaudeCodeConnector {
	return new ClaudeCodeConnector(config);
}
export default ClaudeCodeConnector;
