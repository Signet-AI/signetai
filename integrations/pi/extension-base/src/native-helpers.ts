import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BaseSessionEntry } from "./types.js";

export interface RecallPayload {
	readonly query?: string;
	readonly method?: string;
	readonly results?: ReadonlyArray<Record<string, unknown>>;
	readonly memories?: ReadonlyArray<Record<string, unknown>>;
	readonly rows: ReadonlyArray<Record<string, unknown>>;
	readonly meta?: Record<string, unknown>;
	readonly aggregate?: { readonly partial?: boolean; readonly message?: string };
	readonly message?: string;
	readonly [key: string]: unknown;
}
export function buildRecallRequestBody(query: string, options: Record<string, unknown> = {}): Record<string, unknown> {
	const out: Record<string, unknown> = { query, limit: 10 };
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined && value !== false) out[key] = value;
	}
	return out;
}
export function buildRememberRequestBody(
	content: string,
	options: Record<string, unknown> = {},
): Record<string, unknown> {
	const normalized = Object.fromEntries(
		Object.entries(options)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [key, key === "tags" && Array.isArray(value) ? value.join(",") : value]),
	);
	return { content, ...normalized };
}
export function parseRecallPayload(raw: unknown): RecallPayload {
	const payload = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const results = Array.isArray(payload.results)
		? payload.results.filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
		: Array.isArray(payload.memories)
			? payload.memories.filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
			: [];
	return {
		...payload,
		results,
		rows: results,
		meta:
			payload.meta && typeof payload.meta === "object"
				? (payload.meta as Record<string, unknown>)
				: { totalReturned: results.length, noHits: results.length === 0 },
	};
}
export function formatRecallText(raw: unknown): string {
	if (!raw || typeof raw !== "object") return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
	const parsed = parseRecallPayload(raw);
	if (parsed.message && (!parsed.results || parsed.results.length === 0)) return parsed.message;
	const rows = parsed.results ?? [];
	if (!rows.length) return "No matching memories found.";
	return [
		`Found ${rows.length} ${rows.length === 1 ? "memory" : "memories"}.`,
		"",
		...rows.map(
			(row) => `- ${String(row.content ?? "")} (${String(row.type ?? "memory")}, ${String(row.source ?? "unknown")})`,
		),
	].join("\n");
}

const fences = /<\\?\/?(?:signet-memory(?:-context)?|memory-context)[^>]*>/gi;
export function stripInternalMemoryContext(text: string): string {
	let result = text;
	for (let i = 0; i < 8; i++) {
		const next = result.replace(
			/<\\?\/?(?:signet-memory(?:-context)?|memory-context)[^>]*>[\s\S]*?<\\?\/?(?:signet-memory(?:-context)?|memory-context)[^>]*>/gi,
			"",
		);
		if (next === result) break;
		result = next;
	}
	return result.replace(fences, "");
}
export function escapeMemoryContextForFence(text: string): string {
	return text.replace(fences, (match) => `&lt;${match.slice(1)}`);
}

export function readStaticIdentity(
	agentsDir: string,
	status = "[signet: daemon offline — running with static identity]",
): string | null {
	if (!existsSync(agentsDir)) return null;
	const files = [
		["AGENTS.md", "Agent Instructions", 12000],
		["SOUL.md", "Soul", 4000],
		["IDENTITY.md", "Identity", 2000],
		["USER.md", "About Your User", 6000],
		["MEMORY.md", "Working Memory", 10000],
	] as const;
	const parts: string[] = [];
	for (const [file, header, budget] of files) {
		const path = join(agentsDir, file);
		if (!existsSync(path)) continue;
		try {
			const raw = readFileSync(path, "utf8").trim();
			if (raw) parts.push(`## ${header}\n\n${raw.length <= budget ? raw : `${raw.slice(0, budget)}\n[truncated]`}`);
		} catch {}
	}
	return parts.length ? `${status}\n\n${parts.join("\n\n")}` : null;
}

export function transcriptText(value: unknown): string | undefined {
	if (typeof value === "string") {
		const text = stripInternalMemoryContext(value)
			.replace(/\s*\r?\n\s*/g, " ")
			.trim();
		return text || undefined;
	}
	return undefined;
}
export function transcriptLine(entry: BaseSessionEntry): string | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const message = (entry as Record<string, unknown>).message;
	if (!message || typeof message !== "object") return undefined;
	const role = String((message as Record<string, unknown>).role ?? "").toLowerCase();
	const label = ["user", "human", "client"].includes(role)
		? "User"
		: ["assistant", "agent", "model", "ai"].includes(role)
			? "Assistant"
			: ["system", "developer"].includes(role)
				? "System"
				: undefined;
	const text = transcriptText((message as Record<string, unknown>).content);
	return label && text ? `${label}: ${text}` : undefined;
}
