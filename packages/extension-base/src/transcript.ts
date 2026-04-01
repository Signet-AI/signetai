import { existsSync, readFileSync } from "node:fs";
import { isRecord, readTrimmedString } from "./helpers.js";
import type { BaseSessionEntry, BaseSessionHeader } from "./types.js";

export interface SessionFileSnapshot {
	readonly loaded: boolean;
	readonly sessionId: string | undefined;
	readonly project: string | undefined;
	readonly transcript: string | undefined;
}

function normalizeWhitespace(input: string): string {
	return input.replace(/\s*\r?\n\s*/g, " ").trim();
}

function roleLabel(role: string | undefined): string {
	switch (role) {
		case "assistant":
			return "Assistant";
		case "system":
			return "System";
		case "custom":
			return "Custom";
		case "tool":
		case "toolResult":
		case "bashExecution":
		case "pythonExecution":
			return "Tool";
		default:
			return "User";
	}
}

function extractTextContent(value: unknown): string | undefined {
	if (typeof value === "string") {
		const normalized = normalizeWhitespace(value);
		return normalized.length > 0 ? normalized : undefined;
	}

	if (!Array.isArray(value)) return undefined;

	const parts: string[] = [];
	for (const part of value) {
		if (!isRecord(part)) continue;
		const candidate =
			readTrimmedString(part.text) ?? readTrimmedString(part.input_text) ?? readTrimmedString(part.content);
		if (!candidate) continue;
		parts.push(normalizeWhitespace(candidate));
	}

	if (parts.length === 0) return undefined;
	return parts.join(" ");
}

function buildMessageLine(role: string | undefined, content: unknown): string | undefined {
	const text = extractTextContent(content);
	if (!text) return undefined;
	return `${roleLabel(role)}: ${text}`;
}

function entryToTranscriptLine(
	entry: BaseSessionEntry,
	excludeCustomTypes: ReadonlySet<string>,
): string | undefined {
	if (!isRecord(entry) || typeof entry.type !== "string") return undefined;

	if (entry.type === "custom_message") {
		if (typeof entry.customType === "string" && excludeCustomTypes.has(entry.customType)) {
			return undefined;
		}
		return buildMessageLine("custom", entry.content);
	}

	if (entry.type !== "message") return undefined;
	if (!isRecord(entry.message)) return undefined;

	const role = readTrimmedString(entry.message.role);
	const content = Reflect.get(entry.message, "content") ?? Reflect.get(entry.message, "parts");
	return buildMessageLine(role, content);
}

export function buildTranscriptFromEntries(
	entries: ReadonlyArray<BaseSessionEntry>,
	excludeCustomTypes: ReadonlySet<string> = new Set(),
): string | undefined {
	const lines: string[] = [];

	for (const entry of entries) {
		const line = entryToTranscriptLine(entry, excludeCustomTypes);
		if (!line) continue;
		lines.push(line);
	}

	if (lines.length === 0) return undefined;
	return lines.join("\n");
}

function parseJsonLine(line: string): unknown {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return undefined;
	}
}

function classifySessionRows(lines: ReadonlyArray<string>): {
	readonly header: BaseSessionHeader | undefined;
	readonly entries: BaseSessionEntry[];
} {
	let header: BaseSessionHeader | undefined;
	const entries: BaseSessionEntry[] = [];

	for (const line of lines) {
		const row = parseJsonLine(line);
		if (!isRecord(row) || typeof row.type !== "string") continue;
		if (row.type === "session") {
			header = row as BaseSessionHeader;
			continue;
		}
		entries.push(row as BaseSessionEntry);
	}

	return { header, entries };
}

function readSessionLines(sessionFile: string): string[] {
	return readFileSync(sessionFile, "utf-8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function sessionProject(header: BaseSessionHeader | undefined): string | undefined {
	return readTrimmedString(header?.cwd) ?? readTrimmedString(header?.project) ?? readTrimmedString(header?.workspace);
}

export function readSessionFileSnapshot(
	sessionFile: string | undefined,
	excludeCustomTypes: ReadonlySet<string> = new Set(),
): SessionFileSnapshot {
	if (!sessionFile || !existsSync(sessionFile)) {
		return { loaded: false, sessionId: undefined, project: undefined, transcript: undefined };
	}

	try {
		const { header, entries } = classifySessionRows(readSessionLines(sessionFile));
		return {
			loaded: true,
			sessionId: readTrimmedString(header?.id),
			project: sessionProject(header),
			transcript: buildTranscriptFromEntries(entries, excludeCustomTypes),
		};
	} catch {
		return { loaded: false, sessionId: undefined, project: undefined, transcript: undefined };
	}
}
