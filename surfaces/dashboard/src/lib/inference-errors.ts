export function routeBlockedBy(details: unknown): string[] {
	if (details == null || typeof details !== "object" || Array.isArray(details)) return [];
	const trace = (details as Record<string, unknown>).trace;
	if (trace == null || typeof trace !== "object" || Array.isArray(trace)) return [];
	const candidates = (trace as Record<string, unknown>).candidates;
	if (!Array.isArray(candidates)) return [];
	return candidates.flatMap((candidate) => {
		if (candidate == null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
		const row = candidate as Record<string, unknown>;
		const blockedBy = Array.isArray(row.blockedBy)
			? row.blockedBy.filter((reason): reason is string => typeof reason === "string")
			: [];
		if (blockedBy.length === 0) return [];
		const targetRef = typeof row.targetRef === "string" ? row.targetRef : "candidate";
		return [`${targetRef}: ${blockedBy.join(", ")}`];
	});
}
