import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
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
