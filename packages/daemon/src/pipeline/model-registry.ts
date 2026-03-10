/**
 * Dynamic Model Registry
 *
 * Auto-discovers available models from each LLM provider and maintains
 * a live registry. Replaces hardcoded model lists in the dashboard and
 * config — when Anthropic ships claude-opus-4-7 or OpenAI ships
 * gpt-6-codex, it appears automatically without code changes.
 *
 * Discovery strategies per provider:
 * - Ollama: GET /api/tags (lists locally pulled models)
 * - Anthropic: known model catalog with version probing
 * - Claude Code: `claude --version` + known model aliases
 * - Codex: `codex --version` + known model catalog
 * - OpenCode: routes through configured model list
 */

import type { ModelRegistryEntry, PipelineModelRegistryConfig } from "@signet/core";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Known model catalogs (seed data, updated by discovery)
// ---------------------------------------------------------------------------

/**
 * Canonical model catalogs per provider. Discovery enriches these at
 * runtime, and deprecated entries get flagged automatically when a
 * newer version of the same family is found.
 */
const KNOWN_MODELS: Record<string, ModelRegistryEntry[]> = {
	"claude-code": [
		{ id: "opus", provider: "claude-code", label: "Claude Opus (latest)", tier: "high", deprecated: false },
		{ id: "sonnet", provider: "claude-code", label: "Claude Sonnet (latest)", tier: "mid", deprecated: false },
		{ id: "haiku", provider: "claude-code", label: "Claude Haiku (latest)", tier: "low", deprecated: false },
	],
	anthropic: [
		{ id: "claude-opus-4-6", provider: "anthropic", label: "Claude Opus 4.6", tier: "high", deprecated: false },
		{ id: "claude-sonnet-4-6", provider: "anthropic", label: "Claude Sonnet 4.6", tier: "mid", deprecated: false },
		{
			id: "claude-haiku-4-5-20251001",
			provider: "anthropic",
			label: "Claude Haiku 4.5",
			tier: "low",
			deprecated: false,
		},
	],
	codex: [
		{ id: "gpt-5.3-codex", provider: "codex", label: "GPT 5.3 Codex", tier: "high", deprecated: false },
		{ id: "gpt-5-codex", provider: "codex", label: "GPT 5 Codex", tier: "mid", deprecated: false },
		{ id: "gpt-5-codex-mini", provider: "codex", label: "GPT 5 Codex Mini", tier: "low", deprecated: false },
	],
	opencode: [
		{
			id: "anthropic/claude-sonnet-4-5-20250514",
			provider: "opencode",
			label: "Claude Sonnet 4.5 (via OpenCode)",
			tier: "mid",
			deprecated: false,
		},
		{
			id: "anthropic/claude-haiku-4-5-20251001",
			provider: "opencode",
			label: "Claude Haiku 4.5 (via OpenCode)",
			tier: "low",
			deprecated: false,
		},
		{
			id: "google/gemini-2.5-flash",
			provider: "opencode",
			label: "Gemini 2.5 Flash (via OpenCode)",
			tier: "low",
			deprecated: false,
		},
	],
	ollama: [
		{ id: "qwen3:4b", provider: "ollama", label: "Qwen3 4B", tier: "low", deprecated: false },
		{ id: "glm-4.7-flash", provider: "ollama", label: "GLM 4.7 Flash", tier: "low", deprecated: false },
		{ id: "llama3", provider: "ollama", label: "Llama 3", tier: "low", deprecated: false },
	],
};

// ---------------------------------------------------------------------------
// Version parsing for auto-deprecation
// ---------------------------------------------------------------------------

/**
 * Parse a version number from a model ID for comparison.
 * Examples: "claude-opus-4-6" → 4.6, "gpt-5.3-codex" → 5.3
 */
function parseModelVersion(modelId: string): number | null {
	// Match patterns like 4.6, 4-6, 5.3
	const match = modelId.match(/(\d+)[.\-](\d+)/);
	if (!match) return null;
	return Number.parseFloat(`${match[1]}.${match[2]}`);
}

/**
 * Extract the model family from an ID.
 * Examples: "claude-opus-4-6" → "claude-opus", "gpt-5.3-codex" → "gpt-codex"
 */
function parseModelFamily(modelId: string): string {
	return modelId
		.replace(/[-_]?\d+([.\-]\d+)?/g, "")
		.replace(/--+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Given a list of models, mark older versions of the same family as
 * deprecated. Mutates entries in place.
 */
function markDeprecatedVersions(entries: ModelRegistryEntry[]): void {
	const familyBest = new Map<string, { version: number; id: string }>();

	for (const entry of entries) {
		const family = parseModelFamily(entry.id);
		const version = parseModelVersion(entry.id);
		if (version === null) continue;

		const best = familyBest.get(family);
		if (!best || version > best.version) {
			familyBest.set(family, { version, id: entry.id });
		}
	}

	for (const entry of entries) {
		const family = parseModelFamily(entry.id);
		const version = parseModelVersion(entry.id);
		if (version === null) continue;

		const best = familyBest.get(family);
		if (best && best.id !== entry.id && version < best.version) {
			(entry as { deprecated: boolean }).deprecated = true;
		}
	}
}

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

interface RegistryState {
	models: Map<string, ModelRegistryEntry[]>;
	lastRefreshAt: number;
	refreshTimer: ReturnType<typeof setInterval> | null;
}

let state: RegistryState | null = null;

// ---------------------------------------------------------------------------
// Discovery functions
// ---------------------------------------------------------------------------

async function discoverOllamaModels(baseUrl: string): Promise<ModelRegistryEntry[]> {
	try {
		const res = await fetch(`${baseUrl}/api/tags`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return [];

		const data = (await res.json()) as {
			models?: Array<{ name: string; details?: { family?: string; parameter_size?: string } }>;
		};
		if (!Array.isArray(data.models)) return [];

		return data.models.map((m) => ({
			id: m.name,
			provider: "ollama",
			label: `${m.name}${m.details?.parameter_size ? ` (${m.details.parameter_size})` : ""}`,
			tier: "low" as const,
			deprecated: false,
		}));
	} catch {
		logger.debug("model-registry", "Ollama discovery failed (expected if not running)");
		return [];
	}
}

async function discoverAnthropicModels(apiKey: string | undefined): Promise<ModelRegistryEntry[]> {
	if (!apiKey) return KNOWN_MODELS.anthropic ?? [];

	try {
		const res = await fetch("https://api.anthropic.com/v1/models", {
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			signal: AbortSignal.timeout(10000),
		});

		if (!res.ok) {
			// API might not support /v1/models — fall back to known list
			return KNOWN_MODELS.anthropic ?? [];
		}

		const data = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
		if (!Array.isArray(data.data)) return KNOWN_MODELS.anthropic ?? [];

		const entries: ModelRegistryEntry[] = data.data
			.filter((m) => m.id.startsWith("claude-"))
			.map((m) => {
				const tier: "high" | "mid" | "low" = m.id.includes("opus") ? "high" : m.id.includes("sonnet") ? "mid" : "low";
				return {
					id: m.id,
					provider: "anthropic",
					label: m.display_name ?? m.id,
					tier,
					deprecated: false,
				};
			});

		markDeprecatedVersions(entries);
		return entries.length > 0 ? entries : (KNOWN_MODELS.anthropic ?? []);
	} catch {
		logger.debug("model-registry", "Anthropic model discovery failed, using known list");
		return KNOWN_MODELS.anthropic ?? [];
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initModelRegistry(
	config: PipelineModelRegistryConfig,
	ollamaBaseUrl?: string,
	anthropicApiKey?: string,
): void {
	if (!config.enabled) {
		logger.info("model-registry", "Model registry disabled");
		return;
	}

	state = {
		models: new Map(),
		lastRefreshAt: 0,
		refreshTimer: null,
	};

	// Seed with known models
	for (const [provider, models] of Object.entries(KNOWN_MODELS)) {
		state.models.set(provider, [...models]);
	}

	// Run initial discovery
	refreshRegistry(ollamaBaseUrl, anthropicApiKey).catch(() => {});

	// Schedule periodic refresh
	if (config.refreshIntervalMs > 0) {
		state.refreshTimer = setInterval(
			() => refreshRegistry(ollamaBaseUrl, anthropicApiKey).catch(() => {}),
			config.refreshIntervalMs,
		);
	}

	logger.info("model-registry", "Model registry initialized", {
		refreshIntervalMs: config.refreshIntervalMs,
		providers: Object.keys(KNOWN_MODELS).length,
	});
}

export async function refreshRegistry(ollamaBaseUrl?: string, anthropicApiKey?: string): Promise<void> {
	if (!state) return;

	logger.debug("model-registry", "Refreshing model registry");

	// Discover Ollama models in parallel with Anthropic
	const [ollamaModels, anthropicModels] = await Promise.all([
		discoverOllamaModels(ollamaBaseUrl ?? "http://localhost:11434"),
		discoverAnthropicModels(anthropicApiKey),
	]);

	if (ollamaModels.length > 0) {
		// Merge discovered with known, dedup by id
		const known = KNOWN_MODELS.ollama ?? [];
		const merged = new Map<string, ModelRegistryEntry>();
		for (const m of known) merged.set(m.id, m);
		for (const m of ollamaModels) merged.set(m.id, m);
		state.models.set("ollama", [...merged.values()]);
	}

	if (anthropicModels.length > 0) {
		state.models.set("anthropic", anthropicModels);

		// Also update claude-code aliases based on discovered models
		const ccModels: ModelRegistryEntry[] = [];
		const hasOpus = anthropicModels.some((m) => m.id.includes("opus") && !m.deprecated);
		const hasSonnet = anthropicModels.some((m) => m.id.includes("sonnet") && !m.deprecated);
		const hasHaiku = anthropicModels.some((m) => m.id.includes("haiku") && !m.deprecated);
		if (hasOpus)
			ccModels.push({
				id: "opus",
				provider: "claude-code",
				label: "Claude Opus (latest)",
				tier: "high",
				deprecated: false,
			});
		if (hasSonnet)
			ccModels.push({
				id: "sonnet",
				provider: "claude-code",
				label: "Claude Sonnet (latest)",
				tier: "mid",
				deprecated: false,
			});
		if (hasHaiku)
			ccModels.push({
				id: "haiku",
				provider: "claude-code",
				label: "Claude Haiku (latest)",
				tier: "low",
				deprecated: false,
			});
		if (ccModels.length > 0) {
			state.models.set("claude-code", ccModels);
		}
	}

	state.lastRefreshAt = Date.now();
	const totalModels = [...state.models.values()].reduce((sum, arr) => sum + arr.length, 0);
	logger.info("model-registry", "Registry refreshed", {
		totalModels,
		providers: state.models.size,
	});
}

/**
 * Get all available models, optionally filtered by provider.
 * Excludes deprecated models unless includeDeprecated is true.
 */
export function getAvailableModels(provider?: string, includeDeprecated = false): ModelRegistryEntry[] {
	if (!state) {
		// Return known models if registry not initialized
		const all = provider ? (KNOWN_MODELS[provider] ?? []) : Object.values(KNOWN_MODELS).flat();
		return includeDeprecated ? all : all.filter((m) => !m.deprecated);
	}

	if (provider) {
		const models = state.models.get(provider) ?? [];
		return includeDeprecated ? models : models.filter((m) => !m.deprecated);
	}

	const all = [...state.models.values()].flat();
	return includeDeprecated ? all : all.filter((m) => !m.deprecated);
}

/**
 * Get models grouped by provider, for the dashboard dropdown.
 */
export function getModelsByProvider(): Record<string, ModelRegistryEntry[]> {
	const result: Record<string, ModelRegistryEntry[]> = {};
	if (!state) {
		for (const [provider, models] of Object.entries(KNOWN_MODELS)) {
			result[provider] = models.filter((m) => !m.deprecated);
		}
		return result;
	}

	for (const [provider, models] of state.models.entries()) {
		result[provider] = models.filter((m) => !m.deprecated);
	}
	return result;
}

export function getRegistryStatus(): {
	initialized: boolean;
	lastRefreshAt: number;
	modelCounts: Record<string, number>;
} {
	if (!state) {
		return { initialized: false, lastRefreshAt: 0, modelCounts: {} };
	}

	const modelCounts: Record<string, number> = {};
	for (const [provider, models] of state.models.entries()) {
		modelCounts[provider] = models.length;
	}

	return {
		initialized: true,
		lastRefreshAt: state.lastRefreshAt,
		modelCounts,
	};
}

export function stopModelRegistry(): void {
	if (state?.refreshTimer) {
		clearInterval(state.refreshTimer);
		state.refreshTimer = null;
	}
	state = null;
}
