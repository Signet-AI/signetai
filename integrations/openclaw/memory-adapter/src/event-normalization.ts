import { existsSync, readFileSync } from "node:fs";
import { stripInternalMemoryContext } from "@signet/core";

const METADATA_LINE_PREFIXES = [
	"<<<EXTERNAL_UNTRUSTED_CONTENT",
	">>>",
	"Conversation info",
	"Sender (untrusted",
	"Untrusted context",
	"END_EXTERNAL_UNTRUSTED_CONTENT",
] as const;
const ASSISTANT_MESSAGE_ROLES = ["assistant", "agent", "model"] as const;
const USER_MESSAGE_ROLES = ["user", "human"] as const;

function stripSignetMemory(content: string): string {
	return stripInternalMemoryContext(content).trim();
}

function looksLikeMetadataJson(content: string): boolean {
	if (!content.includes("```json")) return false;
	const metadataFields = ["label", "username", "tag", "sender", "conversation"];
	return metadataFields.filter((field) => content.includes(`"${field}"`) || content.includes(`'${field}'`)).length >= 2;
}

export function extractUserMessage(rawPrompt: string): string {
	const sanitized = stripSignetMemory(rawPrompt);
	const lines = sanitized.split("\n");
	let lastContentStart = 0;
	let inCodeFence = false;
	let codeFenceStart = 0;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line.startsWith("```")) {
			if (!inCodeFence) {
				inCodeFence = true;
				codeFenceStart = index;
			} else {
				if (looksLikeMetadataJson(lines.slice(codeFenceStart, index + 1).join("\n"))) {
					lastContentStart = index + 1;
				}
				inCodeFence = false;
			}
			continue;
		}
		if (METADATA_LINE_PREFIXES.some((prefix) => line.startsWith(prefix) || line.includes(prefix))) {
			lastContentStart = index + 1;
		}
	}

	const extracted = lines.slice(lastContentStart).join("\n").trim();
	return extracted.length > 0 ? extracted : sanitized;
}

export function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getMessageText(message: Record<string, unknown>): string | undefined {
	const direct = firstNonEmptyString(message.content, message.text, message.message);
	if (direct) return direct;
	if (!Array.isArray(message.content)) return undefined;

	const textParts: string[] = [];
	for (const chunk of message.content) {
		if (!isRecord(chunk) || chunk.type !== "text") continue;
		if (typeof chunk.text === "string" && chunk.text.trim().length > 0) textParts.push(chunk.text);
	}
	return textParts.length > 0 ? textParts.join("\n") : undefined;
}

function extractLastMessageText(
	messages: unknown,
	roles: readonly string[],
	transform?: (text: string) => string,
): string | undefined {
	if (!Array.isArray(messages)) return undefined;

	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isRecord(message)) continue;
		const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
		const sender = typeof message.sender === "string" ? message.sender.toLowerCase() : "";
		if (!roles.includes(role) && !roles.includes(sender)) continue;

		const text = getMessageText(message);
		if (!text) continue;
		const result = transform ? transform(text) : text;
		if (result.length > 0) return result;
	}
	return undefined;
}

export function extractLastAssistantMessage(event: Record<string, unknown>): string | undefined {
	const explicit = firstNonEmptyString(
		event.lastAssistantMessage,
		event.last_assistant_message,
		event.assistantMessage,
		event.assistant_message,
		event.previousAssistantMessage,
		event.previous_assistant_message,
	);
	return explicit ?? extractLastMessageText(event.messages, ASSISTANT_MESSAGE_ROLES);
}

export function extractLastUserMessage(messages: unknown): string | undefined {
	return extractLastMessageText(messages, USER_MESSAGE_ROLES, stripSignetMemory);
}

export function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function firstNumber(...values: readonly unknown[]): number | undefined {
	return values.find((value): value is number => typeof value === "number");
}

export function buildSessionlessTurnKey(event: Record<string, unknown>, agentId: string | undefined): string {
	const prompt = typeof event.prompt === "string" ? extractUserMessage(event.prompt) : "";
	const normalizedPrompt = prompt.trim().replace(/\s+/g, " ").slice(0, 240);
	const messageCount = Array.isArray(event.messages) ? event.messages.length : -1;
	return `${agentId ?? "-"}|${messageCount}|${normalizedPrompt}`;
}

export function buildScopedSessionKey(sessionKey: string | undefined, agentId: string | undefined): string | undefined {
	return sessionKey ? `${agentId ?? "-"}|${sessionKey}` : undefined;
}

export interface ResolvedCtx {
	readonly sessionKey: string | undefined;
	readonly agentId: string | undefined;
	readonly project: string | undefined;
	readonly sessionFile: string | undefined;
	readonly sessionId: string | undefined;
}

export function resolveCtx(event: Record<string, unknown>, ctx: unknown): ResolvedCtx {
	const context = isRecord(ctx) ? ctx : {};
	return {
		sessionKey:
			readString(context.sessionKey) ??
			readString(event.sessionKey) ??
			readString(context.sessionId) ??
			readString(event.sessionId),
		agentId: readString(context.agentId) ?? readString(event.agentId),
		project: firstNonEmptyString(
			context.workspaceDir,
			context.project,
			context.cwd,
			context.workspace,
			event.cwd,
			event.project,
			event.workspace,
		),
		sessionFile: readString(context.sessionFile) ?? readString(event.sessionFile) ?? readString(event.transcriptPath),
		sessionId: readString(context.sessionId) ?? readString(event.sessionId),
	};
}

export function resolveCompactionSessionFile(
	event: Record<string, unknown>,
	sessionFile: string | undefined,
): string | undefined {
	const compaction = isRecord(event.compaction) ? event.compaction : undefined;
	return firstNonEmptyString(
		event.sessionFile,
		event.session_file,
		compaction?.sessionFile,
		compaction?.session_file,
		sessionFile,
	);
}

export function extractCompactionSummary(event: Record<string, unknown>): string | undefined {
	const compaction = isRecord(event.compaction) ? event.compaction : undefined;
	return readString(event.summary) ?? readString(compaction?.summary);
}

export interface CompactionSessionMetadata {
	readonly project: string | undefined;
	readonly summary: string | undefined;
}

export function readCompactionSessionMetadata(
	sessionFile: string | undefined,
	includeSummary: boolean,
): CompactionSessionMetadata {
	const metadata: { project: string | undefined; summary: string | undefined } = {
		project: undefined,
		summary: undefined,
	};
	if (!sessionFile || !existsSync(sessionFile)) return metadata;

	try {
		const lines = readFileSync(sessionFile, "utf-8").split("\n");
		if (includeSummary) {
			for (let index = lines.length - 1; index >= 0; index--) {
				const line = lines[index]?.trim();
				if (!line) continue;
				try {
					const row: unknown = JSON.parse(line);
					if (!isRecord(row) || row.type !== "compaction") continue;
					metadata.summary = readString(row.summary);
					if (metadata.summary) break;
				} catch {}
			}
			if (!metadata.summary) return metadata;
		}

		for (const rawLine of lines) {
			const line = rawLine.trim();
			if (!line) continue;
			try {
				const row: unknown = JSON.parse(line);
				if (!isRecord(row) || row.type !== "session") continue;
				metadata.project = firstNonEmptyString(row.cwd, row.project, row.workspace);
				break;
			} catch {}
		}
	} catch {}
	return metadata;
}

export function buildCompactionEventKey(
	event: Record<string, unknown>,
	options: { agentId?: string; sessionKey?: string; summary?: string },
): string {
	const compaction = isRecord(event.compaction) ? event.compaction : undefined;
	const messageCount =
		readNumber(event.messageCount) ??
		readNumber(event.compactingCount) ??
		readNumber(event.compactedCount) ??
		readNumber(compaction?.messageCount) ??
		readNumber(compaction?.compactingCount) ??
		readNumber(compaction?.compactedCount) ??
		-1;
	return [
		options.agentId ?? "-",
		options.sessionKey ?? "-",
		readString(event.runId) ?? readString(compaction?.runId) ?? "-",
		readString(event.id) ?? readString(compaction?.id) ?? "-",
		String(messageCount),
		String(readNumber(event.tokenCount) ?? readNumber(compaction?.tokenCount) ?? -1),
		options.summary ?? "-",
	].join("|");
}
