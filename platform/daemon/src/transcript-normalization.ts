export interface EmptyJsonConversationWarning {
	readonly harness: string;
	readonly rawChars: number;
}

export type EmptyJsonConversationReporter = (warning: EmptyJsonConversationWarning) => void;

export function normalizeSessionTranscript(
	harness: string,
	raw: string,
	onEmptyJsonConversation?: EmptyJsonConversationReporter,
): string {
	if (harness.trim().toLowerCase() === "codex") {
		return normalizeCodexTranscript(raw);
	}

	const result = normalizeJsonConversationTranscript(raw);
	// null = not a JSON-line transcript, safe to return raw.
	if (result === null) return raw;
	// Empty string from a non-trivial transcript means all lines were
	// non-conversational — notify caller so operators can add support for this schema.
	if (result === "" && raw.length > 500) {
		onEmptyJsonConversation?.({ harness, rawChars: raw.length });
	}
	return result;
}

// Returns null when input is not JSON-line format (below 60% threshold).
// Returns string (possibly empty) when input IS JSON-line — empty means
// all lines were non-conversational (tool calls, metadata, etc.).
export function normalizeJsonConversationTranscript(raw: string): string | null {
	const rawLines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (rawLines.length === 0) return "";

	const parsedLines: Array<Record<string, unknown> | null> = [];
	let parsedCount = 0;
	for (const line of rawLines) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed)) {
				parsedLines.push(parsed);
				parsedCount++;
				continue;
			}
		} catch {
			// Ignore parse errors; we only treat this as JSON if most lines parse.
		}
		parsedLines.push(null);
	}

	// Not a JSON-line transcript — caller should fall back to raw.
	if (parsedCount < Math.ceil(rawLines.length * 0.6)) {
		return null;
	}

	const conversationLines: string[] = [];
	for (const record of parsedLines) {
		if (!record) continue;
		const normalized = normalizeJsonConversationRecord(record);
		if (normalized) {
			conversationLines.push(normalized);
		}
	}

	return conversationLines.join("\n");
}

function normalizeJsonConversationRecord(record: Record<string, unknown>): string {
	if (record.type === "item.completed") {
		if (isRecord(record.item) && record.item.type === "agent_message") {
			const itemRecord = record.item;
			const text = extractString(itemRecord, ["text", "message", "content"]);
			if (text) return `Assistant: ${text}`;
		}
	}

	if (record.type === "event_msg") {
		if (isRecord(record.payload) && record.payload.type === "user_message") {
			const payloadRecord = record.payload;
			const text = extractString(payloadRecord, ["message", "text", "content"]);
			if (text) return `User: ${text}`;
		}
	}

	if (isRecord(record.message)) {
		const msg = record.message;
		const role = extractString(msg, ["role", "speaker"]);
		const text = extractMessageText(msg);
		if (role && text) {
			const lower = role.toLowerCase();
			if (lower === "user") return `User: ${text}`;
			if (lower === "assistant") return `Assistant: ${text}`;
		}
	}

	const role = extractString(record, ["role", "speaker"]);
	if (role) {
		const lowerRole = role.toLowerCase();
		const text = extractMessageText(record);
		if (lowerRole === "user" && text) return `User: ${text}`;
		if (lowerRole === "assistant" && text) return `Assistant: ${text}`;
	}

	return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractString(record: Record<string, unknown>, keys: readonly string[]): string {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") {
			const trimmed = value.trim().replace(/[\r\n]+/g, " ");
			if (trimmed.length > 0) return trimmed;
		}
	}
	return "";
}

function extractMessageText(record: Record<string, unknown>): string {
	const direct = extractString(record, ["content", "text", "message"]);
	if (direct) return direct;

	const content = record.content;
	if (!Array.isArray(content)) return "";

	const parts = content.flatMap((item) => {
		if (!isRecord(item) || item.type !== "text") return [];
		const text = extractString(item, ["text", "content"]);
		return text ? [text] : [];
	});

	return parts.join(" ");
}

export function normalizeCodexTranscript(raw: string): string {
	const lines: string[] = [];

	for (const row of raw.split(/\r?\n/)) {
		const trimmed = row.trim();
		if (!trimmed) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (typeof parsed !== "object" || parsed === null) continue;
		const event = parsed as Record<string, unknown>;

		if (event.type === "session_meta") {
			// Non-conversational metadata — omit to avoid leaking local
			// paths (cwd) into downstream summaries.
			continue;
		}

		if (event.type === "event_msg") {
			const payload = event.payload;
			if (typeof payload === "object" && payload !== null) {
				const msg = payload as Record<string, unknown>;
				// Only capture user messages here; assistant turns come from
				// item.completed which is authoritative and avoids duplicating
				// content that Codex emits in both streaming and completion events.
				if (msg.type === "user_message" && typeof msg.message === "string") {
					lines.push(`User: ${msg.message.trim().replace(/[\r\n]+/g, " ")}`);
				}
			}
			continue;
		}

		if (event.type === "item.completed") {
			const item = event.item;
			if (typeof item === "object" && item !== null) {
				const record = item as Record<string, unknown>;
				if (record.type === "agent_message" && typeof record.text === "string") {
					lines.push(`Assistant: ${record.text.trim().replace(/[\r\n]+/g, " ")}`);
				}
			}
		}

		// response_item events (tool calls/outputs) are intentionally omitted.
	}

	return lines.join("\n");
}
