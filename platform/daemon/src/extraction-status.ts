export function firstCandidateBlockedBy(details: unknown): readonly string[] {
	if (!details || typeof details !== "object" || !("trace" in details)) return [];
	const trace = details.trace;
	if (!trace || typeof trace !== "object" || !("candidates" in trace) || !Array.isArray(trace.candidates)) {
		return [];
	}
	const firstCandidate = trace.candidates[0];
	if (
		!firstCandidate ||
		typeof firstCandidate !== "object" ||
		!("blockedBy" in firstCandidate) ||
		!Array.isArray(firstCandidate.blockedBy)
	) {
		return [];
	}
	return firstCandidate.blockedBy.filter(
		(reason: unknown): reason is string => typeof reason === "string" && reason.trim().length > 0,
	);
}
