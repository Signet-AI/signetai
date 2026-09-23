/**
 * Phase D stability acceptance criteria (#1543), codified.
 *
 * These are issue #1543's own numbers:
 *   - zero event-loop blocks >= 2000ms across the whole run
 *   - /health/live p95 < 500ms
 *   - /api/status p95 < 1000ms
 *
 * This module is a judge, not a fixer: it evaluates measured numbers and
 * reports pass/fail plus a human summary naming the worst offending window.
 */

export interface StabilityMeasurements {
	readonly eventLoop: {
		readonly blockBudgetMs: number;
		readonly blocksOverBudget: number;
		readonly p50Ms: number;
		readonly p95Ms: number;
		readonly maxMs: number;
		readonly worstBlock: { readonly at: number; readonly ms: number; readonly phase: string } | null;
	};
	readonly healthLive: {
		readonly samples: number;
		readonly failures: number;
		readonly p95Ms: number;
		readonly maxMs: number;
	};
	readonly apiStatus: {
		readonly samples: number;
		readonly failures: number;
		readonly p95Ms: number;
		readonly maxMs: number;
	};
}

export interface StabilityCheck {
	readonly name: string;
	readonly pass: boolean;
	readonly observed: string;
	readonly limit: string;
}

export interface StabilityEvaluation {
	readonly pass: boolean;
	readonly checks: readonly StabilityCheck[];
	readonly summary: string;
}

/** p95 from a pre-sorted sample series (index-based, nearest-rank). */
export function percentile(values: readonly number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * fraction)));
	return sorted[rank - 1] ?? 0;
}

export function evaluateStability(m: StabilityMeasurements): StabilityEvaluation {
	const checks: StabilityCheck[] = [
		{
			name: `event-loop blocks >= ${m.eventLoop.blockBudgetMs}ms (whole run)`,
			pass: m.eventLoop.blocksOverBudget === 0,
			observed:
				m.eventLoop.blocksOverBudget === 0
					? "0 blocks over budget"
					: `${m.eventLoop.blocksOverBudget} block(s) over budget, worst ${Math.round(m.eventLoop.worstBlock?.ms ?? 0)}ms in phase "${m.eventLoop.worstBlock?.phase ?? "unknown"}" at T+${Math.round((m.eventLoop.worstBlock?.at ?? 0) / 1000)}s`,
			limit: "0",
		},
		{
			name: "/health/live p95",
			pass: m.healthLive.p95Ms < 500,
			observed: `${Math.round(m.healthLive.p95Ms)}ms (max ${Math.round(m.healthLive.maxMs)}ms, ${m.healthLive.failures}/${m.healthLive.samples} failed)`,
			limit: "< 500ms",
		},
		{
			name: "/api/status p95",
			pass: m.apiStatus.p95Ms < 1000,
			observed: `${Math.round(m.apiStatus.p95Ms)}ms (max ${Math.round(m.apiStatus.maxMs)}ms, ${m.apiStatus.failures}/${m.apiStatus.samples} failed)`,
			limit: "< 1000ms",
		},
	];

	const failed = checks.filter((c) => !c.pass);
	const summary =
		failed.length === 0
			? "Phase D stability acceptance PASSED: no event-loop block reached the 2000ms budget and both liveness surfaces stayed inside their p95 limits."
			: `Phase D stability acceptance FAILED. Worst offending window: ${
					m.eventLoop.worstBlock
						? `event loop blocked ${Math.round(m.eventLoop.worstBlock.ms)}ms during phase "${m.eventLoop.worstBlock.phase}" (started at epoch ms ${m.eventLoop.worstBlock.at})`
						: `no single block over budget, but latency limits were exceeded (${failed.map((c) => c.name).join("; ")})`
				}`;

	return { pass: failed.length === 0, checks, summary };
}
