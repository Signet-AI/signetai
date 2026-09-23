/** SDK-local native daemon contract helpers. Keep the published SDK independent of workspace runtime packages. */

export function resolveNativeDaemonUrl(env: Record<string, string | undefined> = {}): string {
	const configured = env.SIGNET_DAEMON_URL?.trim();
	if (configured) {
		const url = new URL(configured);
		if (url.protocol !== "http:" && url.protocol !== "https:")
			throw new Error("SIGNET_DAEMON_URL must use http or https");
		if (url.pathname !== "/" || url.search || url.hash)
			throw new Error("SIGNET_DAEMON_URL must point at the daemon origin");
		return url.toString().replace(/\/$/, "");
	}
	return `http://${env.SIGNET_HOST?.trim() || "127.0.0.1"}:${env.SIGNET_PORT?.trim() || "3850"}`;
}

function defined<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function buildNativeRecallRequestBody(
	query: string,
	options: Record<string, unknown> = {},
): Record<string, unknown> {
	const limit =
		typeof options.limit === "number" && Number.isFinite(options.limit)
			? Math.min(100, Math.max(1, Math.trunc(options.limit)))
			: 10;
	return defined({
		query,
		keywordQuery: options.keywordQuery ?? options.keyword_query,
		limit,
		project: options.project,
		type: options.type,
		tags: options.tags,
		who: options.who,
		pinned: options.pinned === true ? true : undefined,
		importance_min: options.importance_min,
		since: options.since,
		until: options.until,
		time: options.time,
		expand: options.expand === true ? true : undefined,
		agentId: options.agentId ?? options.agent_id ?? options.contextAgentId,
		sessionKey: options.sessionKey ?? options.session_key,
		includeRecalled: options.includeRecalled === true || options.include_recalled === true ? true : undefined,
		scope: options.scope,
		sourceOnly: options.sourceOnly === true || options.source_only === true ? true : undefined,
		aggregate: options.aggregate === true ? true : undefined,
		aggregateBudget: options.aggregateBudget ?? options.aggregate_budget,
		saveAggregate:
			options.saveAggregate === false || options.save_aggregate === false
				? false
				: options.saveAggregate === true || options.save_aggregate === true
					? true
					: undefined,
		minScore: typeof options.minScore === "number" && Number.isFinite(options.minScore) ? options.minScore : undefined,
		recallSurface: options.recallSurface,
	});
}

export function applyNativeRecallScoreThreshold<T>(raw: T, minScore?: number): T {
	if (
		typeof minScore !== "number" ||
		!Number.isFinite(minScore) ||
		typeof raw !== "object" ||
		raw === null ||
		Array.isArray(raw)
	)
		return raw;
	const payload = raw as T & {
		results?: Array<{ score?: unknown; supplementary?: boolean }>;
		meta?: Record<string, unknown>;
	};
	const results = Array.isArray(payload.results)
		? payload.results.filter((row) => typeof row.score !== "number" || row.score >= minScore)
		: [];
	return {
		...payload,
		results,
		meta: {
			...(payload.meta ?? {}),
			totalReturned: results.length,
			hasSupplementary: results.some((row) => row.supplementary === true),
			noHits: results.length === 0,
		},
	};
}
