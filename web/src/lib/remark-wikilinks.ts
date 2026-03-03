/**
 * Remark plugin that transforms Obsidian-style [[wikilinks]] into HTML links.
 *
 * Supports:
 *   [[slug]]              → resolves to doc or blog URL
 *   [[slug|display text]] → custom link text
 *   [[docs/slug]]         → explicit doc reference
 *   [[blog/slug]]         → explicit blog reference
 *
 * Also populates vfile.data.wikilinks with outgoing link slugs
 * for use by the content graph builder.
 */

import type { Root, Text } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

// All known doc slugs (filename without .md, lowercased)
const DOC_SLUGS = new Set([
	"agents",
	"analytics",
	"api",
	"architecture",
	"auth",
	"cli",
	"configuration",
	"connectors",
	"contributing",
	"daemon",
	"dashboard",
	"diagnostics",
	"documents",
	"harnesses",
	"hooks",
	"knowledge-architecture",
	"mcp",
	"memory-skills",
	"memory",
	"pipeline",
	"quickstart",
	"readme",
	"roadmap",
	"scheduling",
	"sdk",
	"secrets",
	"self-hosting",
	"skills",
	"tray",
	"vision",
]);

// All known blog slugs (filename without .mdx)
const BLOG_SLUGS = new Set([
	"introducing-signet",
	"knowledge-architecture",
	"migrate-chatgpt-memory-to-claude",
	"why-local-first-memory",
]);

// Matches [[slug]] or [[slug|display text]]
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

interface WikilinkData {
	readonly slug: string;
	readonly collection: "docs" | "blog";
	readonly url: string;
}

function resolveWikilink(raw: string): WikilinkData | undefined {
	const normalized = raw.trim().toLowerCase();

	// Explicit prefix: [[docs/memory]] or [[blog/introducing-signet]]
	if (normalized.startsWith("docs/")) {
		const slug = normalized.slice(5);
		if (DOC_SLUGS.has(slug)) {
			return { slug: `docs/${slug}`, collection: "docs", url: `/docs/${slug}/` };
		}
		return undefined;
	}
	if (normalized.startsWith("blog/")) {
		const slug = normalized.slice(5);
		if (BLOG_SLUGS.has(slug)) {
			return { slug: `blog/${slug}`, collection: "blog", url: `/blog/${slug}/` };
		}
		return undefined;
	}

	// Strip .md / .mdx extension if present
	const stripped = normalized.replace(/\.mdx?$/, "");

	// Try docs first (more content there), then blog
	if (DOC_SLUGS.has(stripped)) {
		return { slug: `docs/${stripped}`, collection: "docs", url: `/docs/${stripped}/` };
	}
	if (BLOG_SLUGS.has(stripped)) {
		return { slug: `blog/${stripped}`, collection: "blog", url: `/blog/${stripped}/` };
	}

	return undefined;
}

function defaultDisplayText(raw: string): string {
	// Strip prefix and extension, title-case
	const cleaned = raw
		.replace(/^(docs|blog)\//, "")
		.replace(/\.mdx?$/, "")
		.replace(/-/g, " ");
	return cleaned
		.split(" ")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

const remarkWikilinks: Plugin<[], Root> = () => {
	return (tree, file) => {
		const outgoingLinks: string[] = [];

		visit(tree, "text", (node: Text, index, parent) => {
			if (index === undefined || parent === undefined) return;

			const value = node.value;
			if (!value.includes("[[")) return;

			const children: Array<Text | { type: "html"; value: string }> = [];
			let lastIndex = 0;

			for (const match of value.matchAll(WIKILINK_RE)) {
				const fullMatch = match[0];
				const rawSlug = match[1];
				const displayText = match[2];
				const matchStart = match.index;

				// Text before this match
				if (matchStart > lastIndex) {
					children.push({ type: "text", value: value.slice(lastIndex, matchStart) });
				}

				const resolved = resolveWikilink(rawSlug);
				if (resolved) {
					outgoingLinks.push(resolved.slug);
					const text = displayText ?? defaultDisplayText(rawSlug);
					children.push({
						type: "html",
						value: `<a href="${resolved.url}" class="wikilink" data-collection="${resolved.collection}">${text}</a>`,
					});
				} else {
					// Broken link — render with broken class
					const text = displayText ?? defaultDisplayText(rawSlug);
					children.push({
						type: "html",
						value: `<a class="wikilink broken" title="Page not found: ${rawSlug}">${text}</a>`,
					});
				}

				lastIndex = matchStart + fullMatch.length;
			}

			if (children.length === 0) return;

			// Remaining text after last match
			if (lastIndex < value.length) {
				children.push({ type: "text", value: value.slice(lastIndex) });
			}

			// Replace the text node with our mixed content
			parent.children.splice(index, 1, ...children);
		});

		// Store outgoing links on the vfile for the graph builder
		(file.data as Record<string, unknown>).wikilinks = outgoingLinks;
	};
};

export default remarkWikilinks;
export { resolveWikilink, DOC_SLUGS, BLOG_SLUGS, WIKILINK_RE };
