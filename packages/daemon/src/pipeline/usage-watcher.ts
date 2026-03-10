/**
 * Usage Limit Watcher
 *
 * Monitors LLM provider responses and errors for rate-limit / usage-cap
 * signals. When consecutive signals exceed the configured threshold,
 * automatically downgrades to the cheapest available model for that
 * provider family and optionally triggers a daemon restart to apply
 * the new config.
 *
 * Designed to protect long-running extraction pipelines from stalling
 * when a token-based model (Codex, Claude Code, OpenCode) hits its
 * weekly/session usage ceiling.
 */

import type { LlmGenerateResult, LlmProvider } from "@signet/core";
import type { PipelineUsageWatcherConfig } from "@signet/core";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Rate-limit signal detection
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate the upstream provider is throttling or capping
 * the current model tier. Matches against LLM response text, error
 * messages, and stderr output.
 */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
	/you(?:'re| are) nearing your (?:weekly|daily|monthly|session) (?:usage )?limit/i,
	/rate limit (?:exceeded|reached|hit)/i,
	/usage (?:limit|cap|quota) (?:exceeded|reached)/i,
	/too many requests/i,
	/resource[_ ]?exhausted/i,
	/budget[_ ]?(?:cap|exceeded|depleted)/i,
	/token[_ ]?(?:limit|quota) (?:reached|exceeded)/i,
	/throttl(?:ed|ing)/i,
	/429/,
	/capacity[_ ]?(?:exceeded|limit)/i,
	/overloaded/i,
	/slow[_ ]?down/i,
	/please try again later/i,
	/max[_ ]?(?:usage|tokens?|requests?) (?:reached|exceeded)/i,
];

/** Check if a string contains a rate-limit signal. */
export function containsRateLimitSignal(text: string): boolean {
	return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Model downgrade maps
// ---------------------------------------------------------------------------

/**
 * For each provider, define a fallback chain from expensive → cheap.
 * The watcher walks down the chain on each downgrade event.
 */
const MODEL_FALLBACK_CHAINS: Readonly<Record<string, readonly string[]>> = {
	"claude-code": ["opus", "sonnet", "haiku"],
	anthropic: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
	codex: ["gpt-5.3-codex", "gpt-5-codex", "gpt-5-codex-mini"],
	opencode: ["anthropic/claude-sonnet-4-5-20250514", "anthropic/claude-haiku-4-5-20251001", "google/gemini-2.5-flash"],
	ollama: ["qwen3:4b", "glm-4.7-flash", "llama3"],
};

/**
 * Given the current model and provider, return the next cheaper model
 * in the fallback chain. Returns null if already at the bottom.
 */
export function getDowngradeModel(provider: string, currentModel: string): string | null {
	const chain = MODEL_FALLBACK_CHAINS[provider];
	if (!chain) return null;

	const idx = chain.indexOf(currentModel);
	if (idx === -1) {
		// Current model not in chain — jump to cheapest
		return chain[chain.length - 1] ?? null;
	}
	if (idx >= chain.length - 1) {
		// Already at cheapest
		return null;
	}
	return chain[idx + 1] ?? null;
}

/**
 * Get the cheapest model for a provider.
 */
export function getCheapestModel(provider: string): string | null {
	const chain = MODEL_FALLBACK_CHAINS[provider];
	return chain ? (chain[chain.length - 1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Watcher state
// ---------------------------------------------------------------------------

interface WatcherState {
	consecutiveSignals: number;
	lastDowngradeAt: number;
	currentProvider: string;
	currentModel: string;
	downgradedProvider: string | null;
	downgradedModel: string | null;
	totalDowngrades: number;
	totalSignalsDetected: number;
}

let watcherState: WatcherState | null = null;
let watcherConfig: PipelineUsageWatcherConfig | null = null;
let restartCallback: (() => void) | null = null;

export function initUsageWatcher(
	config: PipelineUsageWatcherConfig,
	provider: string,
	model: string,
	onRestart?: () => void,
): void {
	watcherConfig = config;
	restartCallback = onRestart ?? null;
	watcherState = {
		consecutiveSignals: 0,
		lastDowngradeAt: 0,
		currentProvider: provider,
		currentModel: model,
		downgradedProvider: null,
		downgradedModel: null,
		totalDowngrades: 0,
		totalSignalsDetected: 0,
	};

	if (config.enabled) {
		logger.info("usage-watcher", "Usage limit watcher initialized", {
			provider,
			model,
			threshold: config.triggerThreshold,
			cooldownMs: config.cooldownMs,
			restartOnDowngrade: config.restartOnDowngrade,
		});
	}
}

export function getUsageWatcherStatus(): {
	enabled: boolean;
	state: WatcherState | null;
} {
	return {
		enabled: watcherConfig?.enabled ?? false,
		state: watcherState ? { ...watcherState } : null,
	};
}

export function resetUsageWatcher(): void {
	if (watcherState) {
		watcherState.consecutiveSignals = 0;
		watcherState.downgradedProvider = null;
		watcherState.downgradedModel = null;
		logger.info("usage-watcher", "Watcher state reset");
	}
}

// ---------------------------------------------------------------------------
// Core detection + downgrade logic
// ---------------------------------------------------------------------------

/**
 * Called after every LLM interaction. Checks the response/error text
 * for rate-limit signals and triggers downgrade if threshold exceeded.
 *
 * Returns the downgrade target if one was triggered, null otherwise.
 */
export function recordLlmInteraction(
	responseText: string,
	errorText?: string,
): { provider: string; model: string } | null {
	if (!watcherConfig?.enabled || !watcherState) return null;

	const combined = `${responseText}\n${errorText ?? ""}`;
	const detected = containsRateLimitSignal(combined);

	if (detected) {
		watcherState.consecutiveSignals++;
		watcherState.totalSignalsDetected++;
		logger.warn("usage-watcher", "Rate limit signal detected", {
			consecutive: watcherState.consecutiveSignals,
			threshold: watcherConfig.triggerThreshold,
			provider: watcherState.currentProvider,
			model: watcherState.currentModel,
		});
	} else {
		// Successful response — reset consecutive counter
		watcherState.consecutiveSignals = 0;
		return null;
	}

	// Check if threshold exceeded
	if (watcherState.consecutiveSignals < watcherConfig.triggerThreshold) {
		return null;
	}

	// Check cooldown
	const now = Date.now();
	if (now - watcherState.lastDowngradeAt < watcherConfig.cooldownMs) {
		logger.debug("usage-watcher", "Downgrade cooldown active, skipping", {
			remainingMs: watcherConfig.cooldownMs - (now - watcherState.lastDowngradeAt),
		});
		return null;
	}

	// Attempt downgrade
	const downgradeModel = getDowngradeModel(watcherState.currentProvider, watcherState.currentModel);

	if (!downgradeModel) {
		logger.warn("usage-watcher", "Already at cheapest model, cannot downgrade further", {
			provider: watcherState.currentProvider,
			model: watcherState.currentModel,
		});
		return null;
	}

	// Apply downgrade
	watcherState.downgradedProvider = watcherState.currentProvider;
	watcherState.downgradedModel = downgradeModel;
	watcherState.currentModel = downgradeModel;
	watcherState.lastDowngradeAt = now;
	watcherState.consecutiveSignals = 0;
	watcherState.totalDowngrades++;

	logger.warn("usage-watcher", "Model downgrade triggered", {
		provider: watcherState.currentProvider,
		previousModel: watcherState.downgradedProvider,
		newModel: downgradeModel,
		totalDowngrades: watcherState.totalDowngrades,
		restartOnDowngrade: watcherConfig.restartOnDowngrade,
	});

	const result = {
		provider: watcherState.currentProvider,
		model: downgradeModel,
	};

	// Trigger restart if configured
	if (watcherConfig.restartOnDowngrade && restartCallback) {
		logger.info("usage-watcher", "Triggering daemon restart to apply model downgrade");
		// Defer restart to allow current request to complete
		setTimeout(() => {
			restartCallback?.();
		}, 1000);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Provider wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps an LlmProvider with usage-limit interception. Every generate
 * call is monitored for rate-limit signals in both successful responses
 * and errors.
 */
export function wrapProviderWithWatcher(provider: LlmProvider): LlmProvider {
	return {
		name: provider.name,

		async generate(prompt, opts): Promise<string> {
			try {
				const result = await provider.generate(prompt, opts);
				recordLlmInteraction(result);
				return result;
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				recordLlmInteraction("", errorMsg);
				throw err;
			}
		},

		async generateWithUsage(prompt, opts): Promise<LlmGenerateResult> {
			if (!provider.generateWithUsage) {
				const text = await this.generate(prompt, opts);
				return { text, usage: null };
			}
			try {
				const result = await provider.generateWithUsage(prompt, opts);
				recordLlmInteraction(result.text);
				return result;
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				recordLlmInteraction("", errorMsg);
				throw err;
			}
		},

		available: () => provider.available(),
	};
}

// ---------------------------------------------------------------------------
// Config patcher — writes downgrade to agent.yaml
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Persist a model downgrade to agent.yaml so the daemon picks it up
 * after restart. Operates via simple string replacement to preserve
 * YAML formatting.
 */
export function persistModelDowngrade(agentsDir: string, provider: string, newModel: string): boolean {
	const yamlPath = join(agentsDir, "agent.yaml");
	if (!existsSync(yamlPath)) {
		logger.warn("usage-watcher", "agent.yaml not found, cannot persist downgrade");
		return false;
	}

	try {
		let content = readFileSync(yamlPath, "utf-8");

		// Update extractionModel if present
		const modelRegex = /^(\s*extractionModel:\s*).+$/m;
		if (modelRegex.test(content)) {
			content = content.replace(modelRegex, `$1${newModel}`);
		}

		// Also update nested extraction.model if present
		const nestedModelRegex = /^(\s+model:\s*).+$/m;
		// Only replace within pipelineV2.extraction context — look for
		// extraction block proximity. This is a best-effort heuristic.
		const extractionBlockMatch = content.match(/extraction:\s*\n([\s\S]*?)(?=\n\s*\w+:|$)/);
		if (extractionBlockMatch) {
			const block = extractionBlockMatch[0];
			const updatedBlock = block.replace(nestedModelRegex, `$1${newModel}`);
			content = content.replace(block, updatedBlock);
		}

		writeFileSync(yamlPath, content);
		logger.info("usage-watcher", "Persisted model downgrade to agent.yaml", {
			provider,
			newModel,
		});
		return true;
	} catch (err) {
		logger.error("usage-watcher", "Failed to persist model downgrade", {
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

// ---------------------------------------------------------------------------
// Restart state persistence
// ---------------------------------------------------------------------------
// When the watcher triggers a daemon restart, it writes a small JSON
// breadcrumb to .daemon/watcher-restart.json. On the next startup the
// daemon reads this file to know:
//   1. A previous instance was running and was restarted for a downgrade
//   2. What model was active before and what it was downgraded to
//   3. When the restart happened
// This lets the daemon force-release stale job leases, log resume
// context, and avoid re-triggering the same downgrade immediately.

export interface WatcherRestartBreadcrumb {
	readonly restartedAt: string;
	readonly previousModel: string;
	readonly downgradedModel: string;
	readonly provider: string;
	readonly reason: "usage-limit-downgrade";
	readonly pid: number;
	readonly totalDowngrades: number;
}

function breadcrumbPath(agentsDir: string): string {
	return join(agentsDir, ".daemon", "watcher-restart.json");
}

/**
 * Write a restart breadcrumb so the next daemon process can detect
 * that it's resuming after a usage-limit downgrade.
 */
export function writeRestartBreadcrumb(
	agentsDir: string,
	previousModel: string,
	downgradedModel: string,
	provider: string,
): void {
	const daemonDir = join(agentsDir, ".daemon");
	mkdirSync(daemonDir, { recursive: true });

	const crumb: WatcherRestartBreadcrumb = {
		restartedAt: new Date().toISOString(),
		previousModel,
		downgradedModel,
		provider,
		reason: "usage-limit-downgrade",
		pid: process.pid,
		totalDowngrades: watcherState?.totalDowngrades ?? 0,
	};

	writeFileSync(breadcrumbPath(agentsDir), JSON.stringify(crumb, null, 2));
	logger.info("usage-watcher", "Wrote restart breadcrumb", crumb);
}

/**
 * Read and consume a restart breadcrumb. Returns null if none exists.
 * Consuming (deleting) prevents the breadcrumb from affecting future
 * restarts that aren't caused by the watcher.
 */
export function consumeRestartBreadcrumb(
	agentsDir: string,
): WatcherRestartBreadcrumb | null {
	const path = breadcrumbPath(agentsDir);
	if (!existsSync(path)) return null;

	try {
		const raw = readFileSync(path, "utf-8");
		const crumb = JSON.parse(raw) as WatcherRestartBreadcrumb;

		// Consume: delete the file so it's one-shot
		unlinkSync(path);

		logger.info("usage-watcher", "Consumed restart breadcrumb — this is a post-downgrade resumption", {
			previousModel: crumb.previousModel,
			downgradedModel: crumb.downgradedModel,
			provider: crumb.provider,
			restartedAt: crumb.restartedAt,
			previousPid: crumb.pid,
		});

		return crumb;
	} catch (err) {
		logger.warn("usage-watcher", "Failed to read restart breadcrumb", {
			error: err instanceof Error ? err.message : String(err),
		});
		// Clean up corrupt file
		try { unlinkSync(path); } catch { /* ignore */ }
		return null;
	}
}

/**
 * Force-release all leased jobs back to pending. Called on startup
 * after a watcher-triggered restart so in-flight work from the
 * previous process doesn't stay stuck in 'leased' state until the
 * lease timeout expires (which could be 5 minutes).
 *
 * This is separate from releaseStaleLeases in repair-actions.ts
 * because that function is rate-limited and checks the lease timeout
 * window. Here we release unconditionally since we *know* the
 * previous process is dead.
 */
export function forceReleaseAllLeases(
	withWriteTx: <T>(fn: (db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }) => T) => T,
): number {
	return withWriteTx((db) => {
		const now = new Date().toISOString();
		const result = db
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'pending', leased_at = NULL, updated_at = ?
				 WHERE status = 'leased'`,
			)
			.run(now);

		// Bun SQLite returns { changes: number }, better-sqlite3 returns
		// RunResult with .changes — handle both.
		const changes = typeof result === "object" && result !== null
			? (result as { changes?: number }).changes ?? 0
			: 0;

		if (changes > 0) {
			logger.info("usage-watcher", "Force-released leased jobs for post-downgrade resumption", {
				released: changes,
			});
		}
		return changes;
	});
}
