export type ExportTranscriptRole = "user" | "assistant" | "system" | "tool" | "unknown";

export interface ExportTranscriptMessage {
	readonly role: ExportTranscriptRole;
	readonly content: string;
}

export interface ExportTranscriptRecord {
	readonly id: string;
	readonly source: "signet";
	readonly harness: string;
	readonly agent_id: string;
	readonly session_key: string;
	readonly project: string | null;
	readonly timestamp: string;
	readonly message_count: number;
	readonly messages: ExportTranscriptMessage[];
}

interface TranscriptRow {
	readonly session_key: string;
	readonly content: string;
	readonly harness: string | null;
	readonly project: string | null;
	readonly agent_id: string;
	readonly created_at: string;
}

const ROLE_PREFIX = /^(user|assistant|system|tool(?:_result)?|human):\s?(.*)$/i;

function normalizeRole(role: string): ExportTranscriptRole {
	switch (role.toLowerCase()) {
		case "user":
		case "human":
			return "user";
		case "assistant":
			return "assistant";
		case "system":
			return "system";
		case "tool":
		case "tool_result":
			return "tool";
		default:
			return "unknown";
	}
}

/**
 * Parse stored transcript content into role-labeled messages.
 *
 * Mirrors the training-data aggregator's strategy so `signet export
 * transcripts` output is a drop-in replacement for its brittle SQLite reader:
 * try JSONL lines first ({role, content} per line), fall back to role-prefixed
 * text (user/assistant/system/tool) with multi-line accumulation.
 */
export function parseTranscriptMessages(content: string): ExportTranscriptMessage[] {
	try {
		const value: unknown = JSON.parse(content);
		if (
			Array.isArray(value) &&
			value.every(
				(m) => m !== null && typeof m === "object" && typeof m.role === "string" && typeof m.content === "string",
			)
		)
			return value.map((m) => ({ role: normalizeRole(m.role), content: m.content }));
	} catch {
		/* Legacy live transcripts use JSONL or role-prefixed text. */
	}

	const jsonl = parseJsonlMessages(content);
	if (jsonl.length >= 2) return jsonl;
	const prefixed = parsePrefixedMessages(content);
	return prefixed.length ? prefixed : jsonl;
}

function parseJsonlMessages(content: string): ExportTranscriptMessage[] {
	const messages: ExportTranscriptMessage[] = [];
	// Match the aggregator's splitlines(): split on \r and \n alike so lines
	// containing literal carriage returns cannot smuggle a role prefix into a
	// continuation line.
	for (const line of content.split(/\r\n|\r|\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const entry = JSON.parse(trimmed) as { role?: unknown; content?: unknown };
			if (typeof entry.role === "string" && typeof entry.content === "string" && entry.content.length > 0) {
				messages.push({ role: normalizeRole(entry.role), content: entry.content });
			}
		} catch {
			// Not a JSONL line; the prefix parser handles mixed text.
		}
	}
	return messages;
}

function parsePrefixedMessages(content: string): ExportTranscriptMessage[] {
	const messages: ExportTranscriptMessage[] = [];
	let currentRole: ExportTranscriptRole | null = null;
	let currentLines: string[] = [];

	const flush = (): void => {
		if (currentRole !== null) {
			const text = currentLines.join("\n").trim();
			if (text.length > 0) {
				messages.push({ role: currentRole, content: text });
			}
		}
		currentRole = null;
		currentLines = [];
	};

	for (const rawLine of content.split(/\r\n|\r|\n/)) {
		const line = rawLine.trim();
		const match = ROLE_PREFIX.exec(line);
		if (match) {
			flush();
			currentRole = normalizeRole(match[1] ?? "");
			const rest = match[2] ?? "";
			currentLines = rest.length > 0 ? [rest] : [];
		} else if (currentRole !== null) {
			currentLines.push(line);
		}
	}
	flush();

	return messages;
}

export function buildExportTranscriptRecord(row: TranscriptRow): ExportTranscriptRecord {
	const messages = parseTranscriptMessages(row.content);
	return {
		id: `signet-db-${row.session_key}`,
		source: "signet",
		harness: row.harness ?? "signet",
		agent_id: row.agent_id,
		session_key: row.session_key,
		project: row.project ?? null,
		timestamp: row.created_at,
		message_count: messages.length,
		messages,
	};
}
