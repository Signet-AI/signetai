import { type CollectionEntry, render } from "astro:content";

export interface SearchItem {
	readonly title: string;
	readonly description: string;
	readonly section: string;
	readonly sectionTitle: string;
	readonly slug: string;
	readonly url: string;
	readonly excerpt: string;
}

interface HeadingSlice {
	readonly depth: number;
	readonly text: string;
	readonly start: number;
	readonly end: number;
}

function maskFencedCode(content: string): string {
	return content.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));
}

function toSlug(id: string): string {
	return id.replace(/\.md$/, "").toLowerCase();
}

function normalizeText(content: string): string {
	return content
		.replace(/^---[\s\S]*?---/, "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]+`/g, " ")
		.replace(/^#+\s+.*/gm, " ")
		.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_full, rawSlug: string, displayText?: string) => {
			return displayText ?? rawSlug.replace(/^(docs|blog)\//, "").replace(/-/g, " ");
		})
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/[*_~>#-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function excerpt(content: string, limit = 240): string {
	return normalizeText(content).slice(0, limit);
}

function headingSlices(body: string): HeadingSlice[] {
	const masked = maskFencedCode(body);
	const matches = [...masked.matchAll(/^(##|###)\s+(.+)$/gm)];
	return matches.map((match, index) => ({
		depth: match[1].length,
		text: match[2].trim(),
		start: match.index ?? 0,
		end: index < matches.length - 1 ? (matches[index + 1].index ?? body.length) : body.length,
	}));
}

export async function buildDocSearchItems(doc: CollectionEntry<"docs">): Promise<SearchItem[]> {
	const slug = toSlug(doc.id);
	const { headings } = await render(doc);
	const tocHeadings = headings.filter((heading) => heading.depth === 2 || heading.depth === 3);
	const slices = headingSlices(doc.body);

	if (tocHeadings.length === 0 || tocHeadings.length !== slices.length) {
		return [
			{
				title: doc.data.title,
				description: doc.data.description ?? "",
				section: doc.data.section ?? "",
				sectionTitle: "",
				slug,
				url: `/docs/${slug}/`,
				excerpt: excerpt(doc.body, 300),
			},
		];
	}

	return tocHeadings.map((heading, index) => {
		const slice = slices[index];
		const body = doc.body.slice(slice.start, slice.end);
		return {
			title: doc.data.title,
			description: doc.data.description ?? "",
			section: doc.data.section ?? "",
			sectionTitle: heading.text,
			slug: `${slug}#${heading.slug}`,
			url: `/docs/${slug}/#${heading.slug}`,
			excerpt: excerpt(body),
		};
	});
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
			excerpt: excerpt(post.body, 300),
		},
	];
}
