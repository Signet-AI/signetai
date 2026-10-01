import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonProxyTarget = process.env.SIGNET_DAEMON_URL ?? "http://127.0.0.1:3850";
export default defineConfig(({ command, mode }) => ({
	define: {
		"import.meta.env.VITE_ONBOARDING_PREVIEW": JSON.stringify(command === "serve" && mode === "onboarding"),
	},
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
}));
