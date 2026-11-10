import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type ProxyOptions, defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonProxyTarget = process.env.SIGNET_DAEMON_URL ?? "http://127.0.0.1:3850";
const daemonProxy: ProxyOptions = {
	target: daemonProxyTarget,
	changeOrigin: true,
	configure: (proxy) => {
		proxy.on("proxyReq", (proxyReq, req) => {
			const origin = req.headers.origin;
			if (origin === undefined || req.headers.host === undefined) return;
			try {
				if (new URL(origin).host === req.headers.host) proxyReq.removeHeader("origin");
			} catch {}
		});
	},
};
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
			"/api": daemonProxy,
			"/health": daemonProxy,
			"/memory": daemonProxy,
		},
	},
	build: {
		outDir: "build",
		sourcemap: false,
	},
}));
