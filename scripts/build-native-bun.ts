#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(import.meta.dir, "..");
const outDir = join(root, "dist", "native");
const buildDir = join(root, ".native-build");
const workerDir = join(buildDir, "workers");
const platformKey = process.env.SIGNET_NATIVE_PLATFORM ?? `${platform()}-${arch()}`;
const binaryName = platform() === "win32" ? `signet-${platformKey}.exe` : `signet-${platformKey}`;
const outfile = join(outDir, binaryName);

mkdirSync(outDir, { recursive: true });
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(workerDir, { recursive: true });

function runBunBuild(args: readonly string[]): void {
	const result = spawnSync("bun", ["build", ...args], {
		cwd: root,
		stdio: "inherit",
		windowsHide: true,
	});
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

function contentTypeFor(path: string): string {
	if (path.endsWith(".html")) return "text/html; charset=utf-8";
	if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
	if (path.endsWith(".css")) return "text/css; charset=utf-8";
	if (path.endsWith(".json")) return "application/json; charset=utf-8";
	if (path.endsWith(".svg")) return "image/svg+xml";
	if (path.endsWith(".png")) return "image/png";
	if (path.endsWith(".ico")) return "image/x-icon";
	if (path.endsWith(".webp")) return "image/webp";
	if (path.endsWith(".woff2")) return "font/woff2";
	if (path.endsWith(".otf")) return "font/otf";
	return "application/octet-stream";
}

function walkFiles(dir: string): string[] {
	return readdirSync(dir)
		.flatMap((name) => {
			const path = join(dir, name);
			const stat = statSync(path);
			return stat.isDirectory() ? walkFiles(path) : stat.isFile() ? [path] : [];
		})
		.sort();
}

const dashboardDir = join(root, "surfaces", "dashboard", "build");
if (!existsSync(join(dashboardDir, "index.html"))) {
	throw new Error(
		`Dashboard build is missing at ${dashboardDir}. Run bun run build:dashboard before build:native-bun.`,
	);
}

const workerEntries = [
	["synthesis-render-worker", "platform/daemon/src/synthesis-render-worker.ts"],
	["extraction-thread", "platform/daemon/src/pipeline/extraction-thread.ts"],
] as const;
const nativeExternalArgs = ["--external", "better-sqlite3", "--external", "@1password/sdk"] as const;

for (const [name, entry] of workerEntries) {
	runBunBuild([
		"--target=bun",
		"--format=cjs",
		"--outfile",
		join(workerDir, `${name}.cjs`),
		...nativeExternalArgs,
		entry,
	]);
}

const dashboardAssets = walkFiles(dashboardDir).map((path) => {
	const relative = path.slice(dashboardDir.length).replaceAll("\\", "/");
	return {
		path: relative.startsWith("/") ? relative : `/${relative}`,
		contentType: contentTypeFor(path),
		contentBase64: readFileSync(path).toString("base64"),
	};
});

const workerAssets = workerEntries.map(([name]) => ({
	name,
	contentBase64: readFileSync(join(workerDir, `${name}.cjs`)).toString("base64"),
}));
const transformersPackageJson = fileURLToPath(import.meta.resolve("@huggingface/transformers/package.json"));
const transformersDir = dirname(transformersPackageJson);
const transformersWebRuntimePath = join(transformersDir, "dist", "transformers.web.js");
const wasmAssets = ["ort-wasm-simd-threaded.jsep.wasm"].map((name) => ({
	name,
	contentBase64: readFileSync(join(transformersDir, "dist", name)).toString("base64"),
}));

writeFileSync(
	join(buildDir, "native-assets.ts"),
	`export const dashboardAssets = ${JSON.stringify(dashboardAssets)} as const;\n` +
		`export const workerAssets = ${JSON.stringify(workerAssets)} as const;\n` +
		`export const wasmAssets = ${JSON.stringify(wasmAssets)} as const;\n`,
);

writeFileSync(
	join(buildDir, "transformers-web-runtime.ts"),
	`export { env, pipeline } from ${JSON.stringify(transformersWebRuntimePath)};\n`,
);

writeFileSync(
	join(buildDir, "cli-native.ts"),
	`import { registerNativeAssets, registerNativeTransformersBindings } from "../platform/daemon/src/native-runtime-assets";\n` +
		`import { dashboardAssets, wasmAssets, workerAssets } from "./native-assets";\n` +
		`import * as transformersWebRuntime from "./transformers-web-runtime";\n\n` +
		"registerNativeAssets({ dashboard: dashboardAssets, workers: workerAssets, wasm: wasmAssets });\n" +
		"registerNativeTransformersBindings(transformersWebRuntime);\n" +
		`await import("../surfaces/cli/src/cli.ts");\n`,
);

runBunBuild(["--compile", "--target=bun", "--outfile", outfile, ...nativeExternalArgs, ".native-build/cli-native.ts"]);

console.log(`Built native Bun executable: ${outfile}`);

if (!process.env.SIGNET_NATIVE_PLATFORM) {
	const localName = platform() === "win32" ? "signet.exe" : "signet";
	const localPath = join(outDir, localName);
	copyFileSync(outfile, localPath);
	if (platform() !== "win32") chmodSync(localPath, 0o755);
	console.log(`Updated local smoke binary: ${localPath}`);
}
