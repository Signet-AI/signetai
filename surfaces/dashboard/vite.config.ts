import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dashboard build contract (issue #948):
// - Emits to `build/index.html` (+ hashed assets under build/assets).
// - `base: "/"` resolves under both the daemon (http://host/) and the Electron
//   privileged scheme (app://signet/) since both map root-relative paths to the
//   dashboard root with SPA fallback to index.html.
// - Do not change `build.outDir`; scripts/prepare-dashboard-bundle.ts,
//   platform/daemon/src/routes/dashboard.ts and surfaces/desktop/src/main.ts
//   all key off `surfaces/dashboard/build/index.html`.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	build: {
		outDir: "build",
		sourcemap: false,
	},
});
