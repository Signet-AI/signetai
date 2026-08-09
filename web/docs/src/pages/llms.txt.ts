import { getCollection } from "astro:content";
import type { APIContext } from "astro";

export const prerender = true;

function routeFor(id: string): string {
	return id === "index" ? "/" : `/${id.replace(/\/index$/, "")}/`;
}

export async function GET(context: APIContext): Promise<Response> {
	const site = context.site?.toString().replace(/\/$/, "") ?? "https://docs.signetai.sh";
	const docs = await getCollection("docs");
	const lines = [
		"# Signet documentation",
		"",
		"> Install, use, operate, and extend Signet.",
		"",
		`Full documentation: ${site}/llms-full.txt`,
		"",
		"## Pages",
		"",
	];
	for (const doc of docs.sort((a, b) => a.data.title.localeCompare(b.data.title))) {
		const description = doc.data.description ? `: ${doc.data.description}` : "";
		lines.push(`- [${doc.data.title}](${site}${routeFor(doc.id)})${description}`);
	}
	return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
