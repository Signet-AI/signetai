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
import { resolveWikilinkTarget } from "./content-routes";

function escapeHtml(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Matches [[slug]] or [[slug|display text]]
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

interface WikilinkData {
	readonly slug: string;
	readonly collection: "docs" | "blog";
	readonly url: string;
}

function resolveWikilink(raw: string): WikilinkData | undefined {
	const resolved = resolveWikilinkTarget(raw);
	if (!resolved) return undefined;
	return {
		slug: `${resolved.collection}/${resolved.slug}`,
		collection: resolved.collection,
		url: resolved.url,
	};
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
					const text = escapeHtml(displayText ?? defaultDisplayText(rawSlug));
					children.push({
						type: "html",
						value: `<a href="${escapeHtml(resolved.url)}" class="wikilink" data-collection="${escapeHtml(resolved.collection)}">${text}</a>`,
					});
				} else {
					// Broken link — render with broken class
					const text = escapeHtml(displayText ?? defaultDisplayText(rawSlug));
					children.push({
						type: "html",
						value: `<a class="wikilink broken" title="Page not found: ${escapeHtml(rawSlug)}">${text}</a>`,
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
export { resolveWikilink, WIKILINK_RE };
