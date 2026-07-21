/**
 * JSON / JSONL edge normalizer (#913).
 *
 * Renders JSON and JSONL source into a SOURCE-PRESERVING markdown text. The
 * semantic structure of the source — object keys, array order, message turns,
 * and long verbatim string payloads — is what carries meaning for embedding,
 * citation, and reasoning, so it must survive into `NormalizedSource.text`.
 *
 * This is the explicit counter-example to the legacy HTML flatten in
 * platform/daemon/src/pipeline/url-fetcher.ts:191-201 (which collapsed all
 * whitespace before chunking and destroyed evidence). Structured input is
 * rendered as structured markdown (headings, bullet lists, blank-line-separated
 * conversation turns) — NEVER `JSON.stringify`'d onto one line and NEVER
 * whitespace-collapsed. Long string values stay verbatim; multi-line strings
 * keep their line breaks.
 *
 * Detection:
 *   - Whole-input `JSON.parse` first (covers objects, arrays, pretty-printed).
 *   - On failure, fall back to JSONL (one JSON value per non-empty line).
 *   - Recognized transcript shapes (`{messages:[...]}` or an array / JSONL
 *     stream of `{role, content}` objects) render as a readable conversation:
 *     `**role**:` on its own line, blank line, then the content verbatim.
 *
 * Zero external dependencies. Node/Bun built-ins only.
 */

import type { EdgeNormalizer, NormalizeOptions, NormalizeResult } from "../envelope";
import { registerEdgeNormalizer } from "../envelope";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = Record<string, JsonValue>;
type JsonShape = "jsonl" | "object" | "array" | "transcript";

/** A single leading BOM, mirroring the plain / markdown normalizers. */
const BOM = "﻿";

function stripLeadingBom(input: string): string {
	return input.startsWith(BOM) ? input.slice(BOM.length) : input;
}

function normalizeLineEndings(input: string): string {
	return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** True for an object that carries both `role` and `content` fields. */
function isMessageLike(value: JsonValue): value is JsonObject {
	if (value === null || Array.isArray(value) || typeof value !== "object") return false;
	return "role" in value && "content" in value;
}

/** An array where every element is message-shaped → a conversation transcript. */
function isTranscriptArray(value: JsonValue): value is JsonObject[] {
	return Array.isArray(value) && value.length > 0 && value.every((item) => isMessageLike(item));
}

/** A `{messages: [...]}` object whose `messages` are all message-shaped. */
function extractMessages(value: JsonValue): JsonObject[] | null {
	if (value === null || Array.isArray(value) || typeof value !== "object") return null;
	const messages = (value as JsonObject).messages;
	if (!Array.isArray(messages) || messages.length === 0) return null;
	const typed: JsonObject[] = [];
	for (const m of messages) {
		if (!isMessageLike(m)) return null;
		typed.push(m);
	}
	return typed;
}

/** Render an object key as a depth-scaled markdown heading, capped at h6. */
function headingFor(key: string, depth: number): string {
	const level = Math.min(2 + depth, 6);
	return `${"#".repeat(level)} ${key}`;
}

function scalarToString(value: string | number | boolean | null): string {
	if (value === null) return "null";
	if (typeof value === "string") return value;
	return String(value);
}

/** Strings that should become their own block (heading + verbatim body). */
function isBlockString(s: string): boolean {
	return s.includes("\n") || s.length > 80;
}

function renderValue(value: JsonValue, depth: number): string {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return scalarToString(value as string | number | boolean | null);
	}
	if (Array.isArray(value)) return renderArray(value, depth);
	return renderObject(value as JsonObject, depth);
}

/**
 * Render an object as structured markdown. Consecutive scalar keys form a
 * tight `- key: value` bullet list; long / multi-line strings and nested
 * containers break the list and get a heading for the key followed by the
 * rendered value. Block entries are separated by blank lines so each survives
 * as its own chunk of meaning.
 */
function renderObject(obj: JsonObject, depth: number): string {
	const blocks: string[] = [];
	let scalarRun: string[] = [];
	const flushRun = (): void => {
		if (scalarRun.length > 0) {
			blocks.push(scalarRun.join("\n"));
			scalarRun = [];
		}
	};
	for (const [key, value] of Object.entries(obj)) {
		if (value === null) {
			scalarRun.push(`- ${key}: null`);
		} else if (typeof value === "number" || typeof value === "boolean") {
			scalarRun.push(`- ${key}: ${String(value)}`);
		} else if (typeof value === "string" && !isBlockString(value)) {
			scalarRun.push(`- ${key}: ${value}`);
		} else {
			flushRun();
			if (typeof value === "string") {
				blocks.push(`${headingFor(key, depth)}\n\n${value}`);
			} else {
				blocks.push(`${headingFor(key, depth)}\n\n${renderValue(value, depth + 1)}`);
			}
		}
	}
	flushRun();
	return blocks.join("\n\n");
}

/** First line gets the `- ` bullet; continuation lines are indented two spaces. */
function indentUnderBullet(text: string): string {
	return text
		.split("\n")
		.map((line, i) => (i === 0 ? `- ${line}` : `  ${line}`))
		.join("\n");
}

/** Render an array as a bullet list (order preserved top-to-bottom). */
function renderArray(arr: JsonValue[], depth: number): string {
	const items = arr.map((item) => {
		if (item === null || typeof item === "number" || typeof item === "boolean") {
			return `- ${scalarToString(item as string | number | boolean | null)}`;
		}
		if (typeof item === "string") {
			return isBlockString(item) ? indentUnderBullet(item) : `- ${item}`;
		}
		return indentUnderBullet(renderValue(item, depth + 1));
	});
	return items.join("\n");
}

/** Message content that is a plain string is emitted verbatim; structured
 * content (multimodal blocks, objects) is rendered recursively. */
function renderContent(content: JsonValue): string {
	if (typeof content === "string") return content;
	return renderValue(content, 1);
}

function renderMessage(msg: JsonObject): string {
	const roleRaw = msg.role;
	const role = typeof roleRaw === "string" ? roleRaw : String(roleRaw ?? "unknown");
	return `**${role}**:\n\n${renderContent(msg.content)}`;
}

function renderTranscript(messages: JsonObject[]): string {
	return messages.map(renderMessage).join("\n\n");
}

/** A non-message JSONL value rendered as its own section. */
function renderJsonlValue(value: JsonValue): string {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return scalarToString(value as string | number | boolean | null);
	}
	if (Array.isArray(value)) return renderArray(value, 0);
	return renderObject(value as JsonObject, 0);
}

/** Display title hint from a top-level `title` / `name` string field. */
function deriveTitle(value: JsonValue): string | undefined {
	if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
	const obj = value as JsonObject;
	const candidate = obj.title ?? obj.name;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** Parse a JSONL stream (one JSON value per non-empty line); null if any line fails. */
function tryParseJsonl(cleaned: string): JsonValue[] | null {
	const lines = cleaned
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return null;
	const values: JsonValue[] = [];
	for (const line of lines) {
		try {
			values.push(JSON.parse(line) as JsonValue);
		} catch {
			return null;
		}
	}
	return values;
}

function okResult(
	text: string,
	shape: JsonShape,
	opts: NormalizeOptions | undefined,
	title?: string,
): NormalizeResult {
	return {
		ok: true,
		source: {
			format: "json",
			text,
			title,
			sourcePath: opts?.sourcePath,
			metadata: { shape },
		},
	};
}

/**
 * JSON / JSONL normalizer. Source-preserving: structure becomes markdown, long
 * strings stay verbatim, parse failure is a structured `malformed` error.
 */
export const jsonNormalizer: EdgeNormalizer = {
	format: "json",
	providerGated: false,
	normalize(input: string, opts?: NormalizeOptions): NormalizeResult {
		const cleaned = normalizeLineEndings(stripLeadingBom(input));

		// 1) Try a single JSON value first (objects, arrays, pretty-printed).
		let parsed: JsonValue | undefined;
		let parseError: Error | undefined;
		try {
			parsed = JSON.parse(cleaned) as JsonValue;
		} catch (err) {
			parseError = err instanceof Error ? err : undefined;
		}

		if (parsed !== undefined) {
			const title = deriveTitle(parsed);
			const fromMessages = extractMessages(parsed);
			if (fromMessages) {
				return okResult(renderTranscript(fromMessages), "transcript", opts, title);
			}
			// A lone message-shaped object (`{role, content}`) renders as one turn.
			if (isMessageLike(parsed)) {
				return okResult(renderMessage(parsed), "transcript", opts, title);
			}
			if (isTranscriptArray(parsed)) {
				return okResult(renderTranscript(parsed), "transcript", opts, title);
			}
			if (Array.isArray(parsed)) {
				return okResult(renderArray(parsed, 0), "array", opts, title);
			}
			if (parsed !== null && typeof parsed === "object") {
				return okResult(renderObject(parsed as JsonObject, 0), "object", opts, title);
			}
			// Top-level primitive (rare): emit verbatim.
			return okResult(
				scalarToString(parsed as string | number | boolean | null),
				"object",
				opts,
				title,
			);
		}

		// 2) Whole-parse failed → try JSONL (one value per line).
		const jsonl = tryParseJsonl(cleaned);
		if (jsonl === null) {
			return {
				ok: false,
				format: "json",
				reason: "malformed",
				message: parseError ? `JSON parse failed: ${parseError.message}` : "JSON parse failed",
			};
		}

		const allMessages = jsonl.every((v) => isMessageLike(v));
		const shape: JsonShape = allMessages ? "transcript" : "jsonl";
		const text = jsonl
			.map((v) => (isMessageLike(v) ? renderMessage(v) : renderJsonlValue(v)))
			.join("\n\n");
		return okResult(text, shape, opts);
	},
};

// Side-effect registration, identical pattern to the plain / markdown normalizers.
registerEdgeNormalizer(jsonNormalizer);
