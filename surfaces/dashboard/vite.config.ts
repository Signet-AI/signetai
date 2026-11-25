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
const bundledModules = new Set<string>();
const collectBundledModules = (): Plugin => ({
	name: "signet-collect-shipped-modules",
	apply: "build",
	generateBundle(_, bundle) {
		for (const output of Object.values(bundle)) {
			if (output.type === "chunk") for (const id of Object.keys(output.modules)) bundledModules.add(id);
		}
		for (const file of this.getWatchFiles()) if (file.endsWith(".css")) bundledModules.add(file);
	},
});
const recordBundledPackages: Plugin = {
	...collectBundledModules(),
	name: "signet-record-shipped-packages",
	closeBundle() {
		recordShippedPackages("dashboard", packagesFromFiles(bundledModules, __dirname));
	},
};

export default defineConfig(({ command, mode }) => ({
	define: {
		"import.meta.env.VITE_ONBOARDING_PREVIEW": JSON.stringify(command === "serve" && mode === "onboarding"),
	},
	plugins: [react(), tailwindcss(), recordBundledPackages],
	worker: {
		plugins: () => [collectBundledModules()],
	},
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
