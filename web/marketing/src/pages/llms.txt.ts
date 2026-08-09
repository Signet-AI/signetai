import { getCollection } from "astro:content";
import type { APIContext } from "astro";

export const prerender = true;

export async function GET(context: APIContext): Promise<Response> {
	const site = context.site?.toString().replace(/\/$/, "") ?? "https://signetai.sh";
	const blog = await getCollection("blog");
	const lines: string[] = [
		"# SignetAI",
		"",
		"> Local-first memory and secrets for AI agents. Portable across models and harnesses.",
		"",
		"## Pages",
		"",
		`- [Home](${site}/)`,
		`- [How Signet works](${site}/how-it-works/)`,
		`- [Benchmarks](${site}/benchmarks/)`,
		"- [Documentation](https://docs.signetai.sh/)",
		"- [Full documentation for LLMs](https://docs.signetai.sh/llms-full.txt)",
	];
	const posts = blog.filter((post) => !post.data.draft).sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
	if (posts.length > 0) {
		lines.push("", "## Blog", "");
		for (const post of posts) lines.push(`- [${post.data.title}](${site}/blog/${post.id}/): ${post.data.description}`);
	}
	return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
