import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	BaseConnector,
	type InstallResult,
	MANAGED_DAEMON_URL_DEFAULT,
	type UninstallResult,
	atomicWriteJson,
	buildSignetRuntimeEnv,
	isJsonObject,
	readTrimmedEnv,
	resolveSignetApiKey,
	resolveSignetDaemonUrl,
	resolveSignetMcpCommand,
} from "@signet/connector-base";
import { expandHome, resolvePromptSubmitTimeoutMs, resolveSessionStartTimeoutMs } from "@signet/core";

const HARNESS_ID = "muse-code";
const SETTINGS_SCHEMA_VERSION = 1;

// Muse Code hook timeouts are seconds. The grace covers CLI startup on top of
// the daemon request budget the hook command itself enforces.
const SESSION_START_GRACE_SECONDS = 5;
const PROMPT_SUBMIT_GRACE_SECONDS = 2;
const TURN_END_TIMEOUT_SECONDS = 30;

// Muse cancels SessionEnd hooks after roughly half a second of its shutdown
// budget, shorter than the Signet CLI's startup, so session-end runs on Stop.
// The daemon treats a session-end without a boundary reason as a turn
// checkpoint, which is what Muse's SessionEnd (reason "other") would send too.
export type MuseHookEvent = "SessionStart" | "UserPromptSubmit" | "Stop";

type HookSubcommand = "session-start" | "user-prompt-submit" | "session-end";

export interface MuseHookHandler {
	readonly type: "command";
	readonly command: string;
	readonly timeout: number;
}

export interface MuseHookGroup {
	readonly hooks: readonly MuseHookHandler[];
}

export type MuseHooks = Readonly<Record<MuseHookEvent, readonly MuseHookGroup[]>>;

// Muse Code runs hook commands with a cleared environment (HOME, PATH, USER,
// SHELL, TERM, LANG, PWD, LOGNAME), so any Signet setting that differs from
// the CLI default must travel inside the command itself.
// The workspace is always pinned: the CLI's own resolution reads
// XDG_CONFIG_HOME and SIGNET_PATH, which Muse also clears.
export interface MuseHookEnv {
	readonly signetPath: string;
	readonly daemonUrl?: string;
	readonly apiKey?: string;
}

export interface MuseMcpServer {
	readonly transport: "stdio";
	readonly command: string;
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly mode: "optional";
}

type SettingsRead =
	| { readonly kind: "missing" }
	| { readonly kind: "ok"; readonly value: Record<string, unknown> }
	| { readonly kind: "invalid"; readonly reason: string };

const SIGNET_MUSE_HOOK_PATTERN = /\bhook\s+(?:session-start|user-prompt-submit|session-end)\s+-H\s+muse-code\b/;

function shellArg(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function defaultWorkspacePath(): string {
	return join(homedir(), ".agents");
}

export function resolveMuseHookEnv(basePath: string): MuseHookEnv {
	const daemonUrl = resolveSignetDaemonUrl();
	const apiKey = resolveSignetApiKey();
	return {
		signetPath: resolve(basePath),
		...(daemonUrl !== MANAGED_DAEMON_URL_DEFAULT ? { daemonUrl } : {}),
		...(apiKey ? { apiKey } : {}),
	};
}

export function buildMuseHookCommand(
	signetArgs: readonly string[],
	subcommand: HookSubcommand,
	env: MuseHookEnv,
): string {
	const assignments = [
		...(env.daemonUrl ? [`SIGNET_DAEMON_URL=${shellArg(env.daemonUrl)}`] : []),
		...(env.apiKey ? [`SIGNET_API_KEY=${shellArg(env.apiKey)}`] : []),
		`SIGNET_PATH=${shellArg(env.signetPath)}`,
	];
	// Muse parses stdout as JSON whenever it starts with "[" or "{", and plain
	// Signet context starts with "[signet active]", so context hooks emit JSON.
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

export function buildMuseHooks(signetArgs: readonly string[], env: MuseHookEnv): MuseHooks {
	const group = (subcommand: HookSubcommand, timeout: number): MuseHookGroup[] => [
		{ hooks: [{ type: "command", command: buildMuseHookCommand(signetArgs, subcommand, env), timeout }] },
	];
	return {
		SessionStart: group("session-start", sessionStartTimeoutSeconds()),
		UserPromptSubmit: group("user-prompt-submit", promptSubmitTimeoutSeconds()),
		Stop: group("session-end", TURN_END_TIMEOUT_SECONDS),
	};
}

function isSignetHandler(handler: unknown): boolean {
	return isJsonObject(handler) && typeof handler.command === "string" && SIGNET_MUSE_HOOK_PATTERN.test(handler.command);
}

function withoutSignetGroups(groups: unknown): unknown[] {
	if (!Array.isArray(groups)) return [];
	const kept: unknown[] = [];
	for (const group of groups) {
		if (!isJsonObject(group) || !Array.isArray(group.hooks)) {
			kept.push(group);
			continue;
		}
		const handlers = group.hooks.filter((handler) => !isSignetHandler(handler));
		if (handlers.length === group.hooks.length) {
			kept.push(group);
			continue;
		}
		if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
	}
	return kept;
}

export function removeSignetMuseHooks(hooks: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = {};
	for (const [event, groups] of Object.entries(hooks)) {
		if (!Array.isArray(groups)) {
			next[event] = groups;
			continue;
		}
		const kept = withoutSignetGroups(groups);
		if (kept.length > 0) next[event] = kept;
	}
	return next;
}

export function mergeSignetMuseHooks(hooks: Record<string, unknown>, ours: MuseHooks): Record<string, unknown> {
	const next = removeSignetMuseHooks(hooks);
	for (const [event, groups] of Object.entries(ours)) {
		const existing = next[event];
		next[event] = [...(Array.isArray(existing) ? existing : []), ...groups];
	}
	return next;
}

function hasSignetHooks(hooks: unknown): boolean {
	if (!isJsonObject(hooks)) return false;
	return Object.values(hooks).some(
		(groups) =>
			Array.isArray(groups) &&
			groups.some((group) => isJsonObject(group) && Array.isArray(group.hooks) && group.hooks.some(isSignetHandler)),
	);
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
	// Muse Code rejects every command when schema_version is absent or unknown.
	// Repairing the file here would hide that state from the user, so refuse.
	if (parsed.schema_version !== SETTINGS_SCHEMA_VERSION) {
		return { kind: "invalid", reason: `schema_version must be ${SETTINGS_SCHEMA_VERSION}` };
	}
	if (parsed.hooks !== undefined && !isJsonObject(parsed.hooks)) {
		return { kind: "invalid", reason: "hooks must be a JSON object" };
	}
	if (parsed.mcp_servers !== undefined && !isJsonObject(parsed.mcp_servers)) {
		return { kind: "invalid", reason: "mcp_servers must be a JSON object" };
	}
	return { kind: "ok", value: parsed };
}

export function buildMuseMcpServer(basePath: string): MuseMcpServer {
	const mcp = resolveSignetMcpCommand();
	const env = { ...(mcp.env ?? {}), ...buildSignetRuntimeEnv({ basePath }) };
	return {
		transport: "stdio",
		command: mcp.command,
		args: [...mcp.args],
		...(Object.keys(env).length > 0 ? { env } : {}),
		// A required server that fails to start aborts the whole Muse run;
		// optional keeps the session usable and surfaces a startup warning.
		mode: "optional",
	};
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
		if (process.platform === "win32") {
			return {
				success: false,
				message: "Muse Code integration is not supported on Windows yet: Muse runs hooks through PowerShell",
				filesWritten: [],
			};
		}
		const workspace = expandHome(basePath || defaultWorkspacePath());
		const settingsPath = this.getConfigPath();
		const settings = readMuseSettings(settingsPath);
		if (settings.kind === "invalid") {
			return {
				success: false,
				message: `Refusing to modify ${settingsPath}: ${settings.reason}`,
				filesWritten: [],
			};
		}

		const filesWritten: string[] = [];
		const configsPatched: string[] = [];
		const warnings: string[] = [];
		const stripped = this.stripLegacySignetBlock(workspace);
		if (stripped !== null) filesWritten.push(stripped);

		const current = settings.kind === "ok" ? settings.value : { schema_version: SETTINGS_SCHEMA_VERSION };
		const hooks = isJsonObject(current.hooks) ? current.hooks : {};
		const servers = isJsonObject(current.mcp_servers) ? current.mcp_servers : {};
		const next = {
			...current,
			hooks: mergeSignetMuseHooks(hooks, buildMuseHooks(["signet"], resolveMuseHookEnv(workspace))),
			mcp_servers: { ...servers, signet: buildMuseMcpServer(workspace) },
		};
		if (JSON.stringify(next) !== JSON.stringify(current)) {
			mkdirSync(this.getConfigDir(), { recursive: true });
			atomicWriteJson(settingsPath, next);
			configsPatched.push(settingsPath);
		}

		if (resolve(workspace) !== defaultWorkspacePath()) {
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
		if (settings.kind !== "ok") return { filesRemoved: [], configsPatched: [] };

		const { hooks, mcp_servers: servers, ...rest } = settings.value;
		const keptHooks = isJsonObject(hooks) ? removeSignetMuseHooks(hooks) : {};
		const keptServers: Record<string, unknown> = isJsonObject(servers) ? { ...servers } : {};
		Reflect.deleteProperty(keptServers, "signet");
		const next = {
			...rest,
			...(Object.keys(keptHooks).length > 0 ? { hooks: keptHooks } : {}),
			...(Object.keys(keptServers).length > 0 ? { mcp_servers: keptServers } : {}),
		};
		if (JSON.stringify(next) === JSON.stringify(settings.value)) return { filesRemoved: [], configsPatched: [] };
		atomicWriteJson(settingsPath, next);
		return { filesRemoved: [], configsPatched: [settingsPath] };
	}

	isInstalled(): boolean {
		const settings = readMuseSettings(this.getConfigPath());
		if (settings.kind !== "ok") return false;
		return (
			hasSignetHooks(settings.value.hooks) ||
			(isJsonObject(settings.value.mcp_servers) && "signet" in settings.value.mcp_servers)
		);
	}
}

export default MuseCodeConnector;
