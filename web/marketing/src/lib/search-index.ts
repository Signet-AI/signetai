import type { CollectionEntry } from "astro:content";

export interface SearchItem {
	readonly title: string;
	readonly description: string;
	readonly section: string;
	readonly sectionTitle: string;
	readonly slug: string;
	readonly url: string;
	readonly excerpt: string;
}

function normalizeText(content: string): string {
	return content
		.replace(/^---[\s\S]*?---/, "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]+`/g, " ")
		.replace(/^#+\s+.*/gm, " ")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/[*_~>#-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function buildBlogSearchItems(post: CollectionEntry<"blog">): SearchItem[] {
	return [
		{
			title: post.data.title,
			description: post.data.description,
			section: "Blog",
			sectionTitle: "",
			slug: post.id,
			url: `/blog/${post.id}/`,
			excerpt: normalizeText(post.body).slice(0, 300),
		},
	];
}
