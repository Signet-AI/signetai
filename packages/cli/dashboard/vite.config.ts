import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		proxy: {
			"/api": "http://localhost:3850",
			"/health": "http://localhost:3850",
			"/memory": "http://localhost:3850",
		},
	},
	resolve: {
		alias: {
			"@signet/core/pipeline-providers": resolve(
				root,
				"../../core/src/pipeline-providers.ts",
			),
		},
	},
	build: {
		chunkSizeWarningLimit: 1200,
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (!id.includes("node_modules")) return;

					if (
						id.includes("/three-forcegraph/") ||
						id.includes("/three-spritetext/")
					) {
						return "vendor-forcegraph3d";
					}

					if (id.includes("/3d-force-graph/") || id.includes("/three-render-objects/")) {
						return "vendor-3d-force";
					}

					if (id.includes("/three/")) {
						return "vendor-three";
					}

					if (id.includes("/d3-force/")) {
						return "vendor-embeddings-2d";
					}

					if (
						id.includes("/@codemirror/view/") ||
						id.includes("/@codemirror/state/") ||
						id.includes("/@codemirror/commands/") ||
						id.includes("/@codemirror/search/") ||
						id.includes("/@codemirror/lang-") ||
						id.includes("/@codemirror/autocomplete/") ||
						id.includes("/@codemirror/language/") ||
						id.includes("/@lezer/") ||
						id.includes("/codemirror/")
					) {
						return "vendor-codemirror";
					}

					if (id.includes("/bits-ui/") || id.includes("/svelte-sonner/")) {
						return "vendor-ui";
					}

					if (id.includes("/yaml/") || id.includes("/marked/")) {
						return "vendor-utils";
					}
				},
			},
		},
	},
});
