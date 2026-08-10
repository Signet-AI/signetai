import { MEMORY_CONTENT_WITHHELD_NOTICE, scanMemoryContent } from "@signet/core";
import type { EpisodicSourceRecord } from "../episodic-sources";

/** A rendered immutable source record that a Dreaming agent may cite. */
export interface DreamingAgentEvidence {
	/** Canonical episodic selector (`memory:<id>`, `artifact:<id>`, etc.). */
	readonly sourceRef: string;
	/** Canonical rendered evidence the quote must be an exact substring of. */
	readonly content: string;
	/** Provenance tuple stamped onto derived rows (source entry provenance). */
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
	/** Configured Signet source entry id, when known. */
	readonly sourceEntryId: string | null;
}

/** One exact, resumable slice of immutable episodic evidence. */
export interface DreamingEvidenceFragment {
	readonly source: EpisodicSourceRecord;
	/** The exact text exposed to the agent and accepted for citations. */
	readonly content: string;
	/** Character offsets into renderDreamingEvidence(source). */
	readonly start: number;
	readonly end: number;
	readonly sourceLength: number;
}

/**
 * Return the next safe-boundary fragment without dropping or normalizing a
 * character. The cursor stores absolute offsets, so a later pass can resume
 * even if the configured context budget changes.
 */
export function nextDreamingEvidenceFragment(
	source: EpisodicSourceRecord,
	start: number,
	maxChars: number,
): DreamingEvidenceFragment | null {
	const content = renderDreamingEvidence(source);
	if (!Number.isSafeInteger(start) || start < 0 || start >= content.length || maxChars <= 0) return null;
	const cappedEnd = Math.min(content.length, start + Math.floor(maxChars));
	let end = cappedEnd;
	if (cappedEnd < content.length) {
		for (let index = cappedEnd - 1; index > start; index -= 1) {
			const character = content[index];
			const previous = content[index - 1];
			if (character === undefined || previous === undefined) continue;
			if ((character === "\n" && previous === "\n") || (/\s/.test(character) && /[.!?]/.test(previous))) {
				let boundaryEnd = index + 1;
				while (boundaryEnd < content.length) {
					const next = content[boundaryEnd];
					if (next === undefined || !/\s/.test(next)) break;
					boundaryEnd += 1;
				}
				if (boundaryEnd <= cappedEnd && content.slice(start, boundaryEnd).trim().length > 0) {
					end = boundaryEnd;
					break;
				}
			}
		}
	}
	return { source, content: content.slice(start, end), start, end, sourceLength: content.length };
}

export function completeDreamingEvidenceFragment(source: EpisodicSourceRecord): DreamingEvidenceFragment {
	const content = renderDreamingEvidence(source);
	return { source, content, start: 0, end: content.length, sourceLength: content.length };
}

/**
 * Render structured evidence preserved beside an immutable episodic record.
 * This is the canonical text exposed to Dreaming and accepted for citations.
 */
export function renderDreamingEvidenceMeta(evidenceMeta: string | null): string {
	if (!evidenceMeta) return "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(evidenceMeta);
	} catch {
		return "";
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "";
	const data = parsed as { entities?: unknown[]; aspects?: unknown[] };
	const lines: string[] = [];
	if (Array.isArray(data.entities) && data.entities.length > 0) {
		lines.push("structured_entities:");
		for (const entity of data.entities) {
			if (typeof entity !== "object" || entity === null) continue;
			const value = entity as Record<string, unknown>;
			const source = typeof value.source === "string" ? value.source : "";
			const target = typeof value.target === "string" ? value.target : "";
			const relationship = typeof value.relationship === "string" ? value.relationship : "";
			if (source || target || relationship) {
				lines.push(`- ${source} ${relationship ? `[${relationship}] ` : ""}${target}`.trim());
			}
		}
	}
	if (Array.isArray(data.aspects) && data.aspects.length > 0) {
		lines.push("structured_aspects:");
		for (const aspect of data.aspects) {
			if (typeof aspect !== "object" || aspect === null) continue;
			const value = aspect as Record<string, unknown>;
			const entityName = typeof value.entityName === "string" ? value.entityName : "";
			const aspectName = typeof value.aspect === "string" ? value.aspect : "";
			if (entityName || aspectName) lines.push(`- ${entityName}/${aspectName}`.trim());
		}
	}
	return lines.length > 0 ? `structured_evidence:\n${lines.join("\n")}` : "";
}

function objectValue(value: Record<string, unknown>, key: string): unknown {
	return value[key];
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toolName(value: Record<string, unknown>): string {
	const functionValue = value.function;
	if (typeof functionValue === "object" && functionValue !== null && !Array.isArray(functionValue)) {
		const name = stringValue((functionValue as Record<string, unknown>).name);
		if (name) return name;
	}
	for (const key of ["name", "tool", "tool_name", "toolName", "recipient_name"]) {
		const name = stringValue(objectValue(value, key));
		if (name) return name;
	}
	const item = value.item;
	if (typeof item === "object" && item !== null && !Array.isArray(item))
		return toolName(item as Record<string, unknown>);
	const payload = value.payload;
	if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
		const name = toolName(payload as Record<string, unknown>);
		if (name !== "tool") return name;
	}
	return "tool";
}

function toolMarker(value: Record<string, unknown>): string {
	return `[tool call: ${toolName(value)}]`;
}

const REASONING_TYPES = ["analysis", "thought", "thinking", "reasoning", "redacted_thinking"];
const TOOL_CALL_TYPES = ["tool_use", "tool_call", "function_call", "function_calling"];
const TOOL_RESULT_TYPES = [
	"tool_result",
	"tool_response",
	"function_call_output",
	"function_result",
	"tool_output",
	"tool_return",
];

function recordType(value: Record<string, unknown>): string {
	return (stringValue(value.type) ?? "").toLowerCase();
}

function isReasoningRecord(value: Record<string, unknown>): boolean {
	const type = recordType(value);
	const role = (stringValue(value.role) ?? "").toLowerCase();
	const content = value.content;
	const hasNoContent = content == null || (typeof content === "string" && content.trim().length === 0);
	return (
		REASONING_TYPES.some((candidate) => type === candidate || type.includes(candidate)) ||
		role === "reasoning" ||
		role === "thinking" ||
		(role === "assistant" &&
			hasNoContent &&
			(value.reasoning !== undefined || value.reasoning_content !== undefined || value.thinking !== undefined)) ||
		value.thought === true
	);
}

function isToolCallRecord(value: Record<string, unknown>): boolean {
	return TOOL_CALL_TYPES.some((candidate) => recordType(value).includes(candidate));
}

function isToolResultRecord(value: Record<string, unknown>): boolean {
	const type = recordType(value);
	const role = (stringValue(value.role) ?? "").toLowerCase();
	if (TOOL_RESULT_TYPES.some((candidate) => type.includes(candidate)) || role === "tool" || role === "function")
		return true;
	const payload = value.payload;
	if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
		return isToolResultRecord(payload as Record<string, unknown>);
	}
	return false;
}

function toolCallMarkers(value: Record<string, unknown>): string[] {
	const calls = value.tool_calls ?? value.toolCalls ?? value.calls;
	const records = Array.isArray(calls) ? calls : calls === undefined ? [] : [calls];
	const markers = records.flatMap((call) => {
		if (typeof call !== "object" || call === null || Array.isArray(call)) return [];
		return [toolMarker(call as Record<string, unknown>)];
	});
	const functionCall = value.function_call;
	if (typeof functionCall === "object" && functionCall !== null && !Array.isArray(functionCall)) {
		markers.push(toolMarker(functionCall as Record<string, unknown>));
	}
	return markers;
}

function contentText(value: unknown): string[] {
	if (typeof value === "string") return value.trim().length > 0 ? [value.trim()] : [];
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return contentText([value]);
	if (!Array.isArray(value)) return [];
	const text: string[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			if (item.trim().length > 0) text.push(item.trim());
			continue;
		}
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const block = item as Record<string, unknown>;
		if (isReasoningRecord(block) || isToolResultRecord(block)) continue;
		if (isToolCallRecord(block)) {
			text.push(toolMarker(block));
			continue;
		}
		const blockText = stringValue(block.text) ?? stringValue(block.input_text) ?? stringValue(block.content);
		if (blockText) text.push(blockText);
	}
	return text;
}

function jsonTranscriptLine(value: unknown): string[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	const record = value as Record<string, unknown>;
	const nestedItem = record.item ?? record.message ?? record.payload;
	const item =
		typeof nestedItem === "object" && nestedItem !== null && !Array.isArray(nestedItem)
			? (nestedItem as Record<string, unknown>)
			: record;
	if (isReasoningRecord(item) || isReasoningRecord(record) || isToolResultRecord(item) || isToolResultRecord(record))
		return [];
	if (isToolCallRecord(item) || isToolCallRecord(record)) {
		return [toolMarker(item)];
	}
	const role = (stringValue(item.role) ?? stringValue(record.role) ?? "").toLowerCase();
	const text = contentText(item.content ?? item.text ?? item.message);
	const markers = toolCallMarkers(item);
	if (text.length === 0 && markers.length === 0) return [];
	const label =
		role === "user" ? "User" : role === "assistant" ? "Assistant" : role === "reasoning" ? "Assistant reasoning" : null;
	return [...(label ? text.map((part) => `${label}: ${part}`) : text), ...markers];
}

function sanitizePlainTranscript(content: string): string {
	const withoutToolBlocks = content
		.replace(
			/<(?:antml:)?(?:think|thinking|reasoning|analysis|redacted_thinking)\b[^>]*>[\s\S]*?<\/(?:antml:)?(?:think|thinking|reasoning|analysis|redacted_thinking)>/gi,
			"",
		)
		.replace(
			/<(?:antml:)?(?:tool_result|tool_output|function_result|function_output|tool_response)>[\s\S]*?<\/(?:antml:)?(?:tool_result|tool_output|function_result|function_output|tool_response)>/gi,
			"",
		)
		.replace(
			/<(?:antml:invoke|(?:antml:)?(?:tool_call|tool_use|function_call))(?:\s+([^>]*))?>[\s\S]*?<\/(?:antml:invoke|(?:antml:)?(?:tool_call|tool_use|function_call))>/gi,
			(_match, attributes: string) => {
				const name = /(?:name|tool)=["']([^"']+)["']/i.exec(attributes ?? "")?.[1] ?? "tool";
				return `[tool call: ${name}]`;
			},
		);
	const lines = withoutToolBlocks.split(/\r?\n/);
	const kept: string[] = [];
	let omittingReasoning = false;
	let omittingToolOutput = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (/^(?:tool|function)\s*:/i.test(trimmed)) {
			omittingToolOutput = true;
			continue;
		}
		if (/^(?:user|human|assistant|system|developer)\s*:/i.test(trimmed)) {
			omittingReasoning = false;
			omittingToolOutput = false;
		}
		if (/^(?:assistant\s+)?(?:reasoning|thinking|thought|analysis)\s*:/i.test(trimmed)) {
			omittingReasoning = true;
			continue;
		}
		if (
			/^(?:tool[_ -]?(?:output|result)|function[_ -]?(?:output|result)|<tool_result|<tool_response)\b/i.test(trimmed)
		) {
			omittingToolOutput = true;
			continue;
		}
		if (omittingReasoning || omittingToolOutput) continue;
		if (/^(?:tool[_ -]?(?:call|use)|function[_ -]?call)\b/i.test(trimmed)) {
			const name = trimmed.split(/\s*[:=]\s*/, 2)[1]?.trim() || "tool";
			kept.push(`[tool call: ${name.replace(/[\s\[({].*$/, "")}]`);
			continue;
		}
		kept.push(line);
	}
	return kept
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Return whether a structured line contains no Dreaming-visible evidence. */
function isJsonTranscriptExcluded(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const nestedItem = record.item ?? record.message ?? record.payload;
	const item =
		typeof nestedItem === "object" && nestedItem !== null && !Array.isArray(nestedItem)
			? (nestedItem as Record<string, unknown>)
			: record;
	if (isReasoningRecord(record) || isReasoningRecord(item) || isToolResultRecord(record) || isToolResultRecord(item))
		return true;
	const content = item.content;
	return (
		Array.isArray(content) &&
		content.length > 0 &&
		content.every(
			(block) =>
				typeof block === "object" &&
				block !== null &&
				!Array.isArray(block) &&
				(isReasoningRecord(block as Record<string, unknown>) || isToolResultRecord(block as Record<string, unknown>)),
		)
	);
}

/**
 * Project a canonical transcript for Dreaming without mutating the retained
 * transcript. Tool calls remain as one-line markers; tool outputs and
 * reasoning blocks are omitted before the exact-quote gate sees the source.
 */
export function sanitizeTranscriptForDreaming(content: string): string {
	const lines = content.split(/\r?\n/);
	const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
	const jsonLines: string[] = [];
	let parsedLines = 0;
	let recognizedJsonLines = 0;
	for (const line of nonEmptyLines) {
		try {
			const parsed: unknown = JSON.parse(line.trim());
			parsedLines += 1;
			const rendered = jsonTranscriptLine(parsed);
			if (rendered.length > 0) {
				recognizedJsonLines += 1;
				jsonLines.push(...rendered);
			}
		} catch {
			// A plain line means this is not a pure JSONL transcript.
		}
	}
	if (parsedLines === nonEmptyLines.length && recognizedJsonLines > 0) return jsonLines.join("\n").trim();

	// Mixed transcripts retain prose and still apply structured tool-output
	// filtering line by line. Unknown JSON objects stay as source text rather
	// than causing the entire human-readable transcript to disappear.
	const mixedLines = lines.flatMap((line) => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return [line];
		try {
			const parsed: unknown = JSON.parse(trimmed);
			const rendered = jsonTranscriptLine(parsed);
			if (rendered.length > 0) return rendered;
			if (isJsonTranscriptExcluded(parsed)) return [];
		} catch {
			// Keep non-JSON prose for the plain sanitizer.
		}
		return [line];
	});
	return sanitizePlainTranscript(mixedLines.join("\n"));
}

/** The complete immutable evidence text Dreaming presents and citation checks. */
export function renderDreamingEvidence(source: EpisodicSourceRecord): string {
	const content =
		source.kind === "transcript" || source.sourceKind === "transcript"
			? sanitizeTranscriptForDreaming(source.content)
			: source.content;
	// Scan both the retained source and the projected form. Sanitizing a
	// transcript is a presentation step, not permission to forget that hostile
	// source content exists. The source remains available to audit, but no
	// prompt-facing Dreaming projection may carry it.
	if (!scanMemoryContent(source.content).contextEligible || !scanMemoryContent(content).contextEligible) {
		return MEMORY_CONTENT_WITHHELD_NOTICE;
	}
	const metadata = renderDreamingEvidenceMeta(source.evidenceMeta);
	const rendered = metadata ? `${content}\n${metadata}` : content;
	return scanMemoryContent(rendered).contextEligible ? rendered : MEMORY_CONTENT_WITHHELD_NOTICE;
}

/**
 * Convert the exact evidence passed to a Dreaming session into citation
 * records. The content is deliberately rendered here, once, so agents and
 * the write tool validate against the same structured text.
 */
export function createDreamingAgentEvidence(
	evidence: readonly (EpisodicSourceRecord | DreamingEvidenceFragment)[],
): readonly DreamingAgentEvidence[] {
	return evidence.flatMap((item) => {
		const fragment = "source" in item ? item : completeDreamingEvidenceFragment(item);
		const { source } = fragment;
		if (fragment.content === MEMORY_CONTENT_WITHHELD_NOTICE || !scanMemoryContent(fragment.content).contextEligible)
			return [];
		return [
			{
				sourceRef: `${source.kind}:${source.id}`,
				content: fragment.content,
				sourceKind: source.sourceKind,
				sourceId: source.sourceId,
				sourcePath: source.sourcePath,
				sourceEntryId: source.sourceEntryId,
			},
		];
	});
}
