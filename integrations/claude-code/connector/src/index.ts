import { NodeTransport, resolveTarget } from "@signet/sdk/node";
import { SignetUnauthorizedError } from "@signet/sdk";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	BaseConnector,
	captureRemoteSessionEnd,
	type InstallResult,
	type UninstallResult,
	atomicWriteJson,
	isJsonObject,
	isSignetGeneratedFile,
	resolveSignetMcpCommand,
	resolveHarnessMcpCommand,
	resolveSignetCliCommand,
	parseHookLauncher,
	isSignetCliLauncher,
	readMcpLauncher,
	renderCommand,
	mcpFromCli,
	cliFromMcp,
	type ResolvedCommand,
} from "@signet/connector-base";
import { expandHome, resolvePromptSubmitTimeoutMs, resolveSessionStartTimeoutFromEnv } from "@signet/core";

export interface ConnectorConfig {
	daemonUrl?: string;
	hooks?: {
		sessionStart?: boolean;
		userPromptSubmit?: boolean;
		preCompact?: boolean;
		sessionEnd?: boolean;
		stop?: boolean;
	};
}

export interface SessionContext {
	projectPath?: string;
	sessionId?: string;
	harness?: string;
	transcriptPath?: string;
}

const WAKE_HOOK_TIMEOUT_SECONDS = 3600;
const PRE_COMPACTION_DAEMON_WAIT_MS = 5_000;
const SESSION_END_HOOK_TIMEOUT_SECONDS = 15;
const HOOK_GRACE_MS = 5_000;

function readClaudeSettings(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Refusing to modify ${path}: could not parse JSON (${reason})`);
	}
	if (!isJsonObject(parsed)) throw new Error(`Refusing to modify ${path}: settings must be a JSON object`);
	if (parsed.hooks !== undefined && !isJsonObject(parsed.hooks)) {
		throw new Error(`Refusing to modify ${path}: hooks must be a JSON object`);
	}
	return parsed;
}

function signetHookName(hook: unknown): string | undefined {
	const command = isJsonObject(hook) ? hook.command : undefined;
	if (typeof command !== "string") return undefined;
	const match =
		/ hook (session-start|user-prompt-submit|notifications|pre-compaction|session-end|wake|stop) -H claude-code(?:\s|$)/.exec(
			command,
		);
	if (!match || !isSignetCliLauncher(parseHookLauncher(command))) return undefined;
	return match[1];
}

function readClaudeMcpSettings(): Record<string, unknown> | undefined {
	const path = join(homedir(), ".claude.json");
	if (!existsSync(path)) return {};
	try {
		const config: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return isJsonObject(config) ? config : undefined;
	} catch {
		return undefined;
	}
}

function innerHooks(group: unknown): unknown[] | undefined {
	const inner = isJsonObject(group) ? group.hooks : undefined;
	return Array.isArray(inner) ? inner : undefined;
}

function stripSignetGroups(groups: unknown[]): unknown[] {
	const kept: unknown[] = [];
	for (const group of groups) {
		if (!isJsonObject(group) || !Array.isArray(group.hooks)) {
			kept.push(group);
			continue;
		}
		const rest = group.hooks.filter((hook) => signetHookName(hook) === undefined);
		if (rest.length === group.hooks.length) kept.push(group);
		else if (rest.length > 0) kept.push({ ...group, hooks: rest });
	}
	return kept;
}

function withoutSignetHooks(hooks: unknown): Record<string, unknown> {
	const kept: Record<string, unknown> = {};
	if (!isJsonObject(hooks)) return kept;
	for (const [event, groups] of Object.entries(hooks)) {
		if (!Array.isArray(groups)) {
			kept[event] = groups;
			continue;
		}
		const rest = stripSignetGroups(groups);
		if (rest.length > 0) kept[event] = rest;
	}
	return kept;
}

function nonEmpty(hooks: Record<string, unknown>): Record<string, unknown> | undefined {
	return Object.keys(hooks).length > 0 ? hooks : undefined;
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

export async function dispatchSessionEndFireAndForget(
	daemonUrl: string,
	payload: SessionEndFireAndForgetPayload,
): Promise<boolean> {
	try {
		const target = await resolveTarget({ harness: "claude-code", configUrl: daemonUrl });
		const transport = new NodeTransport(target, { headers: { "x-signet-runtime-path": "legacy" } });
		await transport.post("/api/hooks/session-end", target.remote ? await captureRemoteSessionEnd(payload) : payload);
		return true;
	} catch (error) {
		console.warn(
			error instanceof SignetUnauthorizedError
				? "Signet session expired, run `signet login`"
				: "[signet] session-end delivery failed; inspect the connector outbox",
		);
		return false;
	}
}
function hookTimeoutSeconds(budgetMs: number): number {
	return Math.ceil((budgetMs + HOOK_GRACE_MS) / 1_000);
}

function sessionStartHookTimeoutSeconds(): number {
	return hookTimeoutSeconds(resolveSessionStartTimeoutFromEnv());
}

function userPromptSubmitHookTimeoutSeconds(): number {
	return hookTimeoutSeconds(resolvePromptSubmitTimeoutMs(process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT));
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
		resolveSignetCliCommand();
		const expandedBasePath = expandHome(basePath);
		const settingsPath = this.getConfigPath();
		const settings = readClaudeSettings(settingsPath);
		const filesWritten: string[] = [];
		const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
		if (strippedAgentsPath !== null) {
			filesWritten.push(strippedAgentsPath);
		}
		this.configureHooks(settingsPath, settings, readClaudeMcpSettings());
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
		if (!existsSync(settingsPath)) {
			this.removeMcpServer();
			return { filesRemoved: [] };
		}

		const settings = readClaudeSettings(settingsPath);
		if (settings.hooks) {
			settings.hooks = nonEmpty(withoutSignetHooks(settings.hooks));
		}
		atomicWriteJson(settingsPath, settings);
		this.removeMcpServer();

		return { filesRemoved: [settingsPath] };
	}
	isInstalled(): boolean {
		const settingsPath = this.getConfigPath();

		if (!existsSync(settingsPath)) return false;

		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			const groups: unknown = settings.hooks?.SessionStart;
			return (
				Array.isArray(groups) &&
				groups.some((group) => innerHooks(group)?.some((hook) => signetHookName(hook) === "session-start"))
			);
		} catch {
			return false;
		}
	}
	getConfigPath(): string {
		return join(homedir(), ".claude", "settings.json");
	}
	async onSessionStart(ctx: SessionContext): Promise<SessionStartResult | null> {
		try {
			const transport = new NodeTransport(await resolveTarget({ harness: "claude-code", configUrl: this.daemonUrl }), {
				headers: { "x-signet-runtime-path": "legacy" },
			});
			return await transport.post<SessionStartResult>(
				"/api/hooks/session-start",
				{ harness: "claude-code", project: ctx.projectPath, sessionKey: ctx.sessionId },
				{ timeoutMs: 5000 },
			);
		} catch (error) {
			console.warn(
				error instanceof SignetUnauthorizedError
					? "Signet session expired, run `signet login`"
					: "[signet] Session start delivery failed",
			);
			return null;
		}
	}
	protected dispatchSessionEnd(payload: SessionEndFireAndForgetPayload): Promise<boolean> {
		return dispatchSessionEndFireAndForget(this.daemonUrl, payload);
	}
	async onSessionEnd(ctx: SessionContext): Promise<SessionEndResult> {
		const delivered = await this.dispatchSessionEnd({
			harness: "claude-code",
			sessionId: ctx.sessionId,
			transcriptPath: ctx.transcriptPath,
		});
		return { success: delivered, memoriesExtracted: 0 };
	}

	private configureHooks(
		settingsPath: string,
		settings: Record<string, unknown>,
		mcpConfig: Record<string, unknown> | undefined,
	): void {
		mkdirSync(join(homedir(), ".claude"), { recursive: true });

		const hooksConfig = this.config.hooks || {
			sessionStart: true,
			userPromptSubmit: true,
			preCompact: true,
			sessionEnd: true,
			stop: true,
		};
		const existing = isJsonObject(settings.hooks)
			? Object.values(settings.hooks)
					.flatMap((groups) => (Array.isArray(groups) ? groups.flatMap((group) => innerHooks(group) ?? []) : []))
					.find((hook) => signetHookName(hook) !== undefined)
			: undefined;
		const launcher =
			isJsonObject(existing) && typeof existing.command === "string" ? parseHookLauncher(existing.command) : undefined;
		const servers = isJsonObject(mcpConfig?.mcpServers) ? mcpConfig.mcpServers : {};
		const signetCmd = renderCommand(resolveSignetCliCommand(launcher ?? cliFromMcp(readMcpLauncher(servers.signet))));
		const pwdExpr = process.platform === "win32" ? "%CD%" : "$(pwd)";
		const promptSubmitTimeout = userPromptSubmitHookTimeoutSeconds();

		const hooks: Record<string, unknown[]> = {};
		const wakeHook = {
			type: "command",
			command: `${signetCmd} hook wake -H claude-code --project "${pwdExpr}"`,
			asyncRewake: true,
			timeout: WAKE_HOOK_TIMEOUT_SECONDS,
		};

		if (hooksConfig.sessionStart !== false) {
			hooks.SessionStart = [
				{
					hooks: [
						{
							type: "command",
							command: `${signetCmd} hook session-start -H claude-code --project "${pwdExpr}"`,
							timeout: sessionStartHookTimeoutSeconds(),
						},
						wakeHook,
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
							timeout: promptSubmitTimeout,
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
							timeout: promptSubmitTimeout,
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
							timeout: hookTimeoutSeconds(PRE_COMPACTION_DAEMON_WAIT_MS),
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
							timeout: SESSION_END_HOOK_TIMEOUT_SECONDS,
						},
					],
				},
			];
		}

		const stopHooks: unknown[] = [];
		if (hooksConfig.stop !== false) {
			stopHooks.push({ type: "command", command: `${signetCmd} hook stop -H claude-code`, async: true });
		}
		if (hooksConfig.sessionStart !== false) stopHooks.push(wakeHook);
		if (stopHooks.length > 0) hooks.Stop = [{ hooks: stopHooks }];

		const merged = withoutSignetHooks(settings.hooks);
		for (const [event, groups] of Object.entries(hooks)) {
			const userGroups = merged[event];
			merged[event] = [...(Array.isArray(userGroups) ? userGroups : []), ...groups];
		}
		settings.hooks = nonEmpty(merged);

		atomicWriteJson(settingsPath, settings);
		this.registerMcpServer(mcpConfig, launcher);
	}
	private registerMcpServer(config: Record<string, unknown> | undefined, launcher?: ResolvedCommand): void {
		if (!config) return;
		const claudeJsonPath = join(homedir(), ".claude.json");
		const existingMcp = isJsonObject(config.mcpServers) ? config.mcpServers : {};
		const mcp = resolveHarnessMcpCommand("claude-code", readMcpLauncher(existingMcp.signet) ?? mcpFromCli(launcher));
		config.mcpServers = {
			...existingMcp,
			signet: {
				type: "stdio",
				command: mcp.command,
				args: mcp.args,
				env: { ...mcp.env },
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
