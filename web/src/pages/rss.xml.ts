import { readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCollection } from "astro:content";
import rss from "@astrojs/rss";
import type { APIContext } from "astro";

export const prerender = true;

const thisDir = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(thisDir, "../../../docs");

// Build a lookup from lowercase-no-ext ID to actual file path
function buildFileIndex(dir: string, base: string = dir): Map<string, string> {
	const map = new Map<string, string>();
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory() && entry.name !== "wip") {
			for (const [k, v] of buildFileIndex(resolve(dir, entry.name), base)) {
				map.set(k, v);
			}
		} else if (entry.name.endsWith(".md")) {
			const fullPath = resolve(dir, entry.name);
			const rel = fullPath.slice(base.length + 1);
			const id = rel.replace(/\.md$/, "").toLowerCase();
			map.set(id, fullPath);
		}
	}
	return map;
}

const fileIndex = buildFileIndex(docsDir);

function getFileMtime(docId: string): Date {
	const filePath = fileIndex.get(docId);
	if (filePath) {
		try {
			return statSync(filePath).mtime;
		} catch {
			// fall through
		}
	}
	return new Date();
}

export async function GET(context: APIContext) {
	const docs = await getCollection("docs");
	const blog = await getCollection("blog");

	const docItems = docs
		.filter((doc) => doc.data.title && doc.id !== "readme")
		.map((doc) => {
			const slug = doc.id.replace(/\.md$/, "").toLowerCase();
			return {
				title: doc.data.title,
				description: doc.data.description ?? `Signet documentation: ${doc.data.title}`,
				link: `/docs/${slug}/`,
				pubDate: getFileMtime(doc.id),
			};
		});

	const blogItems = blog
		.filter((post) => !post.data.draft)
		.map((post) => ({
			title: post.data.title,
			description: post.data.description,
			link: `/blog/${post.id}/`,
			pubDate: post.data.date,
		}));

	const items = [...docItems, ...blogItems].sort((a, b) => (b.pubDate?.getTime() ?? 0) - (a.pubDate?.getTime() ?? 0));

	return rss({
		title: "SignetAI",
		description:
			"Signet is local-first agent infrastructure. Portable memory, encrypted secrets, and identity that lives on your machine.",
		site: context.site?.toString() ?? "https://signetai.sh",
		items,
		customData: "<language>en-us</language>",
	});
}
