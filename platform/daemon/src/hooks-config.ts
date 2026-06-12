import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSimpleYaml } from "@signet/core";
import { logger } from "./logger";

export const DEFAULT_SESSION_START_MAX_INJECT_TOKENS = 12_000;

export interface HooksConfig {
	sessionStart?: {
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
	};
	userPromptSubmit?: {
		/** Set to false to disable per-prompt entity-context injection entirely. Default: true. */
		enabled?: boolean;
		recallLimit?: number;
		maxInjectChars?: number;
		/** Minimum scoped attribute relevance required before injecting entity context. */
		minScore?: number;
	};
	preCompaction?: {
		summaryGuidelines?: string;
		includeRecentMemories?: boolean;
		memoryLimit?: number;
		/** Cap the generated summary at this many characters. */
		maxSummaryChars?: number;
	};
}

// Derived from HooksConfig — update when adding new config sections.
const KNOWN_HOOKS_KEYS: ReadonlySet<keyof HooksConfig> = new Set<keyof HooksConfig>([
	"sessionStart",
	"userPromptSubmit",
	"preCompaction",
]);

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
		const cfg: HooksConfig = {
			sessionStart:
				typeof record.sessionStart === "object" && record.sessionStart !== null
					? (record.sessionStart as HooksConfig["sessionStart"])
					: undefined,
			userPromptSubmit:
				typeof record.userPromptSubmit === "object" && record.userPromptSubmit !== null
					? (record.userPromptSubmit as HooksConfig["userPromptSubmit"])
					: undefined,
			preCompaction:
				typeof record.preCompaction === "object" && record.preCompaction !== null
					? (record.preCompaction as HooksConfig["preCompaction"])
					: undefined,
		};
		return cfg;
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

export function resolveUserPromptMinScore(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0.8;
	return Math.max(0, Math.min(1, value));
}
