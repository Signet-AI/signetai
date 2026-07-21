/**
 * Markdown edge normalizer (#913 Phase 3).
 *
 * Markdown is already the canonical source-preserving form, so this is a
 * near-identity pass that GUARANTEES the invariants downstream code relies on:
 * LF endings, no leading BOM, and frontmatter / headings / fenced code /
 * tables / wikilinks survive byte-for-byte. The emitted `text` is
 * byte-equivalent to the input modulo line endings + BOM — nothing is
 * reflowed, reordered, or stripped. Derived representations (embedding input,
 * dedupe/hash) are computed DOWNSTREAM from `text`, never substituted for it.
 *
 * This is the structural-preservation counterpoint to the legacy HTML flatten
 * in platform/daemon/src/pipeline/url-fetcher.ts (which collapsed all
 * whitespace before chunking and destroyed evidence for embedding/citation/
 * reasoning). Source structure carries meaning; once it is flattened every
 * downstream layer guesses what used to be there.
 *
 * Zero external dependencies. The only transforms are BOM strip + line-ending
 * normalization; frontmatter detection is read-only and only populates
 * `metadata.frontmatter` (a light `key: value` parse, no YAML dep).
 */

import type { EdgeNormalizer, NormalizeOptions, NormalizeResult } from "../envelope";
import { registerEdgeNormalizer } from "../envelope";

const BOM = "﻿";

/** Strip a single leading BOM, if present. Mirrors the plain normalizer. */
function stripLeadingBom(input: string): string {
	return input.startsWith(BOM) ? input.slice(BOM.length) : input;
}

/** Normalize CRLF and lone CR to LF. */
function normalizeLineEndings(input: string): string {
	return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

interface FrontmatterParse {
	readonly present: boolean;
	readonly keys: Readonly<Record<string, string>>;
}

/**
 * Light YAML-frontmatter detection. Matches a block delimited by a leading
 * `---` line and a closing `---` (or `...`) line. The body is parsed into
 * top-level `key: value` scalars only — no nested YAML, no arrays, no
 * external dep. The block itself is left in `text` verbatim; this only
 * populates metadata. A leading `---` with no close marker is ordinary
 * content (likely a thematic break), not frontmatter.
 */
function parseFrontmatter(text: string): FrontmatterParse {
	// Opening line must be exactly "---". Accept "---\n..." or a bare "---".
	if (!text.startsWith("---\n") && text !== "---") {
		return { present: false, keys: {} };
	}
	const lines = text.split("\n");
	let closeIdx = -1;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line === "---" || line === "...") {
			closeIdx = i;
			break;
		}
	}
	if (closeIdx === -1) {
		return { present: false, keys: {} };
	}
	const keys: Record<string, string> = {};
	const keyValueRe = /^([A-Za-z0-9_\-.]+):(?:[ \t]*(.*))?$/;
	for (let i = 1; i < closeIdx; i++) {
		const match = keyValueRe.exec(lines[i]);
		if (!match) continue;
		const key = match[1];
		let value = (match[2] ?? "").trim();
		// Strip one matching pair of surrounding quotes (light touch only).
		if (value.length >= 2) {
			const first = value[0];
			const last = value[value.length - 1];
			if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
				value = value.slice(1, -1);
			}
		}
		keys[key] = value;
	}
	return { present: true, keys };
}

/**
 * Markdown normalizer. Source-preserving identity pass: LF endings, no BOM,
 * all structure intact. Frontmatter is surfaced into metadata but kept in text.
 */
export const markdownNormalizer: EdgeNormalizer = {
	format: "markdown",
	providerGated: false,
	normalize(input: string, opts?: NormalizeOptions): NormalizeResult {
		const text = normalizeLineEndings(stripLeadingBom(input));
		const fm = parseFrontmatter(text);
		const metadata: Record<string, unknown> | undefined = fm.present
			? { frontmatter: fm.keys }
			: undefined;
		return {
			ok: true,
			source: {
				format: "markdown",
				text,
				sourcePath: opts?.sourcePath,
				metadata,
			},
		};
	},
};

// Side-effect registration, identical pattern to the plain normalizer.
registerEdgeNormalizer(markdownNormalizer);
