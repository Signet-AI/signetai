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

function contentText(value: unknown): string[] {
	if (typeof value === "string") return value.trim().length > 0 ? [value.trim()] : [];
	if (!Array.isArray(value)) return [];
	const text: string[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			if (item.trim().length > 0) text.push(item.trim());
			continue;
		}
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const block = item as Record<string, unknown>;
		const type = stringValue(block.type)?.toLowerCase() ?? "";
		if (["tool_result", "tool_response", "function_call_output", "function_result"].includes(type)) continue;
		if (["tool_use", "tool_call", "function_call"].includes(type)) {
			text.push(toolMarker(block));
			continue;
		}
		const blockText = stringValue(block.text) ?? stringValue(block.content);
		if (blockText) text.push(blockText);
	}
	return text;
}

function jsonTranscriptLine(value: unknown): string[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	const record = value as Record<string, unknown>;
	const nestedItem = record.item;
	const item =
		typeof nestedItem === "object" && nestedItem !== null && !Array.isArray(nestedItem)
			? (nestedItem as Record<string, unknown>)
			: record;
	const type = (stringValue(item.type) ?? stringValue(record.type) ?? "").toLowerCase();
	if (
		["tool_result", "tool_response", "function_call_output", "function_result", "tool_output", "tool_return"].some(
			(candidate) => type.includes(candidate),
		)
	) {
		return [];
	}
	if (["tool_use", "tool_call", "function_call", "function_calling"].some((candidate) => type.includes(candidate))) {
		return [toolMarker(item)];
	}
	const role = (stringValue(item.role) ?? stringValue(record.role) ?? "").toLowerCase();
	if (role === "tool" || role === "function") return [];
	const payload = record.payload;
	if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
		const payloadRecord = payload as Record<string, unknown>;
		const payloadType = (stringValue(payloadRecord.type) ?? "").toLowerCase();
		if (payloadType.includes("tool") || payloadType.includes("function_call")) {
			if (payloadType.includes("result") || payloadType.includes("output")) return [];
			return [toolMarker(payloadRecord)];
		}
		const payloadRole = stringValue(payloadRecord.role)?.toLowerCase();
		const payloadText = contentText(payloadRecord.content ?? payloadRecord.text);
		if (payloadRole && payloadText.length > 0)
			return [`${payloadRole === "user" ? "User" : "Assistant"}: ${payloadText.join("\n")}`];
	}
	const text = contentText(item.content ?? item.text ?? item.message);
	if (text.length === 0) return [];
	const label =
		role === "user" ? "User" : role === "assistant" ? "Assistant" : role === "reasoning" ? "Assistant reasoning" : null;
	return label ? text.map((part) => `${label}: ${part}`) : text;
}

function sanitizePlainTranscript(content: string): string {
	const withoutToolBlocks = content
		.replace(
			/<(?:tool_result|tool_output|function_result|function_output|tool_response)>[\s\S]*?<\/(?:tool_result|tool_output|function_result|function_output|tool_response)>/gi,
			"",
		)
		.replace(
			/<(?:tool_call|tool_use|function_call)(?:\s+([^>]*))?>[\s\S]*?<\/(?:tool_call|tool_use|function_call)>/gi,
			(_match, attributes: string) => {
				const name = /(?:name|tool)=["']([^"']+)["']/i.exec(attributes ?? "")?.[1] ?? "tool";
				return `[tool call: ${name}]`;
			},
		);
	const lines = withoutToolBlocks.split(/\r?\n/);
	const kept: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (/^(?:tool[_ -]?(?:output|result)|function[_ -]?(?:output|result)|<tool_result|<tool_response)\b/i.test(trimmed))
			continue;
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

/**
 * Project a canonical transcript for Dreaming without mutating the retained
 * transcript. Tool calls remain as one-line markers; tool outputs are not
 * evidence and are omitted before the exact-quote gate sees the source.
 */
function isJsonTranscriptToolOutput(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const nestedItem = record.item;
	const item =
		typeof nestedItem === "object" && nestedItem !== null && !Array.isArray(nestedItem)
			? (nestedItem as Record<string, unknown>)
			: record;
	const type = (stringValue(item.type) ?? stringValue(record.type) ?? "").toLowerCase();
	if (
		["tool_result", "tool_response", "function_call_output", "function_result", "tool_output", "tool_return"].some(
			(candidate) => type.includes(candidate),
		)
	)
		return true;
	const role = (stringValue(item.role) ?? stringValue(record.role) ?? "").toLowerCase();
	if (role === "tool" || role === "function") return true;
	const payload = record.payload;
	if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
		const payloadRecord = payload as Record<string, unknown>;
		const payloadType = (stringValue(payloadRecord.type) ?? "").toLowerCase();
		const payloadRole = (stringValue(payloadRecord.role) ?? "").toLowerCase();
		return (
			payloadType.includes("result") ||
			payloadType.includes("output") ||
			payloadRole === "tool" ||
			payloadRole === "function"
		);
	}
	return false;
}

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
			if (isJsonTranscriptToolOutput(parsed)) return [];
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
	const metadata = renderDreamingEvidenceMeta(source.evidenceMeta);
	return metadata ? `${content}\n${metadata}` : content;
}

/**
 * Convert the exact evidence passed to a Dreaming session into citation
 * records. The content is deliberately rendered here, once, so agents and
 * the write tool validate against the same structured text.
 */
export function createDreamingAgentEvidence(
	evidence: readonly (EpisodicSourceRecord | DreamingEvidenceFragment)[],
): readonly DreamingAgentEvidence[] {
	return evidence.map((item) => {
		const fragment = "source" in item ? item : completeDreamingEvidenceFragment(item);
		const { source } = fragment;
		return {
			sourceRef: `${source.kind}:${source.id}`,
			content: fragment.content,
			sourceKind: source.sourceKind,
			sourceId: source.sourceId,
			sourcePath: source.sourcePath,
			sourceEntryId: source.sourceEntryId,
		};
	});
}
