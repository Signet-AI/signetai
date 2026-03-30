import { getCollection } from "astro:content";
import type { APIContext } from "astro";

export const prerender = true;

export async function GET(_context: APIContext) {
	const docs = await getCollection("docs");
	const blog = await getCollection("blog");

	const docIndex = docs
		.filter((doc) => doc.data.title)
		.map((doc) => {
			const slug = doc.id.replace(/\.md$/, "").toLowerCase();
			const excerpt = doc.body
				? doc.body
						.replace(/^---[\s\S]*?---/, "")
						.replace(/^#+\s+.*/gm, "")
						.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
						.replace(/[*_`~]/g, "")
						.trim()
						.slice(0, 300)
				: "";

			return {
				type: "doc" as const,
				title: doc.data.title,
				description: doc.data.description ?? "",
				section: doc.data.section ?? "",
				slug,
				url: `/docs/${slug}/`,
				excerpt,
			};
		});

	const blogIndex = blog
		.filter((post) => !post.data.draft)
		.map((post) => {
			const excerpt = post.body
				? post.body
						.replace(/^---[\s\S]*?---/, "")
						.replace(/^#+\s+.*/gm, "")
						.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
						.replace(/[*_`~]/g, "")
						.trim()
						.slice(0, 300)
				: "";

			return {
				type: "blog" as const,
				title: post.data.title,
				description: post.data.description,
				section: "",
				slug: post.id,
				url: `/blog/${post.id}/`,
				excerpt,
			};
		});

	const index = [...docIndex, ...blogIndex];

	return new Response(JSON.stringify(index), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}
