import { basename } from "node:path";
import { extractAnchorTerms } from "./anchor-terms";
import { getDbAccessor } from "./db-accessor";

interface TemporalRow {
	readonly id: string;
	readonly content: string;
	readonly latest_at: string;
	readonly project: string | null;
	readonly session_key: string | null;
	readonly source_ref: string | null;
	readonly harness: string | null;
	readonly rank?: number | null;
}

export interface TemporalHit {
	readonly id: string;
	readonly latestAt: string;
	readonly project: string | null;
	readonly sessionKey: string | null;
	readonly threadLabel: string;
	readonly excerpt: string;
	readonly rank: number;
}

function tableExists(name: string): boolean {
	try {
		return getDbAccessor().withReadDb((db) => {
			const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
			return row !== undefined;
		});
	} catch {
		return false;
	}
}

function clean(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function projectLabel(project: string | null): string | null {
	if (!project) return null;
	const trimmed = project.trim();
	if (trimmed.length === 0) return null;
	return basename(trimmed) || trimmed;
}

function threadLabel(row: TemporalRow): string {
	const project = projectLabel(row.project);
	if (project) return `project:${project}`;
	if (row.source_ref && row.source_ref.trim().length > 0) return `source:${row.source_ref}`;
	if (row.session_key && row.session_key.trim().length > 0) return `session:${row.session_key}`;
	if (row.harness && row.harness.trim().length > 0) return `harness:${row.harness}`;
	return "thread:unscoped";
}

function buildExcerpt(content: string, query: string): string {
	const base = clean(content);
	if (base.length <= 280) return base;
	const terms = query
		.toLowerCase()
		.split(/\W+/)
		.filter((term) => term.length >= 3)
		.slice(0, 8);
	const lower = base.toLowerCase();
	for (const term of terms) {
		const idx = lower.indexOf(term);
		if (idx === -1) continue;
		const start = Math.max(0, idx - 110);
		const end = Math.min(base.length, idx + 170);
		const prefix = start > 0 ? "..." : "";
		const suffix = end < base.length ? "..." : "";
		return `${prefix}${base.slice(start, end).trim()}${suffix}`;
	}
	return `${base.slice(0, 277).trim()}...`;
}

export function searchTemporalFallback(params: {
	readonly query: string;
	readonly agentId: string;
	readonly sessionKey?: string;
	readonly project?: string;
	readonly limit: number;
}): TemporalHit[] {
	const limit = Math.max(1, Math.min(8, Math.trunc(params.limit)));
	if (!tableExists("session_summaries")) return [];

	const words = params.query
		.toLowerCase()
		.split(/\W+/)
		.filter((term) => term.length >= 3)
		.slice(0, 6);
	const anchors = extractAnchorTerms(params.query).slice(0, 6);
	const terms = anchors.length > 0 ? anchors : words;
	if (terms.length === 0) return [];

	try {
		const rows = getDbAccessor().withReadDb((db) => {
			const score = terms.map(() => "CASE WHEN LOWER(content) LIKE ? THEN 1 ELSE 0 END").join(" + ");
			const any = terms.map(() => "LOWER(content) LIKE ?").join(" OR ");
			const parts = [
				`SELECT id, content, latest_at, project, session_key, source_ref, harness, ${score} AS rank`,
				"FROM session_summaries",
				"WHERE agent_id = ?",
				"AND COALESCE(source_type, kind) != 'chunk'",
			];
			const args: unknown[] = [];
			for (const term of terms) {
				args.push(`%${term}%`);
			}
			args.push(params.agentId);
			if (params.sessionKey) {
				parts.push("AND (session_key IS NULL OR session_key != ?)");
				args.push(params.sessionKey);
			}
			parts.push(`AND (${any})`);
			for (const term of terms) {
				args.push(`%${term}%`);
			}
			parts.push("ORDER BY rank DESC, latest_at DESC LIMIT ?");
			args.push(limit * 3);
			return db.prepare(parts.join("\n")).all(...args) as TemporalRow[];
		});

		const sameProject = (project: string | null): number =>
			params.project && project && params.project === project ? 0 : 1;

		return rows
			.map((row) => ({
				id: row.id,
				latestAt: row.latest_at,
				project: row.project,
				sessionKey: row.session_key,
				threadLabel: threadLabel(row),
				excerpt: buildExcerpt(row.content, params.query),
				rank: typeof row.rank === "number" ? row.rank : 0,
			}))
			.filter((row) => row.excerpt.length > 0)
			.sort((a, b) => sameProject(a.project) - sameProject(b.project) || b.rank - a.rank)
			.slice(0, limit);
	} catch {
		return [];
	}
}
