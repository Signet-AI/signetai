import { createHash } from "node:crypto";
import { escapeMemoryContextForFence } from "./memory-context";

export const PROMPT_CONTEXT_VERSION = 1 as const;
export const PROMPT_CONTEXT_OPEN = "<signet-memory-context>";
export const PROMPT_CONTEXT_CLOSE = "</signet-memory-context>";

export interface PromptContextEnvelope {
	readonly version: typeof PROMPT_CONTEXT_VERSION;
	readonly content: string;
	/** SHA-256 of the exact serialized bytes sent to the harness. */
	readonly hash: string;
	readonly serialized: string;
}

/**
 * Normalize only transport noise. Do not reflow or otherwise rewrite memory
 * content: the normalized value is the replay contract for every harness.
 */
export function normalizePromptContext(content: string): string {
	return content.replace(/\r\n?/g, "\n").trimEnd();
}

/** Hash the exact bytes delivered through the hook response. */
export function hashPromptContext(serialized: string): string {
	return createHash("sha256").update(serialized).digest("hex");
}

function escapeNestedMarkers(content: string): string {
	return escapeMemoryContextForFence(content);
}

export function createPromptContext(content: string): PromptContextEnvelope | null {
	const normalized = normalizePromptContext(content);
	if (normalized.trim().length === 0) return null;
	const safeContent = escapeNestedMarkers(normalized);
	const serialized = `${PROMPT_CONTEXT_OPEN}\n${safeContent}\n${PROMPT_CONTEXT_CLOSE}\n`;
	return {
		version: PROMPT_CONTEXT_VERSION,
		content: safeContent,
		hash: hashPromptContext(serialized),
		serialized,
	};
}

/** Remove a complete or incomplete internal context block from provider text. */
export function scrubPromptContext(text: string): string {
	const scrubber = new PromptContextStreamScrubber();
	return `${scrubber.push(text)}${scrubber.flush()}`;
}

/**
 * Streaming-safe counterpart to scrubPromptContext. It buffers only a
 * possible fence and its contents, so a marker split across provider chunks
 * cannot reach a visible assistant-output callback.
 */
export class PromptContextStreamScrubber {
	private pending = "";

	push(chunk: string): string {
		this.pending += chunk;
		let output = "";

		for (;;) {
			const openIndex = this.pending.indexOf(PROMPT_CONTEXT_OPEN);
			const closeIndex = this.pending.indexOf(PROMPT_CONTEXT_CLOSE);
			if (openIndex < 0 && closeIndex < 0) {
				const keep = this.trailingFencePrefixLength(this.pending);
				output += this.pending.slice(0, this.pending.length - keep);
				this.pending = keep > 0 ? this.pending.slice(-keep) : "";
				return output;
			}
			if (openIndex < 0 || (closeIndex >= 0 && closeIndex < openIndex)) {
				output += this.pending.slice(0, closeIndex);
				this.pending = this.pending.slice(closeIndex + PROMPT_CONTEXT_CLOSE.length);
				continue;
			}

			output += this.pending.slice(0, openIndex);
			const closeStart = openIndex + PROMPT_CONTEXT_OPEN.length;
			const blockCloseIndex = this.pending.indexOf(PROMPT_CONTEXT_CLOSE, closeStart);
			if (blockCloseIndex < 0) {
				this.pending = this.pending.slice(openIndex);
				return output;
			}
			this.pending = this.pending.slice(blockCloseIndex + PROMPT_CONTEXT_CLOSE.length);
		}
	}

	flush(): string {
		const remaining = this.pending;
		this.pending = "";
		const openIndex = remaining.indexOf(PROMPT_CONTEXT_OPEN);
		const closeIndex = remaining.indexOf(PROMPT_CONTEXT_CLOSE);
		if (openIndex >= 0) return remaining.slice(0, openIndex);
		if (closeIndex >= 0) return remaining.slice(0, closeIndex);
		const keep = this.trailingFencePrefixLength(remaining);
		return remaining.slice(0, remaining.length - keep);
	}

	private trailingFencePrefixLength(value: string): number {
		const maximum = Math.min(value.length, Math.max(PROMPT_CONTEXT_OPEN.length, PROMPT_CONTEXT_CLOSE.length) - 1);
		for (let length = maximum; length > 0; length -= 1) {
			if (value.endsWith(PROMPT_CONTEXT_OPEN.slice(0, length)) || value.endsWith(PROMPT_CONTEXT_CLOSE.slice(0, length)))
				return length;
		}
		return 0;
	}
}
