/**
 * Build-time blog graph index.
 *
 * Standard Markdown links between blog posts become edges in the local
 * graph viewer. Public documentation is indexed and searched by Starlight.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BLOG_LINK_RE = /\]\(\/blog\/([^/)#]+)\/?(?:#[^)]*)?\)/g;

export interface ContentNode {
	readonly title: string;
	readonly url: string;
	readonly tags: readonly string[];
	readonly links: readonly string[];
	readonly collection: "blog";
}

export type ContentIndex = Record<string, ContentNode>;

function extractFrontmatter(content: string): Record<string, unknown> {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match?.[1]) return {};
	const result: Record<string, unknown> = {};
	for (const line of match[1].split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		let value: unknown = line.slice(colon + 1).trim();
		if (typeof value === "string" && value.startsWith("[")) {
			value = value
				.slice(1, -1)
				.split(",")
				.map((item) => item.trim().replace(/^["']|["']$/g, ""));
		}
		if (typeof value === "string") value = value.replace(/^["']|["']$/g, "");
		result[key] = value;
	}
	return result;
}

function extractBlogLinks(content: string, slugs: ReadonlySet<string>): readonly string[] {
	const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
	const links: string[] = [];
	let match = BLOG_LINK_RE.exec(body);
	while (match) {
		const slug = match[1];
		if (slug && slugs.has(slug)) links.push(`blog/${slug}`);
		match = BLOG_LINK_RE.exec(body);
	}
	return [...new Set(links)];
}

export function buildContentIndex(blogDir: string): ContentIndex {
	const index: ContentIndex = {};
	const files = readdirSync(blogDir)
		.filter((file) => file.endsWith(".mdx"))
		.sort();
	const slugs = new Set(files.map((file) => file.replace(/\.mdx$/, "")));
	for (const file of files) {
		const slug = file.replace(/\.mdx$/, "");
		const content = readFileSync(join(blogDir, file), "utf8");
		const frontmatter = extractFrontmatter(content);
		index[`blog/${slug}`] = {
			title: typeof frontmatter.title === "string" ? frontmatter.title : slug,
			url: `/blog/${slug}/`,
			tags: Array.isArray(frontmatter.tags)
				? frontmatter.tags.filter((tag): tag is string => typeof tag === "string")
				: [],
			links: extractBlogLinks(content, slugs),
			collection: "blog",
		};
	}
	return index;
}
