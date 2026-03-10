import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import graphIndex from "./src/integrations/graph-index";
import remarkWikilinks from "./src/lib/remark-wikilinks";

export default defineConfig({
	output: "static",
	site: "https://signetai.sh",
	markdown: {
		remarkPlugins: [remarkWikilinks],
	},
	integrations: [
		mdx(),
		react(),
		sitemap({
			serialize(item) {
				item.lastmod = new Date();
				return item;
			},
		}),
		graphIndex(),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
