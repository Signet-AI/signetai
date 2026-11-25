export interface ForgetCandidate {
	id: string;
	pinned: number;
	version: number;
	score: number;
}

export interface ForgetCandidatesRequest {
	query: string;
	type: string;
	tags: string;
	who: string;
	sourceType: string;
	since: string;
	until: string;
	scope: string | null;
	limit: number;
}

export function buildForgetCandidatesWhere(
	req: ForgetCandidatesRequest,
	alias: string,
): { clause: string; args: unknown[] } {
	const parts: string[] = [];
	const args: unknown[] = [];
	const prefix = alias.length > 0 ? `${alias}.` : "";

	if (req.type) {
		parts.push(`${prefix}type = ?`);
		args.push(req.type);
	}
	if (req.tags) {
		const tags = req.tags
			.split(",")
			.map((tag) => tag.trim())
			.filter((tag) => tag.length > 0);
		for (const tag of tags) {
			parts.push(`${prefix}tags LIKE ?`);
			args.push(`%${tag}%`);
		}
	}
	if (req.who) {
		parts.push(`${prefix}who = ?`);
		args.push(req.who);
	}
	if (req.sourceType) {
		parts.push(`${prefix}source_type = ?`);
		args.push(req.sourceType);
	}
	if (req.scope !== null) {
		parts.push(`${prefix}scope = ?`);
		args.push(req.scope);
	} else {
		parts.push(`${prefix}scope IS NULL`);
	}
	if (req.since) {
		parts.push(`${prefix}created_at >= ?`);
		args.push(req.since);
	}
	if (req.until) {
		parts.push(`${prefix}created_at <= ?`);
		args.push(req.until);
	}

	const clause = parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "";
	return { clause, args };
}
