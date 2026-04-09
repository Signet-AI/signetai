import { getCollection } from "astro:content";
import type { APIContext } from "astro";
import { buildBlogSearchItems, buildDocSearchItems } from "../lib/search-index";

export const prerender = true;

export async function GET(_context: APIContext) {
	const docs = await getCollection("docs");
	const blog = await getCollection("blog");

	const docIndex = (await Promise.all(docs.filter((doc) => doc.data.title).map(buildDocSearchItems))).flat();

	const blogIndex = blog.filter((post) => !post.data.draft).flatMap(buildBlogSearchItems);

	const index = [...docIndex, ...blogIndex];

	return new Response(JSON.stringify(index), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}
