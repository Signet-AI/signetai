/**
 * Edge ingest envelope + normalizer registry (#913).
 *
 * The unified ingest edge: per-format normalizers live ONLY here and emit one
 * common NormalizedSource. `text` is the SOURCE-PRESERVING canonical form — LF
 * endings, headings, tables, code fences, frontmatter, wikilink structure all
 * survive. Source structure carries meaning (a sentence under `## Notes`, a
 * frontmatter tag, and a table row have different force), and flattening it
 * destroys evidence for embedding, citation, display, and reasoning. This is
 * the lesson from the markdown-embedding bug: once the source is flattened,
 * every downstream layer guesses what used to be there.
 *
 * Derived representations (embedding input, dedupe/hash) are computed
 * DOWNSTREAM from `text`, never substituted for it. The original source bytes
 * are retained immutably as the artifact layer; the NormalizedSource is the
 * derivation handle that points back to them.
 *
 * MD/HTML/JSON/plain normalizers are zero-external-dep. Google Docs (OAuth),
 * images (vision), videos (transcription) are opt-in provider-gated normalizers
 * added later — a missing or unconfigured normalizer returns a StructuredError,
 * never a silent skip.
 */

export type IngestFormat = "markdown" | "html" | "json" | "plain" | "gdocs" | "image" | "video";

/** The canonical, source-preserving text a normalizer emits. */
export interface NormalizedSource {
	readonly format: IngestFormat;
	readonly text: string;
	/** Best-effort title for display; optional. */
	readonly title?: string;
	/** Original source locator (URL, path, doc id) carried through as provenance. */
	readonly sourcePath?: string;
	/** Format-specific metadata that survived normalization (frontmatter, mime). */
	readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A normalizer that could not run returns this — never an empty/silent success. */
export interface NormalizerError {
	readonly ok: false;
	readonly format: IngestFormat;
	/** "unconfigured" | "unrecognized" | "malformed" | "provider-required" */
	readonly reason: string;
	readonly message: string;
}

export interface NormalizerOk {
	readonly ok: true;
	readonly source: NormalizedSource;
}

export type NormalizeResult = NormalizerOk | NormalizerError;

export interface NormalizeOptions {
	readonly sourcePath?: string;
	/** Hint when the caller knows the format (e.g. a file extension); else detected. */
	readonly formatHint?: IngestFormat;
}

export interface EdgeNormalizer {
	readonly format: IngestFormat;
	readonly providerGated: boolean;
	normalize(input: string, opts?: NormalizeOptions): NormalizeResult;
}

/** Registry of format → normalizer. MD/HTML/JSON/plain are registered by their modules. */
const registry = new Map<IngestFormat, EdgeNormalizer>();

export function registerEdgeNormalizer(normalizer: EdgeNormalizer): void {
	registry.set(normalizer.format, normalizer);
}

export function getEdgeNormalizer(format: IngestFormat): EdgeNormalizer | undefined {
	return registry.get(format);
}

/** Detect format from a hint, extension, or content sniff. Returns null if unknown. */
export function detectFormat(opts: NormalizeOptions | undefined, input: string): IngestFormat | null {
	if (opts?.formatHint) return opts.formatHint;
	const path = opts?.sourcePath ?? "";
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	if (ext === "md" || ext === "markdown") return "markdown";
	if (ext === "html" || ext === "htm") return "html";
	if (ext === "json" || ext === "jsonl") return "json";
	if (ext === "txt") return "plain";
	// Content sniff.
	const head = input.slice(0, 512).trim();
	if (head.startsWith("<") || /<!doctype html|<html/i.test(head)) return "html";
	if (head.startsWith("{") || head.startsWith("[") || head.startsWith("[")) {
		try {
			JSON.parse(head);
			return "json";
		} catch {
			// not strict JSON; fall through
		}
	}
	if (/^#{1,6}\s|^\s*---\n|^\*\s|\[[^\]]+\]\([^)]+\)/m.test(head)) return "markdown";
	return null;
}

/**
 * Normalize an arbitrary edge input into the source-preserving canonical form.
 * A missing/unconfigured normalizer returns a StructuredError — never silent.
 */
export function normalizeSource(input: string, opts?: NormalizeOptions): NormalizeResult {
	const format = detectFormat(opts, input);
	if (!format) {
		return {
			ok: false,
			format: opts?.formatHint ?? "plain",
			reason: "unrecognized",
			message: "Could not detect ingest format and no hint was provided",
		};
	}
	const normalizer = registry.get(format);
	if (!normalizer) {
		return {
			ok: false,
			format,
			reason: "unconfigured",
			message: `No normalizer registered for format "${format}"`,
		};
	}
	return normalizer.normalize(input, opts);
}

// ---------------------------------------------------------------------------
// The "plain" normalizer — registered here (trivial, zero-dep). The richer
// markdown/html/json normalizers are registered by their modules on import.
// ---------------------------------------------------------------------------

registerEdgeNormalizer({
	format: "plain",
	providerGated: false,
	normalize(input, opts) {
		// Source-preserving: normalize line endings to LF, strip a trailing BOM,
		// keep all other structure exactly as authored.
		const text = input.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		return { ok: true, source: { format: "plain", text, sourcePath: opts?.sourcePath } };
	},
});
