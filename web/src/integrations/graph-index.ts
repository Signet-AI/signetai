/**
 * Astro integration that generates contentIndex.json at build time.
 *
 * Scans all docs and blog posts for [[wikilinks]] and writes a JSON
 * graph index to public/contentIndex.json for the client-side graph viewer.
 */

import type { AstroIntegration } from "astro";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildContentIndex } from "../lib/content-graph";

export default function graphIndex(): AstroIntegration {
	return {
		name: "graph-index",
		hooks: {
			"astro:config:setup"({ config, logger }) {
				// Generate the index early so it's available during dev and build
				const root = config.root ? new URL(config.root).pathname : process.cwd();
				generateIndex(root, logger);
			},
		},
	};
}

function generateIndex(root: string, logger: { info(msg: string): void }) {
	const docsDir = resolve(root, "..", "docs");
	const blogDir = resolve(root, "src", "content", "blog");
	const outPath = resolve(root, "public", "contentIndex.json");

	const index = buildContentIndex(docsDir, blogDir);
	const nodeCount = Object.keys(index).length;
	const linkCount = Object.values(index).reduce((sum, n) => sum + n.links.length, 0);

	writeFileSync(outPath, JSON.stringify(index, null, 2));
	logger.info(`graph-index: ${nodeCount} nodes, ${linkCount} edges → public/contentIndex.json`);
}
