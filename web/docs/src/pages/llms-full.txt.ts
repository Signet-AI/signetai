import { getCollection } from "astro:content";
import type { APIContext } from "astro";

export const prerender = true;

function routeFor(id: string): string {
	return id === "index" ? "/" : `/${id.replace(/\/index$/, "")}/`;
}

export async function GET(context: APIContext): Promise<Response> {
	const site = context.site?.toString().replace(/\/$/, "") ?? "https://docs.signetai.sh";
	const docs = await getCollection("docs");
	const sections = ["# Signet documentation", "", "> Install, use, operate, and extend Signet.", ""];
	for (const doc of docs.sort((a, b) => a.data.title.localeCompare(b.data.title))) {
		sections.push(`## ${doc.data.title}`);
		sections.push(`URL: ${site}${routeFor(doc.id)}`, "");
		if (doc.body) sections.push(doc.body.trim());
		sections.push("", "---", "");
	}
	return new Response(sections.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
