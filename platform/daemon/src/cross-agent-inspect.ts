import { redactCredentials } from "@signet/core";
import { boardAuthorAudience, resolveBoardViewer } from "./board";
import { sanitizeContextText } from "./cross-agent-context";
import { isReasoningRecord, isToolCallRecord, isToolResultRecord } from "./pipeline/dreaming-evidence";
import { dbOwnerQuery, ownerStatement } from "./db-owner-runtime";

export const INSPECT_DEFAULT_MESSAGES = 3;
export const INSPECT_MAX_MESSAGES = 5;
export const INSPECT_TOTAL_CHARS = 4000;
export const INSPECT_MESSAGE_CHARS = 1200;
export const INSPECT_TAIL_BYTES = 32 * 1024;

export interface InspectedMessage {
	readonly role: "user" | "assistant";
	readonly content: string;
}

export interface TranscriptTailResult {
	readonly recentMessages: readonly InspectedMessage[];
	readonly truncated: boolean;
	readonly available: boolean;
	readonly transcriptBytes: number;
	readonly bytesRead: number;
	readonly transcriptUpdatedAt: string | null;
}

interface TailRow {
	readonly total_bytes: number;
	readonly tail: string | null;
	readonly seen_at: string | null;
}

interface RawTurn {
	role: "user" | "assistant" | "other";
	text: string;
}

const TURN_LINE = /^(User|Human|Assistant|System|Developer|Tool|Function)\s*:\s?(.*)$/i;
const HIDDEN_LINE =
	/^(?:(?:assistant|model)\s+)?(?:reasoning|thinking|thought|analysis)\s*:|^(?:tool|function)[_ -]?(?:call|use|output|result|response)\b/i;
const HIDDEN_TAG =
	/<(\/)?(?:antml:)?(think|thinking|reasoning|analysis|redacted_thinking|tool_result|tool_output|function_result|function_output|tool_response|tool_call|tool_use|function_call|invoke)\b[^>]*>/gi;

interface HiddenToken {
	readonly start: number;
	readonly end: number;
	readonly closing: boolean;
	readonly name: string;
}

function hiddenTokens(text: string): HiddenToken[] {
	const tokens: HiddenToken[] = [];
	for (const m of text.matchAll(HIDDEN_TAG)) {
		tokens.push({
			start: m.index ?? 0,
			end: (m.index ?? 0) + m[0].length,
			closing: m[1] === "/",
			name: (m[2] ?? "").toLowerCase(),
		});
	}
	return tokens;
}

function updateHiddenStack(stack: string[], token: HiddenToken): void {
	if (!token.closing) stack.push(token.name);
	else if (stack.at(-1) === token.name) stack.pop();
}

export function stripHiddenBlocks(text: string): string {
	const stack: string[] = [];
	let out = "";
	let pos = 0;
	for (const token of hiddenTokens(text)) {
		if (stack.length === 0) out += text.slice(pos, token.start);
		updateHiddenStack(stack, token);
		pos = token.end;
	}
	return stack.length === 0 ? out + text.slice(pos) : out;
}

function dropOrphanPrefix(text: string): string {
	const open = new Map<string, number>();
	let cut = 0;
	for (const token of hiddenTokens(text)) {
		const count = open.get(token.name) ?? 0;
		if (!token.closing) open.set(token.name, count + 1);
		else if (count > 0) open.set(token.name, count - 1);
		else cut = token.end;
	}
	return text.slice(cut);
}

function recordOf(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function visibleBlocks(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const entry of content) {
		if (typeof entry === "string") {
			parts.push(entry);
			continue;
		}
		const block = recordOf(entry);
		if (!block || isReasoningRecord(block) || isToolResultRecord(block) || isToolCallRecord(block)) continue;
		const type = typeof block.type === "string" ? block.type.toLowerCase() : "text";
		if (type !== "text" && type !== "input_text" && type !== "output_text") continue;
		if (typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

function jsonTurn(value: unknown): RawTurn | null {
	const record = recordOf(value);
	if (!record) return null;
	const nested = recordOf(record.message) ?? recordOf(record.item) ?? recordOf(record.payload);
	const item = nested ?? record;
	for (const candidate of [record, item]) {
		if (isReasoningRecord(candidate) || isToolResultRecord(candidate) || isToolCallRecord(candidate)) return null;
	}
	if (record.type === "event_msg" && item.type === "user_message") {
		const text = typeof item.message === "string" ? item.message : typeof item.text === "string" ? item.text : null;
		return text === null ? null : { role: "user", text };
	}
	if (record.type === "item.completed" && item.type === "agent_message") {
		const text = typeof item.text === "string" ? item.text : null;
		return text === null ? null : { role: "assistant", text };
	}
	const rawRole = typeof item.role === "string" ? item.role : typeof record.role === "string" ? record.role : "";
	const role = rawRole.toLowerCase();
	if (role !== "user" && role !== "assistant") return null;
	const text = visibleBlocks(item.content);
	return text === null ? null : { role, text };
}

function parsePlainSegment(segment: string[], turns: RawTurn[]): void {
	const joined = stripHiddenBlocks(segment.join("\n"));
	let open: RawTurn | null = null;
	for (const line of joined.split("\n")) {
		const trimmed = line.trim();
		if (HIDDEN_LINE.test(trimmed)) {
			open = null;
			continue;
		}
		const match = TURN_LINE.exec(trimmed);
		if (match) {
			const label = (match[1] ?? "").toLowerCase();
			const role = label === "assistant" ? "assistant" : label === "user" || label === "human" ? "user" : "other";
			open = role === "other" ? null : { role, text: match[2] ?? "" };
			if (open) turns.push(open);
			continue;
		}
		if (open) open.text += `\n${line}`;
	}
}

export function parseTurns(tail: string, dropFirstLine: boolean): RawTurn[] {
	let text = tail.replace(/\r\n?/g, "\n");
	if (dropFirstLine) {
		const newline = text.indexOf("\n");
		text = newline < 0 ? "" : dropOrphanPrefix(text.slice(newline + 1));
	}
	const lines = text.split("\n");
	const turns: RawTurn[] = [];
	let segment: string[] = [];
	const hiddenStack: string[] = [];
	const flush = (): void => {
		if (segment.length > 0) parsePlainSegment(segment, turns);
		segment = [];
	};
	for (const line of lines) {
		const trimmed = line.trim();
		if (hiddenStack.length === 0 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
			flush();
			try {
				const turn = jsonTurn(JSON.parse(trimmed));
				if (turn) turns.push({ role: turn.role, text: stripHiddenBlocks(turn.text) });
			} catch {}
			continue;
		}
		segment.push(line);
		for (const token of hiddenTokens(line)) updateHiddenStack(hiddenStack, token);
	}
	flush();
	return turns;
}

export function selectRecentMessages(
	turns: readonly RawTurn[],
	maxMessages: number,
	totalChars: number,
): { readonly messages: InspectedMessage[]; readonly truncated: boolean } {
	const eligible = turns.filter((turn) => turn.role !== "other");
	const picked: InspectedMessage[] = [];
	let budget = totalChars;
	let truncated = false;
	for (let index = eligible.length - 1; index >= 0; index--) {
		const turn = eligible[index];
		if (!turn || (turn.role !== "user" && turn.role !== "assistant")) continue;
		const clean = sanitizeContextText(redactCredentials(turn.text));
		if (clean.length === 0) continue;
		if (picked.length >= maxMessages || budget < 80) {
			truncated = true;
			break;
		}
		const cap = Math.min(INSPECT_MESSAGE_CHARS, budget);
		const content = clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean;
		if (content !== clean) truncated = true;
		budget -= content.length;
		picked.unshift({ role: turn.role, content });
	}
	return { messages: picked, truncated };
}

export async function readTranscriptTail(
	agentId: string,
	sessionKey: string,
	maxMessages: number,
): Promise<TranscriptTailResult> {
	const row = await dbOwnerQuery<TailRow | null>(
		ownerStatement(
			`SELECT length(CAST(content AS BLOB)) AS total_bytes,
			        CAST(substr(CAST(content AS BLOB), ?) AS TEXT) AS tail,
			        COALESCE(updated_at, created_at) AS seen_at
			 FROM session_transcripts
			 WHERE agent_id = ? AND session_key = ?
			 LIMIT 1`,
			[-INSPECT_TAIL_BYTES, agentId, sessionKey],
			"get",
		),
		{ operation: "cross-agent.session-context-tail", lane: "read", deadlineMs: 5_000, estimatedWorkUnits: 2 },
	);
	if (!row?.tail) {
		return {
			recentMessages: [],
			truncated: false,
			available: row !== null && row !== undefined,
			transcriptBytes: row?.total_bytes ?? 0,
			bytesRead: 0,
			transcriptUpdatedAt: row?.seen_at ?? null,
		};
	}
	const cutOff = row.total_bytes > INSPECT_TAIL_BYTES;
	const turns = parseTurns(row.tail, cutOff);
	const selected = selectRecentMessages(turns, maxMessages, INSPECT_TOTAL_CHARS);
	return {
		recentMessages: selected.messages,
		truncated: selected.truncated || cutOff,
		available: true,
		transcriptBytes: row.total_bytes,
		bytesRead: Math.min(row.total_bytes, INSPECT_TAIL_BYTES),
		transcriptUpdatedAt: row.seen_at,
	};
}

export async function resolvePresenceAudience(viewerAgentId: string): Promise<ReadonlySet<string> | null> {
	if (viewerAgentId.trim().length === 0) throw new Error("viewer agent is required");
	return boardAuthorAudience(await resolveBoardViewer(viewerAgentId));
}

export async function canViewSessionOf(viewerAgentId: string, targetAgentId: string): Promise<boolean> {
	if (viewerAgentId === targetAgentId) return true;
	const audience = await resolvePresenceAudience(viewerAgentId);
	return audience === null || audience.has(targetAgentId);
}
