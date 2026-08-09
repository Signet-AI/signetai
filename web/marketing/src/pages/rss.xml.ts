import { getCollection } from "astro:content";
import rss from "@astrojs/rss";
import type { APIContext } from "astro";

export const prerender = true;

export async function GET(context: APIContext): Promise<Response> {
	const blog = await getCollection("blog");
	const items = blog
		.filter((post) => !post.data.draft)
		.map((post) => ({
			title: post.data.title,
			description: post.data.description,
			link: `/blog/${post.id}/`,
			pubDate: post.data.date,
		}))
		.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
	return rss({
		title: "SignetAI Blog",
		description: "Writing about durable memory, context selection, and infrastructure for AI agents.",
		site: context.site?.toString() ?? "https://signetai.sh",
		items,
		customData: "<language>en-us</language>",
	});
}
