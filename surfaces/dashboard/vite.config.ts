import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOOPBACK_HOST } from "@signet/core";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonProxyTarget = process.env.SIGNET_DAEMON_URL ?? `http://${LOOPBACK_HOST}:3850`;
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		proxy: {
			"/api": daemonProxyTarget,
			"/health": daemonProxyTarget,
			"/memory": daemonProxyTarget,
		},
	},
	build: {
		outDir: "build",
		sourcemap: false,
	},
});
