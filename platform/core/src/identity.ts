import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSyncHidden } from "./child-process";
import { parseSimpleYaml } from "./yaml";
export function resolveAgentBasePath(agentName: string, workspaceDir: string): string {
	if (agentName === "default") return workspaceDir;
	return join(workspaceDir, "agents", agentName);
}
export * from "./identity-spec";
import {
	IDENTITY_FILES,
	IDENTITY_MODES,
	IDENTITY_PRESETS,
	REQUIRED_IDENTITY_KEYS,
	type IdentityPresetName,
	type IdentityMode,
	type ResolvedIdentityMode,
	type IdentitySessionKind,
	type IdentityContextFileEntry,
	type IdentitySpecialFileEntry,
	type IdentityMap,
} from "./identity-spec";

function userHome(): string {
	return process.env.HOME?.trim() || homedir();
}

export function resolveKimiHomePath(): string {
	const currentOverride = process.env.KIMI_SHARE_DIR?.trim();
	if (currentOverride) return currentOverride;
	const legacyOverride = process.env.KIMI_CODE_HOME?.trim();
	if (legacyOverride) return legacyOverride;

	const currentHome = join(userHome(), ".kimi");
	const legacyHome = join(userHome(), ".kimi-code");
	if (existsSync(currentHome)) return currentHome;
	if (existsSync(legacyHome)) return legacyHome;
	return currentHome;
}

export interface HermesTarget {
	readonly kind: "ambient" | "profile";
	readonly home: string;
	readonly profile?: string;
}

const HERMES_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function resolveHermesHomePath(): string {
	const hermesHome = process.env.HERMES_HOME?.trim();
	return hermesHome || join(userHome(), ".hermes");
}
export function resolveHermesTarget(profile?: string): HermesTarget {
	if (profile === undefined || profile === "") {
		return { kind: "ambient", home: resolveHermesHomePath() };
	}
	if (!HERMES_PROFILE_NAME.test(profile) || profile === "." || profile === "..") {
		throw new Error(`Invalid Hermes profile name '${profile}'. Use letters, numbers, '.', '_' or '-' only.`);
	}
	return {
		kind: "profile",
		profile,
		home: join(resolveHermesHomePath(), "profiles", profile),
	};
}
export function hermesAgentCandidateDirs(): readonly string[] {
	const home = userHome();
	const hermesHome = resolveHermesHomePath();
	return [
		hermesHome,
		join(hermesHome, "hermes-agent"),
		join(home, "hermes-agent"),
		join(home, ".local", "share", "hermes-agent"),
		join(home, "src", "hermes-agent"),
		"/opt/hermes-agent",
	] as const;
}
export function resolveHermesRepoPath(): string | null {
	const hermesRepo = process.env.HERMES_REPO?.trim();
	if (hermesRepo && existsSync(join(hermesRepo, "plugins", "memory"))) {
		return hermesRepo;
	}

	for (const base of hermesAgentCandidateDirs()) {
		if (existsSync(join(base, "plugins", "memory"))) return base;
	}

	try {
		const hermesPath = execFileSyncHidden("which", ["hermes"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		}).trim();
		if (hermesPath) {
			const repoDir = dirname(realpathSync(hermesPath));
			if (existsSync(join(repoDir, "plugins", "memory"))) return repoDir;
		}
	} catch {}

	return null;
}
export function resolveHermesRepoPluginPath(): string | null {
	const pluginFile = join("plugins", "memory", "signet", "__init__.py");

	const hermesRepo = resolveHermesRepoPath();
	if (hermesRepo !== null) {
		const candidate = join(hermesRepo, pluginFile);
		if (existsSync(candidate)) return candidate;
	}

	return null;
}
export async function loadIdentityFiles(basePath: string): Promise<IdentityMap> {
	return loadIdentityFilesSync(basePath);
}
export function loadIdentityFilesSync(basePath: string): IdentityMap {
	const result: IdentityMap = {};

	for (const [key, spec] of Object.entries(IDENTITY_FILES)) {
		const filePath = join(basePath, spec.path);

		if (existsSync(filePath)) {
			try {
				const content = readFileSync(filePath, "utf-8");
				const stats = statSync(filePath);

				result[key as keyof IdentityMap] = {
					path: spec.path,
					content,
					mtime: stats.mtime,
					size: stats.size,
				};
			} catch (err) {
				if (!spec.optional) {
					console.warn(`Failed to read identity file: ${spec.path}`, err);
				}
			}
		} else if (!spec.optional) {
			console.warn(`Missing required identity file: ${spec.path}`);
		}
	}

	return result;
}
export function hasValidIdentity(basePath: string): boolean {
	const mode = loadIdentityMode(basePath);
	if (mode !== "managed") return true;
	for (const path of resolveRequiredIdentityPaths(basePath)) {
		if (!existsSync(join(basePath, path))) {
			return false;
		}
	}
	return true;
}
export function getMissingIdentityFiles(basePath: string): string[] {
	const mode = loadIdentityMode(basePath);
	if (mode !== "managed") return [];

	const missing: string[] = [];

	for (const path of resolveRequiredIdentityPaths(basePath)) {
		if (!existsSync(join(basePath, path))) {
			missing.push(path);
		}
	}

	return missing;
}

function resolveRequiredIdentityPaths(basePath: string): string[] {
	const legacyRequired = () => REQUIRED_IDENTITY_KEYS.map((key) => IDENTITY_FILES[key].path);
	const agentYaml = join(basePath, "agent.yaml");
	if (!existsSync(agentYaml)) return legacyRequired();

	try {
		const config = parseSimpleYaml(readFileSync(agentYaml, "utf-8"));
		const identity = readRecord(readRecord(config).identity);
		const configured = readIdentityEntryList(readRecord(identity.startup).load);
		if (configured.length > 0) return [...new Set(configured.map((entry) => entry.path))];

		const presetName = typeof identity.preset === "string" ? identity.preset : "";
		const preset = IDENTITY_PRESETS[presetName as IdentityPresetName];
		if (preset) return [...new Set(preset.startup.map((entry) => entry.path))];
	} catch {}

	return legacyRequired();
}
const STATIC_BUDGETS: ReadonlyArray<{ file: string; header: string; budget: number }> = [
	{ file: "AGENTS.md", header: "Agent Instructions", budget: 12_000 },
	{ file: "SOUL.md", header: "Soul", budget: 4_000 },
	{ file: "IDENTITY.md", header: "Identity", budget: 2_000 },
	{ file: "USER.md", header: "About Your User", budget: 6_000 },
	{ file: "MEMORY.md", header: "Working Memory", budget: 10_000 },
];

const STATIC_HEADER_BY_FILE: Record<string, string> = {
	"AGENTS.md": "Agent Instructions",
	"SOUL.md": "Soul",
	"IDENTITY.md": "Identity",
	"USER.md": "About Your User",
	"MEMORY.md": "Working Memory",
};

function isSafeRelativeIdentityPath(path: string): boolean {
	const trimmed = path.trim();
	if (!trimmed) return false;
	if (trimmed.startsWith("/") || trimmed.startsWith("~")) return false;
	return !trimmed.split(/[\\/]/).includes("..");
}

function readRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isIdentityMode(value: unknown): value is IdentityMode {
	return typeof value === "string" && (IDENTITY_MODES as readonly string[]).includes(value);
}

function isResolvedIdentityMode(value: unknown): value is ResolvedIdentityMode {
	return isIdentityMode(value) || value === "passthrough";
}

export function resolveIdentityModeFromConfig(config: unknown): ResolvedIdentityMode {
	const root = readRecord(config);
	const capabilities = readRecord(root.capabilities);
	const capabilityIdentity = readRecord(capabilities.identity);
	if (isResolvedIdentityMode(capabilityIdentity.mode)) return capabilityIdentity.mode;

	const identity = readRecord(root.identity);
	if (isResolvedIdentityMode(identity.mode)) return identity.mode;
	if (identity.enabled === false) return "off";
	return "managed";
}

export function loadIdentityMode(agentsDir: string): ResolvedIdentityMode {
	const agentYaml = join(agentsDir, "agent.yaml");
	if (!existsSync(agentYaml)) return "managed";
	try {
		return resolveIdentityModeFromConfig(parseSimpleYaml(readFileSync(agentYaml, "utf-8")));
	} catch {
		return "managed";
	}
}

export function identityModeManagesFiles(mode: ResolvedIdentityMode): boolean {
	return mode === "managed";
}

export function identityModeReadsFiles(mode: ResolvedIdentityMode): boolean {
	return mode !== "off";
}

function readIdentityEntry(value: unknown): IdentityContextFileEntry | null {
	if (typeof value === "string") {
		return isSafeRelativeIdentityPath(value) ? { path: value } : null;
	}
	const record = readRecord(value);
	const path = typeof record.path === "string" ? record.path.trim() : "";
	if (!isSafeRelativeIdentityPath(path)) return null;
	if (record.enabled === false) return null;
	const role = typeof record.role === "string" ? record.role : undefined;
	const rawBudget =
		typeof record.budget === "number" ? record.budget : Number.parseInt(String(record.budget ?? ""), 10);
	const budget = Number.isFinite(rawBudget) && rawBudget > 0 ? Math.floor(rawBudget) : undefined;
	return { path, role, budget };
}

function readIdentityEntryList(value: unknown): IdentityContextFileEntry[] {
	if (!Array.isArray(value)) return [];
	return value.map(readIdentityEntry).filter((entry): entry is IdentityContextFileEntry => entry !== null);
}

function readSpecialIdentityEntry(value: unknown): IdentitySpecialFileEntry | null {
	const record = readRecord(value);
	const kind = typeof record.kind === "string" ? record.kind : "";
	if (kind !== "dreaming" && kind !== "heartbeat" && kind !== "bootstrap") return null;
	const entry = readIdentityEntry(value);
	if (!entry) return null;
	return { ...entry, kind };
}

function readSpecialIdentityEntryList(value: unknown): IdentitySpecialFileEntry[] {
	if (!Array.isArray(value)) return [];
	return value.map(readSpecialIdentityEntry).filter((entry): entry is IdentitySpecialFileEntry => entry !== null);
}

function identityHeaderFor(path: string, role?: string): string {
	const filename = path.split(/[\\/]/).pop() ?? path;
	return STATIC_HEADER_BY_FILE[filename] ?? role ?? filename.replace(/\.md$/i, "");
}

export function resolveStartupIdentityFiles(agentsDir: string): IdentityContextFileEntry[] {
	const agentYaml = join(agentsDir, "agent.yaml");
	if (!existsSync(agentYaml)) return STATIC_BUDGETS.map(({ file, budget }) => ({ path: file, budget }));
	try {
		const config = parseSimpleYaml(readFileSync(agentYaml, "utf-8"));
		if (!identityModeReadsFiles(resolveIdentityModeFromConfig(config))) return [];
		const identity = readRecord(config.identity);
		const startup = readRecord(identity.startup);
		const configured = readIdentityEntryList(startup.load);
		if (configured.length > 0) return configured;
		const presetName = typeof identity.preset === "string" ? identity.preset : "";
		const preset = IDENTITY_PRESETS[presetName as IdentityPresetName];
		if (preset) return preset.startup;
	} catch {}
	return STATIC_BUDGETS.map(({ file, budget }) => ({ path: file, budget }));
}

export function resolveSpecialIdentityFiles(agentsDir: string, kind: IdentitySessionKind): IdentitySpecialFileEntry[] {
	const agentYaml = join(agentsDir, "agent.yaml");
	if (!existsSync(agentYaml)) {
		return IDENTITY_PRESETS.minimal.special.filter((entry) => entry.kind === kind);
	}
	try {
		const config = parseSimpleYaml(readFileSync(agentYaml, "utf-8"));
		if (!identityModeReadsFiles(resolveIdentityModeFromConfig(config))) return [];
		const identity = readRecord(config.identity);
		const configured = readSpecialIdentityEntryList(identity.special).filter((entry) => entry.kind === kind);
		if (configured.length > 0) return configured;
		const presetName = typeof identity.preset === "string" ? identity.preset : "";
		const preset = IDENTITY_PRESETS[presetName as IdentityPresetName];
		if (preset) return preset.special.filter((entry) => entry.kind === kind);
	} catch {}
	return IDENTITY_PRESETS.minimal.special.filter((entry) => entry.kind === kind);
}

export const STATIC_IDENTITY_OFFLINE_STATUS = "[signet: daemon offline — running with static identity]";
export const STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS =
	"[signet: daemon session-start timed out — running with static identity]";

export function resolveSessionStartTimeoutMs(raw?: string): number {
	if (!raw) return 15_000;
	const ms = Number.parseInt(raw, 10);
	if (!Number.isFinite(ms) || ms < 1_000) return 15_000;
	if (ms > 120_000) return 120_000;
	return ms;
}

export function resolvePromptSubmitTimeoutMs(raw?: string): number {
	if (!raw) return 5_000;
	const ms = Number.parseInt(raw, 10);
	if (!Number.isFinite(ms) || ms < 1_000) return 5_000;
	if (ms > 120_000) return 120_000;
	return ms;
}
export function readStaticIdentity(agentsDir: string, status = STATIC_IDENTITY_OFFLINE_STATUS): string | null {
	if (!existsSync(agentsDir)) return null;
	if (!identityModeReadsFiles(loadIdentityMode(agentsDir))) return null;

	const parts: string[] = [];

	for (const entry of resolveStartupIdentityFiles(agentsDir)) {
		const path = join(agentsDir, entry.path);
		if (!existsSync(path)) continue;
		try {
			const raw = readFileSync(path, "utf-8").trim();
			if (!raw) continue;
			const budget = entry.budget ?? STATIC_BUDGETS.find((candidate) => candidate.file === entry.path)?.budget ?? 4_000;
			const content = raw.length <= budget ? raw : `${raw.slice(0, budget)}\n[truncated]`;
			parts.push(`## ${identityHeaderFor(entry.path, entry.role)}\n\n${content}`);
		} catch {}
	}

	if (parts.length === 0) return null;

	return `${status}\n\n${parts.join("\n\n")}`;
}
export function summarizeIdentity(identity: IdentityMap): string {
	const parts: string[] = [];

	if (identity.identity?.content) {
		const nameMatch = identity.identity.content.match(/^#\s*(.+)$/m);
		if (nameMatch) {
			parts.push(`Name: ${nameMatch[1]}`);
		}
	}

	const fileCount = Object.keys(identity).length;
	parts.push(`Files: ${fileCount} identity files loaded`);

	const totalSize = Object.values(identity).reduce((sum, file) => sum + (file?.size || 0), 0);
	parts.push(`Size: ${totalSize} bytes`);

	return parts.join("\n");
}
