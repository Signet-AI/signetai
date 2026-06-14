import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSimpleYaml } from "@signet/core";
import { logger } from "./logger";

export const DEFAULT_SESSION_START_MAX_INJECT_TOKENS = 12_000;

export interface HooksConfig {
	sessionStart?: SessionStartHooksConfig;
	userPromptSubmit?: UserPromptSubmitHooksConfig;
	preCompaction?: PreCompactionHooksConfig;
	/** Named context-budget profiles. Resolved per harness via `harnessProfiles`. */
	contextProfiles?: Record<string, ContextBudgetProfileConfig>;
	/** Maps harness names (for example `pi`) to a context profile name. */
	harnessProfiles?: Record<string, string>;
	/** Optional fallback profile when a harness has no explicit mapping. */
	defaultContextProfile?: string;
}

export interface SessionStartHooksConfig {
	recallLimit?: number;
	candidatePoolLimit?: number;
	includeIdentity?: boolean;
	includeRecentContext?: boolean;
	recencyBias?: number;
	query?: string;
	maxInjectTokens?: number;
	/**
	 * @deprecated Renamed to `maxInjectTokens`. If set without `maxInjectTokens`,
	 * the value is auto-migrated using `Math.round(maxInjectChars / 4)` (~4 chars/token
	 * for ASCII; code or Unicode content may be 1–2 chars/token, so migrate explicitly.
	 */
	maxInjectChars?: number;
}

export interface UserPromptSubmitHooksConfig {
	/** Set to false to disable per-prompt entity-context injection entirely. Default: true. */
	enabled?: boolean;
	recallLimit?: number;
	maxInjectChars?: number;
	/** Minimum scoped attribute relevance required before injecting entity context. */
	minScore?: number;
}

export interface PreCompactionHooksConfig {
	summaryGuidelines?: string;
	includeRecentMemories?: boolean;
	memoryLimit?: number;
	/** Cap the generated summary at this many characters. */
	maxSummaryChars?: number;
}

export interface ContextIdentityFileConfig {
	path: string;
	header?: string;
	role?: string;
	/** Preferred budget unit for profile-managed identity files. */
	maxTokens?: number;
	/** Compatibility with existing identity startup entries; interpreted as characters. */
	budget?: number;
	/** Explicit character budget for callers that cannot reason in tokens. */
	maxChars?: number;
	enabled?: boolean;
}

export interface ContextIdentityConfig {
	/** Set false to suppress profile-managed identity files. */
	include?: boolean;
	/** Explicit ordered identity/context files for this profile. */
	files?: readonly ContextIdentityFileConfig[];
}

export interface ContextBudgetProfileConfig {
	sessionStart?: SessionStartHooksConfig;
	userPromptSubmit?: UserPromptSubmitHooksConfig;
	identity?: ContextIdentityConfig;
}

export interface ResolvedHooksConfig {
	profileName?: string;
	sessionStart?: SessionStartHooksConfig;
	userPromptSubmit?: UserPromptSubmitHooksConfig;
	preCompaction?: PreCompactionHooksConfig;
	identity?: ContextIdentityConfig;
}

// Derived from HooksConfig — update when adding new config sections.
const KNOWN_HOOKS_KEYS: ReadonlySet<keyof HooksConfig> = new Set<keyof HooksConfig>([
	"sessionStart",
	"userPromptSubmit",
	"preCompaction",
	"contextProfiles",
	"harnessProfiles",
	"defaultContextProfile",
]);

function readRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	return undefined;
}

function readSessionStartConfig(value: unknown): SessionStartHooksConfig | undefined {
	const record = readRecord(value);
	if (Object.keys(record).length === 0) return undefined;
	return {
		recallLimit: readNumber(record.recallLimit),
		candidatePoolLimit: readNumber(record.candidatePoolLimit),
		includeIdentity: readBoolean(record.includeIdentity),
		includeRecentContext: readBoolean(record.includeRecentContext),
		recencyBias: readNumber(record.recencyBias),
		query: readString(record.query),
		maxInjectTokens: readNumber(record.maxInjectTokens),
		maxInjectChars: readNumber(record.maxInjectChars),
	};
}

function readUserPromptSubmitConfig(value: unknown): UserPromptSubmitHooksConfig | undefined {
	const record = readRecord(value);
	if (Object.keys(record).length === 0) return undefined;
	return {
		enabled: readBoolean(record.enabled),
		recallLimit: readNumber(record.recallLimit),
		maxInjectChars: readNumber(record.maxInjectChars),
		minScore: readNumber(record.minScore),
	};
}

function readPreCompactionConfig(value: unknown): PreCompactionHooksConfig | undefined {
	const record = readRecord(value);
	if (Object.keys(record).length === 0) return undefined;
	return {
		summaryGuidelines: readString(record.summaryGuidelines),
		includeRecentMemories: readBoolean(record.includeRecentMemories),
		memoryLimit: readNumber(record.memoryLimit),
		maxSummaryChars: readNumber(record.maxSummaryChars),
	};
}

function isSafeRelativeIdentityPath(path: string): boolean {
	const trimmed = path.trim();
	if (!trimmed) return false;
	if (trimmed.startsWith("/") || trimmed.startsWith("~")) return false;
	if (!trimmed.toLowerCase().endsWith(".md")) return false;
	const parts = trimmed.split(/[\\/]/);
	const deniedDirs = new Set([".daemon", ".secrets", "memory"]);
	return parts.every((part) => {
		const normalized = part.toLowerCase();
		return normalized !== ".." && !normalized.startsWith(".") && !deniedDirs.has(normalized);
	});
}

function readPositiveBudget(value: unknown): number | undefined | null {
	const parsed = readNumber(value);
	if (parsed === undefined) return undefined;
	return parsed > 0 ? parsed : null;
}

function readIdentityFileEntry(value: unknown): ContextIdentityFileConfig | null {
	if (typeof value === "string") {
		const path = value.trim();
		return isSafeRelativeIdentityPath(path) ? { path } : null;
	}
	const record = readRecord(value);
	const path = readString(record.path);
	if (!path || !isSafeRelativeIdentityPath(path)) return null;
	const enabled = readBoolean(record.enabled);
	if (enabled === false) return null;
	const maxTokens = readPositiveBudget(record.maxTokens);
	const budget = readPositiveBudget(record.budget);
	const maxChars = readPositiveBudget(record.maxChars);
	if (maxTokens === null || budget === null || maxChars === null) return null;
	return {
		path,
		header: readString(record.header),
		role: readString(record.role),
		maxTokens,
		budget,
		maxChars,
		enabled,
	};
}

function readIdentityFileList(value: unknown): ContextIdentityFileConfig[] {
	if (Array.isArray(value)) {
		const files: ContextIdentityFileConfig[] = [];
		for (const item of value) {
			const entry = readIdentityFileEntry(item);
			if (entry) files.push(entry);
		}
		return files;
	}

	const record = readRecord(value);
	const files: ContextIdentityFileConfig[] = [];
	for (const [path, budget] of Object.entries(record)) {
		if (!isSafeRelativeIdentityPath(path)) continue;
		const numericBudget = readNumber(budget);
		if (numericBudget !== undefined && numericBudget <= 0) continue;
		const entry: ContextIdentityFileConfig = { path };
		if (numericBudget !== undefined) entry.maxTokens = numericBudget;
		files.push(entry);
	}
	return files;
}

function readIdentityConfig(value: unknown): ContextIdentityConfig | undefined {
	const record = readRecord(value);
	if (Object.keys(record).length === 0) return undefined;
	return {
		include: readBoolean(record.include),
		files: Object.hasOwn(record, "files") ? readIdentityFileList(record.files) : undefined,
	};
}

function readContextProfileConfig(value: unknown): ContextBudgetProfileConfig | undefined {
	const record = readRecord(value);
	if (Object.keys(record).length === 0) return undefined;
	return {
		sessionStart: readSessionStartConfig(record.sessionStart),
		userPromptSubmit: readUserPromptSubmitConfig(record.userPromptSubmit),
		identity: readIdentityConfig(record.identity),
	};
}

function readContextProfiles(value: unknown): Record<string, ContextBudgetProfileConfig> | undefined {
	const record = readRecord(value);
	const profiles: Record<string, ContextBudgetProfileConfig> = {};
	for (const [name, profileValue] of Object.entries(record)) {
		const safeName = name.trim();
		const profile = readContextProfileConfig(profileValue);
		if (!safeName || !profile) continue;
		profiles[safeName] = profile;
	}
	return Object.keys(profiles).length > 0 ? profiles : undefined;
}

function normalizeHarnessName(value: string): string {
	return value.trim().toLowerCase();
}

function readHarnessProfiles(value: unknown): Record<string, string> | undefined {
	const record = readRecord(value);
	const profiles: Record<string, string> = {};
	for (const [harness, profile] of Object.entries(record)) {
		const profileName = readString(profile);
		if (!profileName) continue;
		profiles[normalizeHarnessName(harness)] = profileName;
	}
	return Object.keys(profiles).length > 0 ? profiles : undefined;
}

function mergeConfig<T extends object>(base: T | undefined, override: T | undefined): T | undefined {
	// Profile readers emit fully-populated objects with `undefined` for unset keys.
	// A naive spread would let an unset override key clobber a defined base value,
	// so only copy override keys that are actually present and defined. This keeps
	// global hook settings (e.g. `sessionStart.recencyBias`) inherited when a profile
	// only overrides a subset of keys.
	const merged = { ...(base ?? {}) } as Record<string, unknown>;
	for (const [key, value] of Object.entries(override ?? {})) {
		if (value !== undefined) merged[key] = value;
	}
	return Object.keys(merged).length > 0 ? (merged as T) : undefined;
}

export function loadHooksConfig(agentsDir: string): HooksConfig {
	const configPath = join(agentsDir, "agent.yaml");
	if (!existsSync(configPath)) {
		return getDefaultHooksConfig();
	}

	try {
		const content = readFileSync(configPath, "utf-8");
		const parsed = parseSimpleYaml(content);
		const hooks = parsed.hooks;
		if (!hooks || typeof hooks !== "object") {
			return getDefaultHooksConfig();
		}
		// Warn on unrecognized keys so users catch typos early.
		const record = hooks as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (!KNOWN_HOOKS_KEYS.has(key as keyof HooksConfig)) {
				logger.warn("hooks", `Unknown hooks config key: ${key} — check agent.yaml`);
			}
		}
		return {
			sessionStart: readSessionStartConfig(record.sessionStart),
			userPromptSubmit: readUserPromptSubmitConfig(record.userPromptSubmit),
			preCompaction: readPreCompactionConfig(record.preCompaction),
			contextProfiles: readContextProfiles(record.contextProfiles),
			harnessProfiles: readHarnessProfiles(record.harnessProfiles),
			defaultContextProfile: readString(record.defaultContextProfile),
		};
	} catch {
		logger.warn("hooks", "Failed to load hooks config, using defaults");
		return getDefaultHooksConfig();
	}
}

export function getDefaultHooksConfig(): HooksConfig {
	return {
		sessionStart: {
			recallLimit: 50,
			candidatePoolLimit: 100,
			includeIdentity: true,
			includeRecentContext: true,
			recencyBias: 0.7,
			maxInjectTokens: DEFAULT_SESSION_START_MAX_INJECT_TOKENS,
		},
		userPromptSubmit: {
			enabled: true,
			recallLimit: 10,
			maxInjectChars: 500,
			minScore: 0.8,
		},
		preCompaction: {
			summaryGuidelines: `Summarize this session focusing on:
- Key decisions made
- Important information learned
- User preferences discovered
- Open threads or todos
- Any errors or issues encountered

Keep the summary concise but complete. Use first person from the agent's perspective.`,
			includeRecentMemories: true,
			memoryLimit: 5,
		},
	};
}

export function resolveHooksConfigForHarness(config: HooksConfig, harness: string): ResolvedHooksConfig {
	const normalizedHarness = normalizeHarnessName(harness);
	const profileName = config.harnessProfiles?.[normalizedHarness] ?? config.defaultContextProfile;
	const profile = profileName ? config.contextProfiles?.[profileName] : undefined;
	if (profileName && !profile) {
		logger.warn("hooks", `Context profile '${profileName}' for harness '${harness}' was not found`);
	}
	return {
		profileName: profile ? profileName : undefined,
		sessionStart: mergeConfig(config.sessionStart, profile?.sessionStart),
		userPromptSubmit: mergeConfig(config.userPromptSubmit, profile?.userPromptSubmit),
		preCompaction: config.preCompaction,
		identity: profile?.identity,
	};
}

export function resolveUserPromptMinScore(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0.8;
	return Math.max(0, Math.min(1, value));
}
