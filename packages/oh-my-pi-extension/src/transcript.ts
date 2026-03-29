import { existsSync, readFileSync } from "node:fs";
import { isRecord, readTrimmedString } from "./helpers.js";
import {
	HIDDEN_RECALL_CUSTOM_TYPE,
	HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE,
	type OmpSessionEntry,
	type OmpSessionHeader,
} from "./types.js";

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

function entryToTranscriptLine(entry: OmpSessionEntry): string | undefined {
	if (!isRecord(entry) || typeof entry.type !== "string") return undefined;

	if (entry.type === "custom_message") {
		if (entry.customType === HIDDEN_RECALL_CUSTOM_TYPE || entry.customType === HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE) {
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

export function buildTranscriptFromEntries(entries: ReadonlyArray<OmpSessionEntry>): string | undefined {
	const lines: string[] = [];

	for (const entry of entries) {
		const line = entryToTranscriptLine(entry);
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
	readonly header: OmpSessionHeader | undefined;
	readonly entries: OmpSessionEntry[];
} {
	let header: OmpSessionHeader | undefined;
	const entries: OmpSessionEntry[] = [];

	for (const line of lines) {
		const row = parseJsonLine(line);
		if (!isRecord(row) || typeof row.type !== "string") continue;
		if (row.type === "session") {
			header = row as OmpSessionHeader;
			continue;
		}
		entries.push(row as OmpSessionEntry);
	}

	return { header, entries };
}

function readSessionLines(sessionFile: string): string[] {
	return readFileSync(sessionFile, "utf-8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function sessionProject(header: OmpSessionHeader | undefined): string | undefined {
	return readTrimmedString(header?.cwd) ?? readTrimmedString(header?.project) ?? readTrimmedString(header?.workspace);
}

export function readSessionFileSnapshot(sessionFile: string | undefined): SessionFileSnapshot {
	if (!sessionFile || !existsSync(sessionFile)) {
		return { loaded: false, sessionId: undefined, project: undefined, transcript: undefined };
	}

	try {
		const { header, entries } = classifySessionRows(readSessionLines(sessionFile));
		return {
			loaded: true,
			sessionId: readTrimmedString(header?.id),
			project: sessionProject(header),
			transcript: buildTranscriptFromEntries(entries),
		};
	} catch {
		return { loaded: false, sessionId: undefined, project: undefined, transcript: undefined };
	}
}
