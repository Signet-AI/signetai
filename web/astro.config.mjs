import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import graphIndex from "./src/integrations/graph-index";
import remarkMarkdownLinks from "./src/lib/remark-markdown-links";
import remarkWikilinks from "./src/lib/remark-wikilinks";

export default defineConfig({
	output: "static",
	site: "https://signetai.sh",
	markdown: {
		remarkPlugins: [remarkMarkdownLinks, remarkWikilinks],
		shikiConfig: {
			themes: {
				light: "github-light",
				dark: "github-dark",
			},
			defaultColor: "dark",
		},
	},
	integrations: [mdx(), react(), sitemap(), graphIndex()],
	vite: {
		plugins: [tailwindcss()],
	},
});
