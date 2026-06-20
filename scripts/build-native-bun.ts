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
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const outDir = join(root, "dist", "native");
const buildDir = join(root, ".native-build");
const workerDir = join(buildDir, "workers");
const platformKey = process.env.SIGNET_NATIVE_PLATFORM ?? `${platform()}-${arch()}`;
const binaryName = platformKey.startsWith("win32-") ? `signet-${platformKey}.exe` : `signet-${platformKey}`;
const outfile = join(outDir, binaryName);
const daemonRequire = createRequire(join(root, "platform", "daemon", "package.json"));
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
const nativeVersion = typeof rootPackage.version === "string" ? rootPackage.version : "0.0.0";

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

function compileTargetFor(targetPlatform: string): string {
	switch (targetPlatform) {
		case "linux-x64":
			return "bun-linux-x64";
		case "linux-arm64":
			return "bun-linux-arm64";
		case "darwin-x64":
			return "bun-darwin-x64";
		case "darwin-arm64":
			return "bun-darwin-arm64";
		case "win32-x64":
			return "bun-windows-x64";
		default:
			throw new Error(`Unsupported native compile platform: ${targetPlatform}`);
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
const templatesDir = join(root, "surfaces", "cli", "templates");
const skillsDir = join(root, "skills");

const workerEntries = [
	["synthesis-render-worker", "platform/daemon/src/synthesis-render-worker.ts"],
	["extraction-thread", "platform/daemon/src/pipeline/extraction-thread.ts"],
] as const;
const nativeExternalArgs = ["--external", "better-sqlite3"] as const;

for (const [name, entry] of workerEntries) {
	runBunBuild([
		"--target=bun",
		"--format=esm",
		"--outfile",
		join(workerDir, `${name}.mjs`),
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
const fileAssetsFor = (dir: string) =>
	walkFiles(dir).map((path) => {
		const relative = path.slice(dir.length).replaceAll("\\", "/");
		return {
			path: relative.startsWith("/") ? relative.slice(1) : relative,
			contentBase64: readFileSync(path).toString("base64"),
			mode: statSync(path).mode & 0o777,
		};
	});
const templateAssets = fileAssetsFor(templatesDir);
const skillAssets = fileAssetsFor(skillsDir);

const workerAssets = workerEntries.map(([name]) => ({
	name,
	contentBase64: readFileSync(join(workerDir, `${name}.mjs`)).toString("base64"),
}));
const transformersPackageJson = daemonRequire.resolve("@huggingface/transformers/package.json");
const transformersDir = dirname(transformersPackageJson);
const transformersWebRuntimePath = join(transformersDir, "dist", "transformers.web.js");
const wasmAssets = ["ort-wasm-simd-threaded.jsep.wasm"].map((name) => ({
	name,
	contentBase64: readFileSync(join(transformersDir, "dist", name)).toString("base64"),
}));

writeFileSync(
	join(buildDir, "native-assets.ts"),
	`export const dashboardAssets = ${JSON.stringify(dashboardAssets)} as const;\n` +
		`export const skillAssets = ${JSON.stringify(skillAssets)} as const;\n` +
		`export const templateAssets = ${JSON.stringify(templateAssets)} as const;\n` +
		`export const workerAssets = ${JSON.stringify(workerAssets)} as const;\n` +
		`export const wasmAssets = ${JSON.stringify(wasmAssets)} as const;\n`,
);

writeFileSync(
	join(buildDir, "transformers-web-runtime.ts"),
	`export { env, pipeline } from ${JSON.stringify(transformersWebRuntimePath)};\n`,
);

writeFileSync(
	join(buildDir, "cli-native.ts"),
	`import { materializeEmbeddedAssetTree, registerNativeAssets, registerNativeTransformersBindings } from "../platform/daemon/src/native-runtime-assets";
import { dashboardAssets, skillAssets, templateAssets, wasmAssets, workerAssets } from "./native-assets";
import * as transformersWebRuntime from "./transformers-web-runtime";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

registerNativeAssets({ dashboard: dashboardAssets, skills: skillAssets, templates: templateAssets, workers: workerAssets, wasm: wasmAssets });
registerNativeTransformersBindings(transformersWebRuntime);
process.env.SIGNET_VERSION = process.env.SIGNET_VERSION?.trim() || ${JSON.stringify(nativeVersion)};
process.env.SIGNET_TEMPLATES_DIR ??= materializeEmbeddedAssetTree("templates") ?? "";
process.env.SIGNET_SKILLS_SOURCE ??= materializeEmbeddedAssetTree("skills") ?? "";

// When the binary is invoked directly (curl-install + signet install,
// raw binary from PATH) without a parent process setting SIGNET_DIR,
// fall back to the binary's own install root so connector plugins
// extracted to \`<install-root>/runtime/connectors/...\` resolve. npm
// wrapper installs set this explicitly via launch.js and win the
// priority check below.
if (!process.env.SIGNET_DIR?.trim()) {
	const candidates = [
		dirname(process.execPath),
		join(dirname(process.execPath), ".."),
		join(dirname(process.execPath), "..", ".."),
	];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "runtime", "connectors"))) {
			process.env.SIGNET_DIR = candidate;
			break;
		}
	}
}
await import("../surfaces/cli/src/cli.ts");
`,
);

runBunBuild([
	"--compile",
	`--target=${compileTargetFor(platformKey)}`,
	"--outfile",
	outfile,
	...nativeExternalArgs,
	".native-build/cli-native.ts",
]);

console.log(`Built native Bun executable: ${outfile}`);

if (!process.env.SIGNET_NATIVE_PLATFORM) {
	const localName = platform() === "win32" ? "signet.exe" : "signet";
	const localPath = join(outDir, localName);
	copyFileSync(outfile, localPath);
	if (platform() !== "win32") chmodSync(localPath, 0o755);
	console.log(`Updated local smoke binary: ${localPath}`);
}
