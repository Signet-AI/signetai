/**
 * Build-time content graph builder.
 *
 * Scans all docs and blog posts for [[wikilinks]], builds a JSON index
 * of nodes and edges for the client-side graph viewer.
 *
 * Output shape (contentIndex.json):
 * {
 *   "docs/memory": { title, url, tags, links, collection },
 *   "blog/why-local-first-memory": { title, url, tags, links, collection },
 *   ...
 * }
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;

const DOC_SLUGS = new Set<string>();
const BLOG_SLUGS = new Set<string>();

export interface ContentNode {
	readonly title: string;
	readonly url: string;
	readonly tags: readonly string[];
	readonly links: readonly string[];
	readonly collection: "docs" | "blog";
}

export type ContentIndex = Record<string, ContentNode>;

function resolveSlug(raw: string): string | undefined {
	const normalized = raw.trim().toLowerCase();

	if (normalized.startsWith("docs/")) {
		const slug = normalized.slice(5);
		return DOC_SLUGS.has(slug) ? `docs/${slug}` : undefined;
	}
	if (normalized.startsWith("blog/")) {
		const slug = normalized.slice(5);
		return BLOG_SLUGS.has(slug) ? `blog/${slug}` : undefined;
	}

	const stripped = normalized.replace(/\.mdx?$/, "");
	if (DOC_SLUGS.has(stripped)) return `docs/${stripped}`;
	if (BLOG_SLUGS.has(stripped)) return `blog/${stripped}`;
	return undefined;
}

function extractFrontmatter(content: string): Record<string, unknown> {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};

	const yaml = match[1];
	const result: Record<string, unknown> = {};

	for (const line of yaml.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let value: unknown = line.slice(colonIdx + 1).trim();

		// Handle arrays like: tags: [a, b, c] or tags: ["a", "b"]
		if (typeof value === "string" && value.startsWith("[")) {
			value = value
				.slice(1, -1)
				.split(",")
				.map((s) => s.trim().replace(/^["']|["']$/g, ""));
		}
		// Strip quotes from strings
		if (typeof value === "string") {
			value = value.replace(/^["']|["']$/g, "");
		}

		result[key] = value;
	}

	return result;
}

function extractWikilinks(content: string): string[] {
	// Strip frontmatter before scanning
	const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
	const links: string[] = [];
	for (const match of body.matchAll(WIKILINK_RE)) {
		const resolved = resolveSlug(match[1]);
		if (resolved) links.push(resolved);
	}
	return [...new Set(links)];
}

export function buildContentIndex(docsDir: string, blogDir: string): ContentIndex {
	const index: Record<string, ContentNode> = {};

	// Discover all doc slugs first
	DOC_SLUGS.clear();
	BLOG_SLUGS.clear();

	const docFiles = readdirSync(docsDir).filter((f) => f.endsWith(".md"));
	for (const file of docFiles) {
		DOC_SLUGS.add(file.replace(/\.md$/, "").toLowerCase());
	}

	const blogFiles = readdirSync(blogDir).filter((f) => f.endsWith(".mdx"));
	for (const file of blogFiles) {
		BLOG_SLUGS.add(file.replace(/\.mdx$/, ""));
	}

	// Process docs
	for (const file of docFiles) {
		const slug = file.replace(/\.md$/, "").toLowerCase();
		const content = readFileSync(join(docsDir, file), "utf-8");
		const fm = extractFrontmatter(content);
		const title = (fm.title as string) ?? slug;
		const links = extractWikilinks(content);

		index[`docs/${slug}`] = {
			title,
			url: `/docs/${slug}/`,
			tags: [],
			links,
			collection: "docs",
		};
	}

	// Process blog posts
	for (const file of blogFiles) {
		const slug = file.replace(/\.mdx$/, "");
		const content = readFileSync(join(blogDir, file), "utf-8");
		const fm = extractFrontmatter(content);
		const title = (fm.title as string) ?? slug;
		const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
		const links = extractWikilinks(content);

		index[`blog/${slug}`] = {
			title,
			url: `/blog/${slug}/`,
			tags,
			links,
			collection: "blog",
		};
	}

	return index;
}
