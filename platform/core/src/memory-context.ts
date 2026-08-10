/**
 * Helpers for keeping Signet's injected memory context separate from a
 * harness' canonical conversation.
 *
 * The delimiters are transport markers, not user-visible content.  Harnesses
 * may use the wrapped form when they need to put dynamic context in an API
 * copy of a user message, and must pass provider output through the streaming
 * scrubber before displaying it.
 */

const INTERNAL_FENCE_NAMES = ["signet-memory-context", "signet-memory", "memory-context"] as const;

const FENCE_PREFIXES = [
	"<signet-memory",
	"<\\/signet-memory",
	"</signet-memory",
	"<signet-memory-context",
	"<\\/signet-memory-context",
	"</signet-memory-context",
	"<memory-context",
	"<\\/memory-context",
	"</memory-context",
] as const;

interface FenceMatch {
	readonly index: number;
	readonly end: number;
}

function isFenceWhitespace(character: string | undefined): boolean {
	return character === " " || character === "\t" || character === "\r" || character === "\n";
}

function readFenceName(text: string, start: number): (typeof INTERNAL_FENCE_NAMES)[number] | undefined {
	for (const name of INTERNAL_FENCE_NAMES) {
		if (text.slice(start, start + name.length).toLowerCase() === name) return name;
	}
	return undefined;
}

type ParsedFence = { readonly kind: "open" | "close"; readonly end: number } | { readonly incomplete: true };

function parseFenceAt(text: string, index: number): ParsedFence | undefined {
	if (text[index] !== "<") return undefined;

	let cursor = index + 1;
	if (text[cursor] === "\\") cursor += 1;
	while (isFenceWhitespace(text[cursor])) cursor += 1;

	const isClose = text[cursor] === "/";
	if (isClose) cursor += 1;
	while (isFenceWhitespace(text[cursor])) cursor += 1;

	const name = readFenceName(text, cursor);
	if (!name) return undefined;
	const afterName = cursor + name.length;
	const boundary = text[afterName];
	if (!isClose && !isFenceWhitespace(boundary) && boundary !== "/" && boundary !== ">") return undefined;

	cursor = afterName;
	if (isClose) {
		while (isFenceWhitespace(text[cursor])) cursor += 1;
		if (text[cursor] === ">") return { kind: "close", end: cursor + 1 };
		return cursor >= text.length ? { incomplete: true } : undefined;
	}

	let quote: '"' | "'" | undefined;
	while (cursor < text.length) {
		const character = text[cursor];
		if (quote) {
			if (character === quote) quote = undefined;
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === ">") {
			return { kind: "open", end: cursor + 1 };
		}
		cursor += 1;
	}
	return { incomplete: true };
}

function findNextFence(
	text: string,
	startIndex = 0,
): { readonly kind: "open" | "close"; readonly match: FenceMatch } | undefined {
	for (let index = startIndex; index < text.length; index += 1) {
		if (text[index] !== "<") continue;
		const parsed = parseFenceAt(text, index);
		if (!parsed) continue;
		if ("incomplete" in parsed) return { kind: "open", match: { index, end: text.length } };
		return { kind: parsed.kind, match: { index, end: parsed.end } };
	}
	return undefined;
}

/**
 * Remove internal memory blocks and orphaned delimiters from canonical text.
 *
 * An unterminated opening delimiter drops the remainder of the value.  This
 * is intentional: retaining a partial provider block would make a transcript
 * or recall query depend on transport state and could leak hidden context.
 */
export function stripInternalMemoryContext(text: string): string {
	let remaining = text;
	let output = "";

	while (remaining.length > 0) {
		const next = findNextFence(remaining);
		if (!next) return output + remaining;

		output += remaining.slice(0, next.match.index);
		remaining = remaining.slice(next.match.end);
		if (next.kind === "close") continue;

		let depth = 1;
		while (depth > 0) {
			const nested = findNextFence(remaining);
			if (!nested) return output;
			remaining = remaining.slice(nested.match.end);
			if (nested.kind === "open") {
				depth += 1;
			} else {
				depth -= 1;
			}
		}
	}

	return output;
}

/** Escape delimiters found inside memory content before it is wrapped. */
export function escapeMemoryContextForFence(text: string): string {
	let output = "";
	let cursor = 0;
	let next = findNextFence(text);
	while (next) {
		output += text.slice(cursor, next.match.index);
		output += `&lt;${text.slice(next.match.index + 1, next.match.end)}`;
		cursor = next.match.end;
		next = findNextFence(text, cursor);
	}
	return output + text.slice(cursor);
}

/** Build the provider-bound wrapper for dynamic context. */
export function wrapMemoryContext(context: string, source = "api-context"): string {
	const clean = escapeMemoryContextForFence(context).trim();
	if (!clean) return "";
	const safeSource = source.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40) || "api-context";
	return `<signet-memory source="${safeSource}">\n${clean}\n</signet-memory>`;
}

/**
 * Compose the API-only copy of a user message.  The caller must persist the
 * original user message, not this returned value.
 */
export function composeApiUserContent(userContent: string, dynamicContext: string): string {
	const cleanUserContent = stripInternalMemoryContext(userContent);
	const contextBlock = wrapMemoryContext(dynamicContext);
	if (!contextBlock) return cleanUserContent;
	return `${cleanUserContent}\n\n${contextBlock}`;
}

function partialFenceSuffixLength(text: string): number {
	const lower = text.toLowerCase();
	let longest = 0;
	for (const prefix of FENCE_PREFIXES) {
		const candidate = prefix.toLowerCase();
		const max = Math.min(candidate.length, lower.length);
		for (let length = max; length > longest; length--) {
			if (lower.endsWith(candidate.slice(0, length))) {
				longest = length;
				break;
			}
		}
	}
	for (const prefix of FENCE_PREFIXES) {
		const candidate = prefix.toLowerCase();
		const start = lower.lastIndexOf(candidate);
		if (start === -1) continue;
		const tail = text.slice(start);
		if (tail.length === candidate.length) {
			longest = Math.max(longest, tail.length);
			continue;
		}
		const firstSuffixCharacter = tail[candidate.length];
		if (!firstSuffixCharacter || !/[\s/>]/.test(firstSuffixCharacter)) continue;
		let quote: '"' | "'" | undefined;
		let complete = false;
		for (let index = candidate.length; index < tail.length; index += 1) {
			const character = tail[index];
			if (quote) {
				if (character === quote) quote = undefined;
				continue;
			}
			if (character === '"' || character === "'") {
				quote = character;
			} else if (character === ">") {
				complete = true;
				break;
			}
		}
		if (complete) continue;
		longest = Math.max(longest, tail.length);
	}
	return longest;
}

/**
 * Streaming equivalent of stripInternalMemoryContext.
 *
 * Delimiter prefixes are retained between feeds, so a marker split across
 * provider chunks cannot be displayed before the next chunk arrives.
 */
export class StreamingMemoryContextScrubber {
	private buffer = "";
	private fenceDepth = 0;

	feed(chunk: string): string {
		if (!chunk) return "";
		this.buffer += chunk;
		let output = "";

		while (this.buffer.length > 0) {
			if (this.fenceDepth > 0) {
				const next = findNextFence(this.buffer);
				if (!next) return output;
				this.buffer = this.buffer.slice(next.match.end);
				if (next.kind === "open") {
					this.fenceDepth += 1;
				} else {
					this.fenceDepth -= 1;
				}
				continue;
			}

			const next = findNextFence(this.buffer);
			if (!next) {
				const held = partialFenceSuffixLength(this.buffer);
				const safeLength = this.buffer.length - held;
				if (safeLength > 0) output += this.buffer.slice(0, safeLength);
				this.buffer = held > 0 ? this.buffer.slice(safeLength) : "";
				return output;
			}

			output += this.buffer.slice(0, next.match.index);
			this.buffer = this.buffer.slice(next.match.end);
			if (next.kind === "open") this.fenceDepth = 1;
		}

		return output;
	}

	flush(): string {
		if (this.fenceDepth > 0) {
			this.buffer = "";
			this.fenceDepth = 0;
			return "";
		}
		const held = partialFenceSuffixLength(this.buffer);
		const safeLength = this.buffer.length - held;
		const output = safeLength > 0 ? this.buffer.slice(0, safeLength) : "";
		this.buffer = "";
		return output;
	}

	reset(): void {
		this.buffer = "";
		this.fenceDepth = 0;
	}
}
