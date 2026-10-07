import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	BaseConnector,
	type InstallResult,
	MANAGED_AGENT_ID_DEFAULT,
	MANAGED_DAEMON_URL_DEFAULT,
	SIGNET_MCP_STDIO_WORKER_ENV,
	type UninstallResult,
	atomicWriteText,
	isJsonObject,
	readTrimmedEnv,
	resolveSignetAgentId,
	resolveSignetApiKey,
	resolveSignetCliCommand,
	resolveSignetDaemonUrl,
	resolveSignetMcpCommand,
} from "@signet/connector-base";
import { expandHome, resolvePromptSubmitTimeoutMs, resolveSessionStartTimeoutMs } from "@signet/core";

const HARNESS_ID = "muse-code";
const SETTINGS_SCHEMA_VERSION = 1;
const SESSION_START_GRACE_SECONDS = 5;
const PROMPT_SUBMIT_GRACE_SECONDS = 2;
const TURN_END_TIMEOUT_SECONDS = 30;
const TIMEOUT_ENV_KEYS = [
	"SIGNET_SESSION_START_TIMEOUT",
	"SIGNET_FETCH_TIMEOUT",
	"SIGNET_PROMPT_SUBMIT_TIMEOUT",
] as const;
export type MuseHookEvent = "SessionStart" | "UserPromptSubmit" | "Stop";

type HookSubcommand = "session-start" | "user-prompt-submit" | "session-end";

export type MuseHookHandler = {
	readonly type: "command";
	readonly command: string;
	readonly timeout: number;
};

export type MuseHookGroup = {
	readonly hooks: readonly MuseHookHandler[];
};

export type MuseHooks = Readonly<Record<MuseHookEvent, readonly MuseHookGroup[]>>;

export type MuseRuntimeEnv = Readonly<Record<string, string>>;

export interface MuseMcpServer {
	readonly transport: "stdio";
	readonly command: string;
	readonly args: readonly string[];
	readonly env: MuseRuntimeEnv;
	readonly mode: "optional";
}

interface HookGroup {
	readonly hooks: readonly Record<string, unknown>[];
	readonly [key: string]: unknown;
}

type HookMap = Readonly<Record<string, readonly HookGroup[]>>;

type SettingsRead =
	| { readonly kind: "missing" }
	| { readonly kind: "ok"; readonly value: Record<string, unknown>; readonly hooks: HookMap }
	| { readonly kind: "invalid"; readonly reason: string };

const ENV_PREFIX = /^(?:SIGNET_[A-Z_]+=(?:'(?:[^']|'\\'')*'|[^\s'"]+)\s+)*/;
const SIGNET_INVOCATION =
	/^(?:'(?:[^']|'\\'')*\/signet'|(?:[^\s'"]*\/)?signet)\s+hook\s+(?:session-start|user-prompt-submit|session-end)\s+-H\s+muse-code(?:\s+--codex-json)?$/i;

function shellArg(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function defaultWorkspacePath(): string {
	return join(homedir(), ".agents");
}
export function resolveMuseRuntimeEnv(workspace: string): MuseRuntimeEnv {
	const env: Record<string, string> = {};
	const daemonUrl = resolveSignetDaemonUrl();
	if (daemonUrl !== MANAGED_DAEMON_URL_DEFAULT) env.SIGNET_DAEMON_URL = daemonUrl;
	const apiKey = resolveSignetApiKey();
	if (apiKey) env.SIGNET_API_KEY = apiKey;
	env.SIGNET_PATH = workspace;
	for (const key of TIMEOUT_ENV_KEYS) {
		const value = readTrimmedEnv(key);
		if (value) env[key] = value;
	}
	return env;
}
export function resolveMuseSignetArgs(): string[] {
	const mcp = resolveSignetMcpCommand();
	if (mcp.env?.[SIGNET_MCP_STDIO_WORKER_ENV]) return [mcp.command];
	const cli = resolveSignetCliCommand();
	return [cli.command, ...cli.args];
}

export function buildMuseHookCommand(
	signetArgs: readonly string[],
	subcommand: HookSubcommand,
	env: MuseRuntimeEnv,
): string {
	const assignments = Object.entries(env).map(([key, value]) => `${key}=${shellArg(value)}`);
	const output = subcommand === "session-end" ? [] : ["--codex-json"];
	const invocation = [...signetArgs, "hook", subcommand, "-H", HARNESS_ID, ...output].map(shellArg);
	return [...assignments, ...invocation].join(" ");
}

function sessionStartTimeoutSeconds(): number {
	const raw = readTrimmedEnv("SIGNET_SESSION_START_TIMEOUT") ?? readTrimmedEnv("SIGNET_FETCH_TIMEOUT");
	return Math.ceil(resolveSessionStartTimeoutMs(raw) / 1000) + SESSION_START_GRACE_SECONDS;
}

function promptSubmitTimeoutSeconds(): number {
	const raw = readTrimmedEnv("SIGNET_PROMPT_SUBMIT_TIMEOUT");
	return Math.ceil(resolvePromptSubmitTimeoutMs(raw) / 1000) + PROMPT_SUBMIT_GRACE_SECONDS;
}

export function buildMuseHooks(signetArgs: readonly string[], env: MuseRuntimeEnv): MuseHooks {
	const group = (subcommand: HookSubcommand, timeout: number): MuseHookGroup[] => [
		{ hooks: [{ type: "command", command: buildMuseHookCommand(signetArgs, subcommand, env), timeout }] },
	];
	return {
		SessionStart: group("session-start", sessionStartTimeoutSeconds()),
		UserPromptSubmit: group("user-prompt-submit", promptSubmitTimeoutSeconds()),
		Stop: group("session-end", TURN_END_TIMEOUT_SECONDS),
	};
}

export function isSignetMuseHookCommand(command: string): boolean {
	return SIGNET_INVOCATION.test(command.trim().replace(ENV_PREFIX, ""));
}

function isSignetHandler(handler: unknown): boolean {
	return isJsonObject(handler) && typeof handler.command === "string" && isSignetMuseHookCommand(handler.command);
}

export function removeSignetMuseHooks(hooks: HookMap): Record<string, readonly HookGroup[]> {
	const next: Record<string, readonly HookGroup[]> = {};
	for (const [event, groups] of Object.entries(hooks)) {
		const kept: HookGroup[] = [];
		for (const group of groups) {
			const handlers = group.hooks.filter((handler) => !isSignetHandler(handler));
			if (handlers.length === group.hooks.length) kept.push(group);
			else if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
		}
		if (kept.length > 0) next[event] = kept;
	}
	return next;
}

export function mergeSignetMuseHooks(hooks: HookMap, ours: MuseHooks): Record<string, readonly HookGroup[]> {
	const next = removeSignetMuseHooks(hooks);
	for (const [event, groups] of Object.entries(ours)) {
		next[event] = [...(next[event] ?? []), ...groups];
	}
	return next;
}
function isHookHandler(value: unknown): value is Record<string, unknown> {
	return (
		isJsonObject(value) &&
		(value.timeout === undefined || (Number.isInteger(value.timeout) && Number(value.timeout) >= 0))
	);
}

function isHookGroup(value: unknown): value is HookGroup {
	return isJsonObject(value) && Array.isArray(value.hooks) && value.hooks.every(isHookHandler);
}

function parseHooks(value: Record<string, unknown>): HookMap | string {
	const hooks: Record<string, readonly HookGroup[]> = {};
	for (const [event, groups] of Object.entries(value)) {
		if (!Array.isArray(groups)) return `hooks.${event} must be an array`;
		const parsed: HookGroup[] = [];
		for (const [index, group] of groups.entries()) {
			if (!isHookGroup(group)) {
				return `hooks.${event}[${index}] must be an object whose hooks are objects with integer timeouts`;
			}
			parsed.push(group);
		}
		hooks[event] = parsed;
	}
	return hooks;
}

export function readMuseSettings(path: string): SettingsRead {
	if (!existsSync(path)) return { kind: "missing" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		return { kind: "invalid", reason: `could not parse JSON (${error instanceof Error ? error.message : error})` };
	}
	if (!isJsonObject(parsed)) return { kind: "invalid", reason: "settings must be a JSON object" };
	if (parsed.schema_version !== SETTINGS_SCHEMA_VERSION) {
		return { kind: "invalid", reason: `schema_version must be ${SETTINGS_SCHEMA_VERSION}` };
	}
	if (parsed.hooks !== undefined && !isJsonObject(parsed.hooks)) {
		return { kind: "invalid", reason: "hooks must be a JSON object" };
	}
	const hooks = parseHooks(parsed.hooks ?? {});
	if (typeof hooks === "string") return { kind: "invalid", reason: hooks };
	if (parsed.mcp_servers !== undefined && !isJsonObject(parsed.mcp_servers)) {
		return { kind: "invalid", reason: "mcp_servers must be a JSON object" };
	}
	return { kind: "ok", value: parsed, hooks };
}

export function buildMuseMcpServer(env: MuseRuntimeEnv): MuseMcpServer {
	const mcp = resolveSignetMcpCommand();
	return {
		transport: "stdio",
		command: mcp.command,
		args: [...mcp.args],
		env: { ...(mcp.env ?? {}), ...env },
		mode: "optional",
	};
}
function writeMuseSettings(path: string, value: unknown): void {
	const exists = existsSync(path);
	const target = exists ? realpathSync(path) : path;
	if (!exists) mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	atomicWriteText(target, `${JSON.stringify(value, null, 2)}\n`, exists ? undefined : 0o600);
}

export class MuseCodeConnector extends BaseConnector {
	readonly name = "Muse Code";
	readonly harnessId = HARNESS_ID;

	getIconAsset(): string {
		return "muse-code.png";
	}

	protected getConfigDir(): string {
		const xdg = readTrimmedEnv("XDG_CONFIG_HOME");
		return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"), "muse");
	}

	protected getDataDir(): string {
		const xdg = readTrimmedEnv("XDG_DATA_HOME");
		return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "share"), "muse");
	}

	getConfigPath(): string {
		return join(this.getConfigDir(), "settings.json");
	}

	isDetected(): boolean {
		return existsSync(this.getConfigDir()) || existsSync(this.getDataDir());
	}

	async install(basePath: string): Promise<InstallResult> {
		const refuse = (message: string): InstallResult => ({ success: false, message, filesWritten: [] });
		if (process.platform === "win32") {
			return refuse("Muse Code integration is not supported on Windows yet: Muse runs hooks through PowerShell");
		}
		const agentId = resolveSignetAgentId();
		if (agentId !== MANAGED_AGENT_ID_DEFAULT) {
			return refuse(
				`Muse Code hooks cannot carry agent "${agentId}" yet; unset SIGNET_AGENT_ID to connect Muse Code as the default agent`,
			);
		}
		const workspace = resolve(expandHome(basePath || defaultWorkspacePath()));
		const settingsPath = this.getConfigPath();
		const settings = readMuseSettings(settingsPath);
		if (settings.kind === "invalid") return refuse(`Refusing to modify ${settingsPath}: ${settings.reason}`);

		const filesWritten: string[] = [];
		const configsPatched: string[] = [];
		const warnings: string[] = [];
		const stripped = this.stripLegacySignetBlock(workspace);
		if (stripped !== null) filesWritten.push(stripped);

		const env = resolveMuseRuntimeEnv(workspace);
		const current = settings.kind === "ok" ? settings.value : { schema_version: SETTINGS_SCHEMA_VERSION };
		const hooks = settings.kind === "ok" ? settings.hooks : {};
		const servers = isJsonObject(current.mcp_servers) ? current.mcp_servers : {};
		const next = {
			...current,
			hooks: mergeSignetMuseHooks(hooks, buildMuseHooks(resolveMuseSignetArgs(), env)),
			mcp_servers: { ...servers, signet: buildMuseMcpServer(env) },
		};
		if (JSON.stringify(next) !== JSON.stringify(current)) {
			writeMuseSettings(settingsPath, next);
			configsPatched.push(settingsPath);
		}

		if (workspace !== defaultWorkspacePath()) {
			warnings.push(
				`Muse Code discovers skills from ~/.agents/skills, not ${workspace}/skills; Signet skills in this workspace are not visible to Muse`,
			);
		}

		return {
			success: true,
			message: "Muse Code integration installed — settings.json hooks + MCP server",
			filesWritten,
			configsPatched,
			warnings,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const settingsPath = this.getConfigPath();
		const settings = readMuseSettings(settingsPath);
		if (settings.kind === "missing") return { filesRemoved: [], configsPatched: [] };
		if (settings.kind === "invalid") {
			throw new Error(`Cannot remove Signet entries from ${settingsPath}: ${settings.reason}`);
		}

		const { hooks: _hooks, mcp_servers: servers, ...rest } = settings.value;
		const keptHooks = removeSignetMuseHooks(settings.hooks);
		const keptServers: Record<string, unknown> = isJsonObject(servers) ? { ...servers } : {};
		Reflect.deleteProperty(keptServers, "signet");
		const next = {
			...rest,
			...(Object.keys(keptHooks).length > 0 ? { hooks: keptHooks } : {}),
			...(Object.keys(keptServers).length > 0 ? { mcp_servers: keptServers } : {}),
		};
		if (JSON.stringify(next) === JSON.stringify(settings.value)) return { filesRemoved: [], configsPatched: [] };
		writeMuseSettings(settingsPath, next);
		return { filesRemoved: [], configsPatched: [settingsPath] };
	}

	isInstalled(): boolean {
		const settingsPath = this.getConfigPath();
		const settings = readMuseSettings(settingsPath);
		if (settings.kind === "invalid") {
			try {
				return readFileSync(settingsPath, "utf-8").includes("-H muse-code");
			} catch {
				return false;
			}
		}
		if (settings.kind === "missing") return false;
		const hasHooks = Object.values(settings.hooks).some((groups) =>
			groups.some((group) => group.hooks.some(isSignetHandler)),
		);
		return hasHooks || (isJsonObject(settings.value.mcp_servers) && "signet" in settings.value.mcp_servers);
	}
}

export default MuseCodeConnector;
