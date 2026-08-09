import { getCollection } from "astro:content";
import type { APIContext } from "astro";

export const prerender = true;

export async function GET(context: APIContext): Promise<Response> {
	const site = context.site?.toString().replace(/\/$/, "") ?? "https://signetai.sh";
	const blog = await getCollection("blog");
	const sections: string[] = [
		"# SignetAI",
		"",
		"> Local-first memory and secrets for AI agents. Portable across models and harnesses.",
		"",
		`Website: ${site}`,
		"Documentation: https://docs.signetai.sh/",
		"Full documentation: https://docs.signetai.sh/llms-full.txt",
		"",
		"---",
		"",
		"# Blog",
		"",
	];
	const posts = blog.filter((post) => !post.data.draft).sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
	for (const post of posts) {
		sections.push(`## ${post.data.title}`);
		sections.push(`URL: ${site}/blog/${post.id}/`);
		sections.push(`Date: ${post.data.date.toISOString().slice(0, 10)}`);
		sections.push(`Author: ${post.data.author}`, "");
		if (post.body) sections.push(post.body);
		sections.push("", "---", "");
	}
	return new Response(sections.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
