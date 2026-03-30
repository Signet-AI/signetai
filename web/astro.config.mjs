import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import remarkWikilinks from "./src/lib/remark-wikilinks";
import graphIndex from "./src/integrations/graph-index";

export default defineConfig({
	output: "static",
	site: "https://signetai.sh",
	markdown: {
		remarkPlugins: [remarkWikilinks],
	},
	integrations: [mdx(), react(), sitemap(), graphIndex()],
	vite: {
		plugins: [tailwindcss()],
	},
});
