import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type Plugin, type ProxyOptions, defineConfig } from "vite";
import { packagesFromFiles, recordShippedPackages } from "../../scripts/shipped-packages";

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
const recordBundledPackages: Plugin = {
	name: "signet-record-shipped-packages",
	apply: "build",
	generateBundle(_, bundle) {
		const modules = Object.values(bundle).flatMap((output) =>
			output.type === "chunk" ? Object.keys(output.modules) : [],
		);
		recordShippedPackages("dashboard", packagesFromFiles(modules, __dirname));
	},
};

export default defineConfig(({ command, mode }) => ({
	define: {
		"import.meta.env.VITE_ONBOARDING_PREVIEW": JSON.stringify(command === "serve" && mode === "onboarding"),
	},
	plugins: [react(), tailwindcss(), recordBundledPackages],
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
