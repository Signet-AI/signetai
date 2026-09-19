import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RecallRow {
	readonly id?: string;
	readonly content?: string;
	readonly created_at?: string;
	readonly score?: number;
	readonly source?: string;
	readonly who?: string;
	readonly type?: string;
	readonly supplementary?: boolean;
	readonly temporal_facet?: string;
}
export interface RecallPayload {
	readonly query?: string;
	readonly method?: string;
	readonly results?: readonly RecallRow[];
	readonly memories?: readonly RecallRow[];
	readonly meta?: {
		readonly totalReturned?: number;
		readonly hasSupplementary?: boolean;
		readonly noHits?: boolean;
		readonly temporal?: { readonly mode?: string; readonly start?: string };
	};
	readonly aggregate?: { readonly partial?: boolean; readonly message?: string };
	readonly message?: string;
}
const defined = (v: Record<string, unknown>) =>
	Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined));
export function resolveSessionStartTimeoutMs(raw?: string): number {
	const ms = raw ? Number.parseInt(raw, 10) : NaN;
	return !Number.isFinite(ms) || ms < 1000 ? 15000 : Math.min(ms, 120000);
}
export const SESSION_START_TIMEOUT_STATUS = "[signet: daemon session-start timed out — running with static identity]";
export function buildRecallRequestBody(
	query: string,
	options: {
		limit?: number;
		type?: string;
		aggregate?: boolean;
		aggregateBudget?: string;
		saveAggregate?: boolean;
		sessionKey?: string;
		agentId?: string;
		includeRecalled?: boolean;
		minScore?: number;
		recallSurface?: string;
	},
): Record<string, unknown> {
	const limit =
		typeof options.limit === "number" && Number.isFinite(options.limit)
			? Math.min(100, Math.max(1, Math.trunc(options.limit)))
			: 10;
	return defined({
		query,
		limit,
		type: options.type,
		aggregate: options.aggregate === true ? true : undefined,
		aggregateBudget: options.aggregateBudget,
		saveAggregate: options.saveAggregate,
		sessionKey: options.sessionKey,
		agentId: options.agentId,
		includeRecalled: options.includeRecalled === true ? true : undefined,
		minScore: typeof options.minScore === "number" && Number.isFinite(options.minScore) ? options.minScore : undefined,
		recallSurface: options.recallSurface ?? "tool_call",
	});
}
export function buildRememberRequestBody(
	content: string,
	options: {
		type?: string;
		importance?: number;
		tags?: string | readonly string[];
		who?: string;
		reviewAfter?: string;
	},
): Record<string, unknown> {
	const tags = Array.isArray(options.tags)
		? options.tags
				.map((tag) => tag.trim())
				.filter(Boolean)
				.join(",")
		: typeof options.tags === "string"
			? options.tags
					.split(",")
					.map((tag) => tag.trim())
					.filter(Boolean)
					.join(",")
			: undefined;
	return defined({
		content,
		type: options.type,
		importance: options.importance,
		tags: tags || undefined,
		who: options.who,
		reviewAfter: options.reviewAfter,
	});
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseRecallPayload(raw: unknown): {
	rows: RecallRow[];
	meta: Record<string, unknown> & { totalReturned: number; hasSupplementary: boolean; noHits: boolean };
	query?: string;
	method?: string;
	message?: string;
} {
	const p = record(raw) ? raw : {};
	const rows = (Array.isArray(p.results) ? p.results : Array.isArray(p.memories) ? p.memories : []).filter(
		record,
	) as RecallRow[];
	const sourceMeta = record(p.meta) ? p.meta : {};
	const totalReturned = typeof sourceMeta.totalReturned === "number" ? sourceMeta.totalReturned : rows.length;
	return {
		rows,
		meta: {
			...sourceMeta,
			totalReturned,
			hasSupplementary: sourceMeta.hasSupplementary === true,
			noHits: sourceMeta.noHits === true || totalReturned === 0,
		},
		query: typeof p.query === "string" ? p.query : undefined,
		method: typeof p.method === "string" ? p.method : undefined,
		message: typeof p.message === "string" ? p.message : undefined,
	};
}
export function applyRecallScoreThreshold(raw: unknown, minScore?: number): unknown {
	if (typeof minScore !== "number" || !Number.isFinite(minScore) || !record(raw)) return raw;
	const rows = Array.isArray(raw.results)
		? raw.results.filter((row) => !record(row) || typeof row.score !== "number" || row.score >= minScore)
		: [];
	return {
		...raw,
		results: rows,
		meta: {
			...(record(raw.meta) ? raw.meta : {}),
			totalReturned: rows.length,
			hasSupplementary: rows.some((row) => record(row) && row.supplementary === true),
			noHits: rows.length === 0,
		},
	};
}
function rowText(row: RecallRow): string {
	const score = typeof row.score === "number" ? `[${(row.score * 100).toFixed(0)}%] ` : "";
	return `- ${score}${typeof row.id === "string" ? `id: ${row.id}; ` : ""}${row.content ?? ""} (${row.type ?? "memory"}, ${row.source ?? "unknown"}, ${typeof row.created_at === "string" ? row.created_at.slice(0, 10) : "unknown"}${row.who ? `, by ${row.who}` : ""})`;
}
export function formatRecallText(raw: unknown): string {
	if (!record(raw)) return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
	const parsed = parseRecallPayload(raw);
	if (parsed.message && parsed.rows.length === 0) return parsed.message;
	if (parsed.meta.noHits || parsed.rows.length === 0) return "No matching memories found.";
	const primary = parsed.rows.filter((row) => row.supplementary !== true);
	const supporting = parsed.rows.filter((row) => row.supplementary === true);
	const parts = [
		`Found ${parsed.meta.totalReturned} ${parsed.meta.totalReturned === 1 ? "memory" : "memories"}${parsed.method ? ` (${parsed.method})` : ""}.`,
	];
	if (primary.length) parts.push("", "Primary matches:", ...primary.map(rowText));
	if (supporting.length) parts.push("", "Supporting context:", ...supporting.map(rowText));
	return parts.join("\n");
}
function fenceKind(text: string, index: number): "open" | "close" | undefined {
	const m = text.slice(index).match(/^<\s*(\/?)\s*(signet-memory(?:-context)?|memory-context)(?:\s[^>]*|\s*)>/i);
	return m ? (m[1] ? "close" : "open") : undefined;
}
export function stripInternalMemoryContext(text: string): string {
	let out = "",
		pos = 0,
		depth = 0;
	while (pos < text.length) {
		const index = text.indexOf("<", pos);
		if (index < 0) {
			if (!depth) out += text.slice(pos);
			break;
		}
		const kind = fenceKind(text, index);
		if (!kind) {
			if (!depth) out += text.slice(pos, index + 1);
			pos = index + 1;
			continue;
		}
		if (!depth) out += text.slice(pos, index);
		const end = text.indexOf(">", index) + 1;
		if (depth) depth += kind === "open" ? 1 : -1;
		else if (kind === "open") depth = 1;
		pos = end;
	}
	return out;
}
export function wrapMemoryContext(context: string, source = "api-context"): string {
	const clean = context.trim();
	if (!clean) return "";
	const safe = source.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40) || "api-context";
	return `<signet-memory source="${safe}">\n${clean.replace(/<\/?(?:signet-memory(?:-context)?|memory-context)\b/gi, "&lt;$&")}\n</signet-memory>`;
}
export function readStaticIdentity(
	dir: string,
	status = "[signet: daemon offline — running with static identity]",
): string | null {
	const files = [
		["AGENTS.md", 12000],
		["SOUL.md", 4000],
		["IDENTITY.md", 2000],
		["USER.md", 6000],
		["MEMORY.md", 10000],
	] as const;
	const labels: Record<string, string> = {
		"AGENTS.md": "Agent Instructions",
		"SOUL.md": "Soul",
		"IDENTITY.md": "Identity",
		"USER.md": "About Your User",
		"MEMORY.md": "Working Memory",
	};
	const parts: string[] = [];
	try {
		for (const [name, budget] of files) {
			const path = join(dir, name);
			if (!existsSync(path)) continue;
			const content = readFileSync(path, "utf8").trim();
			if (content)
				parts.push(
					`## ${labels[name]}\n\n${content.length <= budget ? content : `${content.slice(0, budget)}\n[truncated]`}`,
				);
		}
	} catch {
		return null;
	}
	return parts.length ? `${status}\n\n${parts.join("\n\n")}` : null;
}
