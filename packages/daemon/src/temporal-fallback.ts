import { extractAnchorTerms } from "./anchor-terms";
import { getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { deriveThreadKey, deriveThreadLabel } from "./thread-heads";

interface TemporalRow {
	readonly id: string;
	readonly content: string;
	readonly latest_at: string;
	readonly project: string | null;
	readonly session_key: string | null;
	readonly source_ref: string | null;
	readonly harness: string | null;
	readonly thread_key?: string | null;
	readonly thread_label?: string | null;
	readonly rank?: number | null;
}

export interface TemporalHit {
	readonly id: string;
	readonly latestAt: string;
	readonly project: string | null;
	readonly sessionKey: string | null;
	readonly threadKey: string;
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
	} catch (err) {
		logger.warn("temporal-fallback", "tableExists failed", {
			table: name,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

function clean(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function escapeLike(text: string): string {
	return text.replace(/([\\%_])/g, "\\$1");
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

function rankThreshold(termCount: number, anchorCount: number): number {
	if (anchorCount > 0) return 1;
	return Math.max(1, Math.min(2, termCount));
}

function toHits(
	rows: ReadonlyArray<TemporalRow>,
	query: string,
	project: string | undefined,
	termCount: number,
	anchorCount: number,
	limit: number,
): TemporalHit[] {
	const sameProject = (value: string | null): number => (project && value && project === value ? 0 : 1);
	const baseMin = rankThreshold(termCount, anchorCount);
	const crossMin = termCount === 1 ? 2 : Math.min(termCount, Math.max(2, baseMin + 1));
	const scoped = rows
		.map((row) => ({
			id: row.id,
			latestAt: row.latest_at,
			project: row.project,
			sessionKey: row.session_key,
			threadKey:
				row.thread_key && row.thread_key.trim().length > 0
					? row.thread_key.trim()
					: deriveThreadKey({
							project: row.project,
							sourceRef: row.source_ref ?? null,
							sessionKey: row.session_key ?? null,
							harness: row.harness ?? null,
						}),
			threadLabel:
				row.thread_label && row.thread_label.trim().length > 0
					? row.thread_label.trim()
					: deriveThreadLabel({
							project: row.project,
							sourceRef: row.source_ref ?? null,
							sessionKey: row.session_key ?? null,
							harness: row.harness ?? null,
						}),
			excerpt: buildExcerpt(row.content, query),
			rank: typeof row.rank === "number" ? row.rank : 0,
		}))
		.filter((row) => row.excerpt.length > 0)
		.filter((row) => row.rank >= baseMin)
		.filter((row) => {
			if (!project) return true;
			if (row.project && row.project === project) return true;
			return row.rank >= crossMin;
		})
		.sort(
			(a, b) =>
				sameProject(a.project) - sameProject(b.project) || b.rank - a.rank || b.latestAt.localeCompare(a.latestAt),
		);

	const deduped: TemporalHit[] = [];
	const seen = new Set<string>();
	for (const row of scoped) {
		if (seen.has(row.threadKey)) continue;
		seen.add(row.threadKey);
		deduped.push(row);
		if (deduped.length >= limit) break;
	}
	return deduped;
}

function searchFromThreadHeads(params: {
	readonly query: string;
	readonly agentId: string;
	readonly sessionKey?: string;
	readonly termPatterns: ReadonlyArray<string>;
	readonly termCount: number;
	readonly anchorCount: number;
	readonly project?: string;
	readonly limit: number;
}): TemporalHit[] {
	if (!tableExists("memory_thread_heads")) return [];
	try {
		const rows = getDbAccessor().withReadDb((db) => {
			const score = params.termPatterns
				.map(() => "CASE WHEN LOWER(sample) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END")
				.join(" + ");
			const any = params.termPatterns.map(() => "LOWER(sample) LIKE ? ESCAPE '\\'").join(" OR ");
			const parts = [
				`SELECT node_id AS id, sample AS content, latest_at, project, session_key, source_ref, harness, thread_key, label AS thread_label, ${score} AS rank`,
				"FROM memory_thread_heads",
				"WHERE agent_id = ?",
			];
			const args: unknown[] = [];
			for (const pattern of params.termPatterns) {
				args.push(pattern);
			}
			args.push(params.agentId);
			parts.push(`AND (${any})`);
			for (const pattern of params.termPatterns) {
				args.push(pattern);
			}
			parts.push("ORDER BY rank DESC, latest_at DESC LIMIT ?");
			args.push(params.limit * 4);
			return db.prepare(parts.join("\n")).all(...args) as TemporalRow[];
		});

		return toHits(rows, params.query, params.project, params.termCount, params.anchorCount, params.limit);
	} catch (err) {
		logger.warn("temporal-fallback", "thread-head fallback search failed", {
			agentId: params.agentId,
			sessionKey: params.sessionKey,
			project: params.project,
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}
}

function searchFromSessionSummaries(params: {
	readonly query: string;
	readonly agentId: string;
	readonly sessionKey?: string;
	readonly termPatterns: ReadonlyArray<string>;
	readonly termCount: number;
	readonly anchorCount: number;
	readonly project?: string;
	readonly limit: number;
}): TemporalHit[] {
	if (!tableExists("session_summaries")) return [];
	try {
		const rows = getDbAccessor().withReadDb((db) => {
			const score = params.termPatterns
				.map(() => "CASE WHEN LOWER(content) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END")
				.join(" + ");
			const any = params.termPatterns.map(() => "LOWER(content) LIKE ? ESCAPE '\\'").join(" OR ");
			const parts = [
				`SELECT id, content, latest_at, project, session_key, source_ref, harness, ${score} AS rank`,
				"FROM session_summaries",
				"WHERE agent_id = ?",
				"AND COALESCE(source_type, kind) != 'chunk'",
			];
			const args: unknown[] = [];
			for (const pattern of params.termPatterns) {
				args.push(pattern);
			}
			args.push(params.agentId);
			parts.push(`AND (${any})`);
			for (const pattern of params.termPatterns) {
				args.push(pattern);
			}
			parts.push("ORDER BY rank DESC, latest_at DESC LIMIT ?");
			args.push(params.limit * 4);
			return db.prepare(parts.join("\n")).all(...args) as TemporalRow[];
		});

		return toHits(rows, params.query, params.project, params.termCount, params.anchorCount, params.limit);
	} catch (err) {
		logger.warn("temporal-fallback", "session-summary fallback search failed", {
			agentId: params.agentId,
			sessionKey: params.sessionKey,
			project: params.project,
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}
}

export function searchTemporalFallback(params: {
	readonly query: string;
	readonly agentId: string;
	readonly sessionKey?: string;
	readonly project?: string;
	readonly limit: number;
}): TemporalHit[] {
	const limit = Math.max(1, Math.min(8, Math.trunc(params.limit)));
	const words = params.query
		.toLowerCase()
		.split(/\W+/)
		.filter((term) => term.length >= 3)
		.slice(0, 6);
	const anchors = extractAnchorTerms(params.query).slice(0, 6);
	const terms = anchors.length > 0 ? anchors : words;
	if (terms.length === 0) return [];
	const termPatterns = terms.map((term) => `%${escapeLike(term)}%`);

	const fromHeads = searchFromThreadHeads({
		query: params.query,
		agentId: params.agentId,
		sessionKey: params.sessionKey,
		termPatterns,
		termCount: terms.length,
		anchorCount: anchors.length,
		project: params.project,
		limit,
	});
	if (fromHeads.length > 0) return fromHeads;

	return searchFromSessionSummaries({
		query: params.query,
		agentId: params.agentId,
		sessionKey: params.sessionKey,
		termPatterns,
		termCount: terms.length,
		anchorCount: anchors.length,
		project: params.project,
		limit,
	});
}
