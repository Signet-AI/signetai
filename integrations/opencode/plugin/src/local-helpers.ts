import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS =
	"[signet: daemon session-start timed out — running with static identity]";
export function resolveSessionStartTimeoutMs(raw?: string): number {
	const n = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(n) && n >= 1000 ? Math.min(n, 120000) : 15000;
}
export function resolvePromptSubmitTimeoutMs(raw?: string): number {
	const n = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(n) && n >= 1000 ? Math.min(n, 120000) : 5000;
}
export function readStaticIdentity(
	dir: string,
	status = "[signet: daemon offline — running with static identity]",
): string | null {
	if (!existsSync(dir)) return null;
	const files = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md"];
	const parts = files.flatMap((name) => {
		try {
			const text = readFileSync(join(dir, name), "utf8").trim();
			return text ? [text] : [];
		} catch {
			return [];
		}
	});
	return parts.length ? `${status}\n\n${parts.join("\n\n")}` : null;
}
export function composeApiUserContent(user: string, context: string): string {
	return context.trim() ? `${user}\n\n${context}` : user;
}
export function stripInternalMemoryContext(text: string): string {
	const openings = ["<signet-memory>", "<signet-prompt-context>"];
	const closings = ["</signet-memory>", "</signet-prompt-context>"];
	let out = text;
	for (const open of openings) {
		let start = out.indexOf(open);
		while (start >= 0) {
			const close = closings.findIndex((value) => out.indexOf(value, start + open.length) >= 0);
			if (close < 0) {
				out = out.slice(0, start);
				break;
			}
			const closing = closings[close];
			if (!closing) break;
			const end = out.indexOf(closing, start + open.length);
			out = out.slice(0, start) + out.slice(end + closing.length);
			start = out.indexOf(open);
		}
	}
	return out;
}
export function scrubPromptContext(text: string): string {
	return stripInternalMemoryContext(text);
}
export function buildRecallRequestBody(query: string, options: Record<string, unknown> = {}): Record<string, unknown> {
	const out: Record<string, unknown> = {
		query,
		limit: typeof options.limit === "number" ? Math.max(1, Math.min(100, options.limit)) : 10,
	};
	const map: Record<string, string> = {
		aggregate_budget: "aggregateBudget",
		save_aggregate: "saveAggregate",
		session_key: "sessionKey",
		agent_id: "agentId",
		include_recalled: "includeRecalled",
		min_score: "minScore",
	};
	for (const [key, value] of Object.entries(options)) if (value !== undefined) out[map[key] ?? key] = value;
	out.recallSurface = "tool_call";
	return out;
}
export function buildRememberRequestBody(
	content: string,
	options: Record<string, unknown> = {},
): Record<string, unknown> {
	return { content, ...options, reviewAfter: options.review_after ?? options.reviewAfter, who: options.who };
}
export function applyRecallScoreThreshold(raw: unknown, min?: number): unknown {
	if (typeof min !== "number" || !raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const value = raw as Record<string, unknown>;
	const results = Array.isArray(value.results)
		? value.results.filter((row: unknown) => {
				if (!row || typeof row !== "object") return true;
				const score = (row as Record<string, unknown>).score;
				return typeof score !== "number" || score >= min;
			})
		: value.results;
	return { ...value, results };
}
export function formatRecallText(raw: unknown): string {
	if (typeof raw === "string") return raw;
	if (!raw || typeof raw !== "object") return JSON.stringify(raw, null, 2);
	const value = raw as Record<string, unknown>;
	const rows = Array.isArray(value.results) ? value.results : [];
	return rows.length
		? `Found ${rows.length} memories.\\n${rows.map((row) => JSON.stringify(row)).join("\\n")}`
		: "No matching memories found.";
}
