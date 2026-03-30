import { getCollection } from "astro:content";
import type { APIContext } from "astro";

export const prerender = true;

export async function GET(context: APIContext) {
	const site = context.site?.toString().replace(/\/$/, "") ?? "https://signetai.sh";
	const docs = await getCollection("docs");
	const blog = await getCollection("blog");

	const sorted = [...docs]
		.filter((doc) => doc.data.title)
		.sort((a, b) => (a.data.order ?? 999) - (b.data.order ?? 999));

	const sections: string[] = [
		"# SignetAI — Full Documentation",
		"",
		"> Signet is local-first agent infrastructure. Portable memory, encrypted secrets, and identity that lives on your machine — not locked inside someone else's API.",
		"",
		`Source: ${site}`,
		"",
		"---",
		"",
	];

	for (const doc of sorted) {
		const slug = doc.id.replace(/\.md$/, "").toLowerCase();

		// Use the raw body if available, otherwise note it
		if (doc.body) {
			sections.push(`## ${doc.data.title}`);
			sections.push(`URL: ${site}/docs/${slug}/`);
			sections.push("");
			sections.push(doc.body);
			sections.push("");
			sections.push("---");
			sections.push("");
		}
	}

	const blogPosts = [...blog]
		.filter((post) => !post.data.draft)
		.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());

	if (blogPosts.length > 0) {
		sections.push("# Blog");
		sections.push("");

		for (const post of blogPosts) {
			sections.push(`## ${post.data.title}`);
			sections.push(`URL: ${site}/blog/${post.id}/`);
			sections.push(`Date: ${post.data.date.toISOString().slice(0, 10)}`);
			sections.push(`Author: ${post.data.author}`);
			sections.push("");
			if (post.body) {
				sections.push(post.body);
			}
			sections.push("");
			sections.push("---");
			sections.push("");
		}
	}

	return new Response(sections.join("\n"), {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}
