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

type MemoryFence = { readonly start: number; readonly end: number; readonly closing: boolean };

function nextMemoryFence(text: string, from: number, lowerText = text.toLowerCase()): MemoryFence | undefined {
	for (let index = text.indexOf("<", from); index >= 0; index = text.indexOf("<", index + 1)) {
		let cursor = index + 1;
		if (text[cursor] === "\\") cursor++;
		const closing = text[cursor] === "/";
		if (closing) cursor++;

		const names = ["signet-memory-context", "signet-memory", "memory-context"];
		const name = names.find((candidate) => lowerText.startsWith(candidate, cursor));
		if (!name) continue;
		const afterName = cursor + name.length;
		const end = text.indexOf(">", afterName);
		if (end < 0) return undefined;
		return { start: index, end: end + 1, closing };
	}
	return undefined;
}

function memoryFenceRanges(text: string): Array<readonly [number, number]> {
	const ranges: Array<readonly [number, number]> = [];
	let opening: number | undefined;
	const lowerText = text.toLowerCase();
	let cursor = 0;
	while (true) {
		const fence = nextMemoryFence(text, cursor, lowerText);
		if (!fence) break;
		if (opening !== undefined) {
			ranges.push([opening, fence.end]);
			opening = undefined;
		} else {
			opening = fence.start;
		}
		cursor = fence.end;
	}
	return ranges;
}

export function stripInternalMemoryContext(text: string): string {
	let result = text;
	for (let pass = 0; pass < 8; pass++) {
		const ranges = memoryFenceRanges(result);
		if (!ranges.length) break;
		let next = "";
		let cursor = 0;
		for (const [start, end] of ranges) {
			next += result.slice(cursor, start);
			cursor = end;
		}
		next += result.slice(cursor);
		if (next === result) break;
		result = next;
	}
	let scrubbed = "";
	let cursor = 0;
	const lowerResult = result.toLowerCase();
	while (true) {
		const fence = nextMemoryFence(result, cursor, lowerResult);
		if (!fence) return scrubbed + result.slice(cursor);
		scrubbed += result.slice(cursor, fence.start);
		cursor = fence.end;
	}
}
export function escapeMemoryContextForFence(text: string): string {
	let result = "";
	let cursor = 0;
	const lowerText = text.toLowerCase();
	while (true) {
		const fence = nextMemoryFence(text, cursor, lowerText);
		if (!fence) return result + text.slice(cursor);
		result += `${text.slice(cursor, fence.start)}&lt;${text.slice(fence.start + 1, fence.end)}`;
		cursor = fence.end;
	}
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
