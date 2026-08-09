/** Generate the marketing blog graph index at build time. */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AstroIntegration } from "astro";
import { buildContentIndex } from "../lib/content-graph";

export default function graphIndex(): AstroIntegration {
	return {
		name: "graph-index",
		hooks: {
			"astro:config:setup"({ config, logger }) {
				const root = config.root ? new URL(config.root).pathname : process.cwd();
				const blog = resolve(root, "src", "content", "blog");
				const output = resolve(root, "public", "contentIndex.json");
				const index = buildContentIndex(blog);
				const links = Object.values(index).reduce((sum, node) => sum + node.links.length, 0);
				writeFileSync(output, JSON.stringify(index, null, 2));
				logger.info(`graph-index: ${Object.keys(index).length} posts, ${links} links`);
			},
		},
	};
}
