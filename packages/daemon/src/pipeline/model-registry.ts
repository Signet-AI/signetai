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
 * - OpenRouter: GET /models (OpenAI-compatible catalog endpoint)
 * - Claude Code: `claude --version` + known model aliases
 * - Codex: `codex --version` + known model catalog
 * - OpenCode: routes through configured model list
 */

import type { ModelRegistryEntry, PipelineModelRegistryConfig } from "@signet/core";
import { logger } from "../logger";
import { trimTrailingSlash } from "./url";

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
		{ id: "claude-opus-4-6", provider: "claude-code", label: "Claude Opus 4.6", tier: "high", deprecated: false },
		{ id: "claude-sonnet-4-6", provider: "claude-code", label: "Claude Sonnet 4.6", tier: "mid", deprecated: false },
		{ id: "claude-haiku-4-5", provider: "claude-code", label: "Claude Haiku 4.5", tier: "low", deprecated: false },
		{ id: "claude-3-5-haiku-20241022", provider: "claude-code", label: "Claude 3.5 Haiku", tier: "low", deprecated: false },
	],
	anthropic: [
		{ id: "claude-opus-4-6", provider: "anthropic", label: "Claude Opus 4.6", tier: "high", deprecated: false },
		{ id: "claude-sonnet-4-6", provider: "anthropic", label: "Claude Sonnet 4.6", tier: "mid", deprecated: false },
		{ id: "claude-haiku-4-5-20251001", provider: "anthropic", label: "Claude Haiku 4.5", tier: "low", deprecated: false },
		{ id: "claude-3-5-haiku-20241022", provider: "anthropic", label: "Claude 3.5 Haiku", tier: "low", deprecated: false },
	],
	codex: [
		{ id: "gpt-5-codex-mini", provider: "codex", label: "GPT Mini", tier: "low", deprecated: false },
		{ id: "gpt-5.4", provider: "codex", label: "GPT 5.4", tier: "high", deprecated: false },
		{ id: "gpt-5.3-codex", provider: "codex", label: "GPT 5.3 Codex", tier: "high", deprecated: false },
		{ id: "gpt-5.3-codex-spark", provider: "codex", label: "GPT 5.3 Codex Spark", tier: "high", deprecated: false },
		{ id: "gpt-5-codex", provider: "codex", label: "GPT 5 Codex", tier: "mid", deprecated: false },
	],
	opencode: [
		{ id: "anthropic/claude-opus-4-6", provider: "opencode", label: "Claude Opus 4.6", tier: "high", deprecated: false },
		{ id: "anthropic/claude-sonnet-4-6", provider: "opencode", label: "Claude Sonnet 4.6", tier: "mid", deprecated: false },
		{ id: "anthropic/claude-haiku-4-5-20251001", provider: "opencode", label: "Claude Haiku 4.5", tier: "low", deprecated: false },
		{ id: "google/gemini-2.5-flash", provider: "opencode", label: "Gemini 2.5 Flash", tier: "low", deprecated: false },
	],
	openrouter: [
		// Keep these slugs valid for no-discovery fallback mode.
		{ id: "openai/gpt-4o-mini", provider: "openrouter", label: "GPT-4o Mini", tier: "low", deprecated: false },
		{ id: "openai/gpt-4o", provider: "openrouter", label: "GPT-4o", tier: "mid", deprecated: false },
		{ id: "anthropic/claude-haiku-4-5-20251001", provider: "openrouter", label: "Claude Haiku 4.5", tier: "low", deprecated: false },
		{ id: "anthropic/claude-sonnet-4-6", provider: "openrouter", label: "Claude Sonnet 4.6", tier: "mid", deprecated: false },
		{ id: "google/gemini-2.5-flash", provider: "openrouter", label: "Gemini 2.5 Flash", tier: "low", deprecated: false },
	],
	ollama: [
		{ id: "qwen3:4b", provider: "ollama", label: "Qwen3 4B", tier: "low", deprecated: true },
		{ id: "nemotron-3-nano:4b", provider: "ollama", label: "Nemotron 3 Nano 4B", tier: "low", deprecated: false },
		{ id: "glm-4.7-flash", provider: "ollama", label: "GLM 4.7 Flash", tier: "low", deprecated: false },
		{ id: "llama3", provider: "ollama", label: "Llama 3", tier: "low", deprecated: false },
	],
};

// ---------------------------------------------------------------------------
// Version parsing for auto-deprecation
// ---------------------------------------------------------------------------

/**
 * Parse a version from a model ID as a comparable integer.
 * Uses major * 1000 + minor to avoid float comparison bugs with
 * double-digit minor versions (e.g. 4.12 vs 4.6).
 * Examples: "claude-opus-4-6" → 4006, "gpt-5.3-codex" → 5003
 */
function parseModelVersion(modelId: string): number | null {
	const match = modelId.match(/(\d+)[.\-](\d+)/);
	if (!match) return null;
	return Number.parseInt(match[1], 10) * 1000 + Number.parseInt(match[2], 10);
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
 * Clean a model label by stripping date suffixes (e.g. "20251001") and
 * normalising "Claude X N.N" format so users see e.g. "Claude Opus 4.6"
 * instead of "Claude claude-opus-4-6-20251001".
 */
function cleanModelLabel(raw: string): string {
	// Strip trailing date stamps like "-20251001" or " 20250514"
	let label = raw.replace(/[-\s]\d{8}$/, "");
	// If the label is still a raw model ID, humanise it
	if (/^claude-/.test(label)) {
		label = label
			.replace(/-(\d+)-(\d+)/, " $1.$2") // version before prefix strip
			.replace(/^claude-/, "Claude ")
			.replace(/-/g, " ")
			.replace(/\b\w/g, (c) => c.toUpperCase());
	}
	return label;
}

/**
 * Given a list of models, return a new array with older versions of the
 * same family marked as deprecated. Does not mutate the input.
 */
function markDeprecatedVersions(entries: readonly ModelRegistryEntry[]): ModelRegistryEntry[] {
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

	return entries.map((entry) => {
		const family = parseModelFamily(entry.id);
		const version = parseModelVersion(entry.id);
		if (version === null) return { ...entry };

		const best = familyBest.get(family);
		if (best && best.id !== entry.id && version < best.version) {
			return { ...entry, deprecated: true };
		}
		return { ...entry };
	});
}

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

interface RegistryState {
	models: Map<string, ModelRegistryEntry[]>;
	lastRefreshAt: number;
	refreshTimer: ReturnType<typeof setInterval> | null;
	epoch: number;
}

let state: RegistryState | null = null;
let refreshInFlight: Promise<void> | null = null;
let registryEpoch = 0;

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
	if (!apiKey) return markDeprecatedVersions(KNOWN_MODELS.anthropic ?? []);

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
			return markDeprecatedVersions(KNOWN_MODELS.anthropic ?? []);
		}

		const data = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
		if (!Array.isArray(data.data)) return markDeprecatedVersions(KNOWN_MODELS.anthropic ?? []);

		let entries: ModelRegistryEntry[] = data.data
			.filter((m) => m.id.startsWith("claude-"))
			.map((m) => {
				const tier: "high" | "mid" | "low" = m.id.includes("opus") ? "high" : m.id.includes("sonnet") ? "mid" : "low";
				return {
					id: m.id,
					provider: "anthropic",
					label: cleanModelLabel(m.display_name ?? m.id),
					tier,
					deprecated: false,
				};
			});

		entries = markDeprecatedVersions(entries);
		return entries.length > 0 ? entries : markDeprecatedVersions(KNOWN_MODELS.anthropic ?? []);
	} catch {
		logger.debug("model-registry", "Anthropic model discovery failed, using known list");
		return markDeprecatedVersions(KNOWN_MODELS.anthropic ?? []);
	}
}

function inferOpenRouterTier(id: string): "high" | "mid" | "low" {
	const normalized = id.toLowerCase();
	if (
		normalized.includes("-mini") ||
		normalized.includes(":mini") ||
		normalized.endsWith("mini")
	) {
		return "low";
	}
	if (
		normalized.includes("opus") ||
		normalized.includes("gpt-5") ||
		normalized.includes("claude-4") ||
		normalized.includes("o1")
	) {
		return "high";
	}
	if (
		normalized.includes("sonnet") ||
		normalized.includes("gpt-4") ||
		normalized.includes("r1")
	) {
		return "mid";
	}
	return "low";
}

async function discoverOpenRouterModels(
	apiKey: string | undefined,
	baseUrl: string | undefined,
): Promise<ModelRegistryEntry[]> {
	if (!apiKey) return markDeprecatedVersions(KNOWN_MODELS.openrouter ?? []);

	const host = trimTrailingSlash(baseUrl ?? "https://openrouter.ai/api/v1");
	try {
		const res = await fetch(`${host}/models`, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) {
			return markDeprecatedVersions(KNOWN_MODELS.openrouter ?? []);
		}

		const data = (await res.json()) as {
			data?: Array<{ id?: string; name?: string }>;
		};
		if (!Array.isArray(data.data)) {
			return markDeprecatedVersions(KNOWN_MODELS.openrouter ?? []);
		}

		const entries = data.data
			.filter(
				(model): model is { id: string; name?: string } =>
					typeof model.id === "string" && model.id.trim().length > 0,
			)
			.map((model) => ({
				id: model.id,
				provider: "openrouter",
				label:
					typeof model.name === "string" && model.name.trim().length > 0
						? model.name
						: model.id,
				tier: inferOpenRouterTier(model.id),
				deprecated: false,
			}));

		if (entries.length === 0) {
			return markDeprecatedVersions(KNOWN_MODELS.openrouter ?? []);
		}

		return markDeprecatedVersions(entries);
	} catch {
		logger.debug("model-registry", "OpenRouter model discovery failed, using known list");
		return markDeprecatedVersions(KNOWN_MODELS.openrouter ?? []);
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initModelRegistry(
	config: PipelineModelRegistryConfig,
	ollamaBaseUrl?: string,
	anthropicApiKey?: string,
	openRouterApiKey?: string,
	openRouterBaseUrl?: string,
): void {
	if (!config.enabled) {
		logger.info("model-registry", "Model registry disabled");
		return;
	}

	// Clean up any previous instance to avoid leaking timers
	if (state?.refreshTimer) {
		clearInterval(state.refreshTimer);
	}

	registryEpoch++;
	state = {
		models: new Map(),
		lastRefreshAt: 0,
		refreshTimer: null,
		epoch: registryEpoch,
	};

	// Seed with known models, applying deprecation marks
	for (const [provider, models] of Object.entries(KNOWN_MODELS)) {
		state.models.set(provider, markDeprecatedVersions(models));
	}

	// Run initial discovery
	refreshRegistry(
		ollamaBaseUrl,
		anthropicApiKey,
		openRouterApiKey,
		openRouterBaseUrl,
	).catch((err) => {
		logger.warn("model-registry", "Initial registry refresh failed", { error: String(err) });
	});

	// Schedule periodic refresh
	if (config.refreshIntervalMs > 0) {
		state.refreshTimer = setInterval(
			() =>
				refreshRegistry(
					ollamaBaseUrl,
					anthropicApiKey,
					openRouterApiKey,
					openRouterBaseUrl,
				).catch((err) => {
					logger.warn("model-registry", "Periodic registry refresh failed", { error: String(err) });
				}),
			config.refreshIntervalMs,
		);
	}

	logger.info("model-registry", "Model registry initialized", {
		refreshIntervalMs: config.refreshIntervalMs,
		providers: Object.keys(KNOWN_MODELS).length,
	});
}

export async function refreshRegistry(
	ollamaBaseUrl?: string,
	anthropicApiKey?: string,
	openRouterApiKey?: string,
	openRouterBaseUrl?: string,
): Promise<void> {
	if (!state) return;

	// Serialize refreshes to prevent stale out-of-order writes
	if (refreshInFlight) {
		await refreshInFlight;
	}

	const doRefresh = async (): Promise<void> => {
		await _refreshRegistryInner(
			ollamaBaseUrl,
			anthropicApiKey,
			openRouterApiKey,
			openRouterBaseUrl,
		);
	};
	refreshInFlight = doRefresh();
	try {
		await refreshInFlight;
	} finally {
		refreshInFlight = null;
	}
}

async function _refreshRegistryInner(
	ollamaBaseUrl?: string,
	anthropicApiKey?: string,
	openRouterApiKey?: string,
	openRouterBaseUrl?: string,
): Promise<void> {
	if (!state) return;
	const startEpoch = state.epoch;

	logger.debug("model-registry", "Refreshing model registry");

	// Discover models in parallel — only probe providers that are configured
	const [ollamaModels, anthropicModels, openRouterModels] = await Promise.all([
		ollamaBaseUrl ? discoverOllamaModels(ollamaBaseUrl) : Promise.resolve([]),
		discoverAnthropicModels(anthropicApiKey),
		discoverOpenRouterModels(openRouterApiKey, openRouterBaseUrl),
	]);

	// Bail if registry was stopped or re-initialized during discovery
	if (!state || state.epoch !== startEpoch) return;

	if (ollamaModels.length > 0) {
		// Merge discovered with known, dedup by id, then mark deprecations
		const known = KNOWN_MODELS.ollama ?? [];
		const merged = new Map<string, ModelRegistryEntry>();
		for (const m of known) merged.set(m.id, m);
		for (const m of ollamaModels) merged.set(m.id, m);
		state.models.set("ollama", markDeprecatedVersions([...merged.values()]));
	}

	if (anthropicModels.length > 0) {
		state.models.set("anthropic", anthropicModels);
		// Do NOT overwrite "claude-code" — its IDs must match what the
		// Claude Code CLI accepts (shorthand aliases, not dated Anthropic IDs).
		// The seeded KNOWN_MODELS["claude-code"] entries use the correct shorthands.
	}

	if (openRouterModels.length > 0) {
		state.models.set("openrouter", openRouterModels);
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
		// Return known models with deprecation marks if registry not initialized
		const raw = provider ? (KNOWN_MODELS[provider] ?? []) : Object.values(KNOWN_MODELS).flat();
		const all = markDeprecatedVersions(raw);
		return includeDeprecated ? all : all.filter((m) => !m.deprecated);
	}

	if (provider) {
		const models = state.models.get(provider) ?? [];
		return includeDeprecated ? [...models] : models.filter((m) => !m.deprecated);
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
			result[provider] = markDeprecatedVersions(models).filter((m) => !m.deprecated);
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
