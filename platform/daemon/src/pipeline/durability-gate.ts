/**
 * Deterministic durability gate.
 *
 * Rejects transient operational content — task progress, run/test status,
 * queue/process/resource counts, temporary paths, short-validity hedging,
 * and self-diagnostics — before it is persisted as durable memory.
 *
 * This complements the novelty-based write gate, which measures whether a
 * fact is *surprising* but cannot tell durable from transient: a queue count
 * or an "in progress" status is often high-confidence and high-novelty, so it
 * sails through confidence + surprisal gates into durable storage. This gate
 * is the deterministic post-extraction filter that #897 identified as missing.
 *
 * Patterns are intentionally narrow: they require operational phrasing, not
 * loose keywords, so durable facts that happen to mention paths, numbers, or
 * PRs are preserved.
 *
 * See https://github.com/Signet-AI/signetai/issues/897
 */

export interface DurabilityConfig {
	readonly enabled: boolean;
}

export type DurabilityReason = "gate_disabled" | "decision_type" | "transient_operational" | "durable";

export interface DurabilityResult {
	readonly durable: boolean;
	readonly reason: DurabilityReason;
	/** Transient category when reason === "transient_operational". */
	readonly category?: string;
}

/**
 * Each entry: [category, regex]. A fact is transient if any pattern matches.
 * Order does not matter; the first match wins and names the category.
 */
const TRANSIENT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
	// Temporary / runtime filesystem artifacts. Deliberately NOT all paths —
	// durable config locations ($HOME/.agents, /etc, /usr/local) must survive.
	["temporary_path", /(^|\s)(\/tmp\/|\/var\/folders\/|\/private\/tmp\/|\/private\/var\/folders\/|\$TMPDIR\/)/],
	["temporary_path", /\b(runtime|temp|tmp)[\/\\][^\s]*\.(log|pid|tmp|out)\b/i],

	// Queue / process / resource counts (operational state, goes stale fast).
	[
		"queue_or_resource_count",
		/\b\d+\s+(items?|tasks?|jobs?|messages?|requests?|rows?|records?)\b.{0,30}?\b(queued|pending|backlogged|in\s+(the\s+)?queue)\b/i,
	],
	[
		"queue_or_resource_count",
		/\b\d+\s+(processes|threads|workers|connections|handlers)\s+(running|active|connected|spawned)\b/i,
	],
	["queue_or_resource_count", /\b\d+(\.\d+)?\s*%\s*(cpu|memory|ram|disk)\s+(usage|utilization|used)\b/i],
	["queue_or_resource_count", /\b(cpu|memory|ram|disk)\s+(usage|utilization)\b[^.]{0,24}?\b\d+(\.\d+)?\s*%/i],

	// Active run / test / command status.
	["run_status", /\btest\s+suite\s+is\s+(currently\s+)?running\b/i],
	["run_status", /\b\d+\s+failures?\s+so\s+far\b/i],
	["run_status", /\bexit\s+code\s+[+-]?\d+\b/i],
	["run_status", /\bcurrently\s+(running|executing|building|deploying|compiling|scanning)\b/i],

	// In-progress work (unfinished, expected to change).
	["in_progress", /\bin\s+progress\b/i],
	["in_progress", /\bcurrently\s+working\s+on\b/i],
	["in_progress", /\b(about|around|roughly|nearly|almost)\s+\d+\s?%\s*(done|complete|finished)\b/i],
	["in_progress", /\b\d+\s?%\s+(complete|done|finished)\b/i],
	["in_progress", /\bhalfway\s+(through|done)\b/i],

	// Short-validity hedging (the speaker signals it is not yet settled).
	[
		"short_validity",
		/\b(still\s+checking|still\s+verifying|still\s+investigating|not\s+sure\s+yet|tentatively|pending\s+confirmation|to\s+be\s+(determined|confirmed)|\btbd\b)\b/i,
	],

	// Task progress / todo (forward-looking operational steps).
	["task_progress", /\bnext\s+(i|we)\s+(need\s+to|will|should|plan\s+to|are\s+going\s+to)\b/i],
	["task_progress", /\bnext\s+step\s+is\b/i],
	["task_progress", /\b(todo|remaining|outstanding)\s*[:)]/i],
	["task_progress", /\bstill\s+need\s+to\b/i],
	["task_progress", /\bstep\s+\d+\s+of\s+\d+\b/i],

	// Self-diagnostic performance metrics about Signet itself during a session.
	[
		"self_diagnostic",
		/\b(recall|search|embedding|extraction|ingest|query)\s+latency\s+(averaged|was|of|around|about)\s+\d+\s*ms\b/i,
	],
	["self_diagnostic", /\b\d+\s*(ms|req\/s|ops\/s|qps)\s+(latency|throughput)\b/i],
];

/**
 * Assess whether extracted content is durable enough to persist as a memory.
 *
 * Decisions bypass the gate (they are durable by definition and the write gate
 * bypasses them too). Everything else is classified by content. The gate is
 * deterministic and conservative: only clearly-transient operational content
 * is rejected.
 */
export function assessDurability(
	content: string,
	factType: string | undefined,
	cfg: DurabilityConfig,
): DurabilityResult {
	if (!cfg.enabled) {
		return { durable: true, reason: "gate_disabled" };
	}
	if (factType === "decision") {
		return { durable: true, reason: "decision_type" };
	}
	const trimmed = content.trim();
	if (trimmed.length === 0) {
		// Empty content is handled by the caller; treat as durable here.
		return { durable: true, reason: "durable" };
	}
	for (const [category, pattern] of TRANSIENT_PATTERNS) {
		if (pattern.test(trimmed)) {
			return { durable: false, reason: "transient_operational", category };
		}
	}
	return { durable: true, reason: "durable" };
}
