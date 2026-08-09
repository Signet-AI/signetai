import { getCollection } from "astro:content";
import type { APIContext } from "astro";
import { type SearchItem, buildBlogSearchItems } from "../lib/search-index";

export const prerender = true;

const SITE_ITEMS: readonly SearchItem[] = [
	{
		title: "SignetAI",
		description: "Local-first memory and secrets for AI agents.",
		section: "Site",
		sectionTitle: "Home",
		slug: "home",
		url: "/",
		excerpt: "Install Signet, connect a harness, and give AI agents durable memory, identity, sources, and secrets.",
	},
	{
		title: "How Signet works",
		description: "The architecture behind durable context selection.",
		section: "Site",
		sectionTitle: "Product",
		slug: "how-it-works",
		url: "/how-it-works/",
		excerpt:
			"Raw-first storage, background distillation, knowledge graphs, hybrid recall, and bounded context selection.",
	},
	{
		title: "Benchmarks",
		description: "Signet memory and retrieval benchmark results.",
		section: "Site",
		sectionTitle: "Product",
		slug: "benchmarks",
		url: "/benchmarks/",
		excerpt: "Measured retrieval accuracy, hit rate, methodology, and benchmark reports.",
	},
	{
		title: "Join the community",
		description: "Join Signet users and contributors.",
		section: "Site",
		sectionTitle: "Community",
		slug: "join",
		url: "/join/",
		excerpt: "Discord, GitHub, and community links for Signet users and contributors.",
	},
];

export async function GET(_context: APIContext): Promise<Response> {
	const blog = await getCollection("blog");
	const blogIndex = blog.filter((post) => !post.data.draft).flatMap(buildBlogSearchItems);
	return new Response(JSON.stringify([...SITE_ITEMS, ...blogIndex]), {
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}
