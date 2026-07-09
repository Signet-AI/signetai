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
const hermesPluginDir = join(root, "integrations", "hermes-agent", "connector", "hermes-plugin");

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
const fileAssetsFor = (dir: string, prefix = "") =>
	walkFiles(dir).map((path) => {
		const relative = path.slice(dir.length).replaceAll("\\", "/");
		const normalized = relative.startsWith("/") ? relative.slice(1) : relative;
		return {
			path: prefix ? `${prefix}/${normalized}` : normalized,
			contentBase64: readFileSync(path).toString("base64"),
			mode: statSync(path).mode & 0o777,
		};
	});
const templateAssets = fileAssetsFor(templatesDir);
const skillAssets = fileAssetsFor(skillsDir);
const connectorAssets = fileAssetsFor(hermesPluginDir, "hermes-agent/hermes-plugin");

const workerAssets = workerEntries.map(([name]) => ({
	name,
	contentBase64: readFileSync(join(workerDir, `${name}.mjs`)).toString("base64"),
}));
const transformersPackageJson = daemonRequire.resolve("@huggingface/transformers/package.json");
const transformersDir = dirname(transformersPackageJson);
const transformersRequire = createRequire(transformersPackageJson);
const onnxRuntimeWebPackageJson = transformersRequire.resolve("onnxruntime-web/package.json");
const onnxRuntimeWebDir = dirname(onnxRuntimeWebPackageJson);
const onnxRuntimeWebWasmPath = join(onnxRuntimeWebDir, "dist", "ort.wasm.bundle.min.mjs");
const onnxRuntimeWebRequire = createRequire(onnxRuntimeWebPackageJson);
const onnxRuntimeCommonPackageJson = onnxRuntimeWebRequire.resolve("onnxruntime-common/package.json");
const onnxRuntimeCommonEsmPath = join(dirname(onnxRuntimeCommonPackageJson), "dist", "esm", "index.js");
const transformersWebRuntimePath = join(transformersDir, "dist", "transformers.web.js");

// Bun's compiled executable reports a Node-like environment, so Transformers.js
// selects its native ONNX branch even though this release embeds the web/WASM
// runtime. Patch only the generated build copy, with unique-anchor guards so a
// dependency upgrade fails loudly instead of silently producing a broken binary.
let patchedTransformersWebRuntimeSource = readFileSync(transformersWebRuntimePath, "utf8");
for (const [specifier, resolved] of [
	["onnxruntime-common", onnxRuntimeCommonEsmPath],
	["onnxruntime-web", onnxRuntimeWebWasmPath],
] as const) {
	const externalImport = `from ${JSON.stringify(specifier)};`;
	if (patchedTransformersWebRuntimeSource.split(externalImport).length !== 2) {
		throw new Error(`Unsupported @huggingface/transformers web runtime: ${specifier} import changed`);
	}
	patchedTransformersWebRuntimeSource = patchedTransformersWebRuntimeSource.replace(
		externalImport,
		`from ${JSON.stringify(resolved)};`,
	);
}
const customRuntimeAnchor = "    ONNX = globalThis[ORT_SYMBOL];\n";
if (patchedTransformersWebRuntimeSource.split(customRuntimeAnchor).length !== 2) {
	throw new Error("Unsupported @huggingface/transformers web runtime: custom ONNX runtime anchor changed");
}
patchedTransformersWebRuntimeSource = patchedTransformersWebRuntimeSource.replace(
	customRuntimeAnchor,
	`${customRuntimeAnchor}\n    // Transformers.js 3.8.1 does not populate device defaults for a custom runtime.\n    supportedDevices.push('wasm');\n    defaultDevices = ['wasm'];\n`,
);
const nodeDeviceDefault = /device \?\? \([^\n)]+\.apis\.IS_NODE_ENV \? 'cpu' : 'wasm'\)/g;
if ((patchedTransformersWebRuntimeSource.match(nodeDeviceDefault) ?? []).length !== 1) {
	throw new Error("Unsupported @huggingface/transformers web runtime: Node device default changed");
}
patchedTransformersWebRuntimeSource = patchedTransformersWebRuntimeSource.replace(
	nodeDeviceDefault,
	"device ?? 'wasm'",
);
const patchedTransformersWebRuntimePath = join(buildDir, "transformers.web.js");
writeFileSync(patchedTransformersWebRuntimePath, patchedTransformersWebRuntimeSource);
const wasmAssets = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"].map((name) => ({
	name,
	contentBase64: readFileSync(join(onnxRuntimeWebDir, "dist", name)).toString("base64"),
}));

writeFileSync(
	join(buildDir, "native-assets.ts"),
	`export const dashboardAssets = ${JSON.stringify(dashboardAssets)} as const;\n` +
		`export const connectorAssets = ${JSON.stringify(connectorAssets)} as const;\n` +
		`export const skillAssets = ${JSON.stringify(skillAssets)} as const;\n` +
		`export const templateAssets = ${JSON.stringify(templateAssets)} as const;\n` +
		`export const workerAssets = ${JSON.stringify(workerAssets)} as const;\n` +
		`export const wasmAssets = ${JSON.stringify(wasmAssets)} as const;\n`,
);

writeFileSync(
	join(buildDir, "transformers-web-runtime.ts"),
	`import * as onnxRuntime from ${JSON.stringify(onnxRuntimeWebWasmPath)};
globalThis[Symbol.for("onnxruntime")] = onnxRuntime.default ?? onnxRuntime;
const transformers = await import(${JSON.stringify(patchedTransformersWebRuntimePath)});
export const { env, pipeline } = transformers;
`,
);

writeFileSync(
	join(buildDir, "cli-native.ts"),
	`import { materializeEmbeddedAssetTree, registerNativeAssets, registerNativeTransformersBindings } from "../platform/daemon/src/native-runtime-assets";
import { connectorAssets, dashboardAssets, skillAssets, templateAssets, wasmAssets, workerAssets } from "./native-assets";
import * as transformersWebRuntime from "./transformers-web-runtime";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

registerNativeAssets({ connectors: connectorAssets, dashboard: dashboardAssets, skills: skillAssets, templates: templateAssets, workers: workerAssets, wasm: wasmAssets });
registerNativeTransformersBindings(transformersWebRuntime);
process.env.SIGNET_VERSION = process.env.SIGNET_VERSION?.trim() || ${JSON.stringify(nativeVersion)};
process.env.SIGNET_TEMPLATES_DIR ??= materializeEmbeddedAssetTree("templates") ?? "";
process.env.SIGNET_SKILLS_SOURCE ??= materializeEmbeddedAssetTree("skills") ?? "";
process.env.SIGNET_CONNECTOR_ASSETS_DIR ??= materializeEmbeddedAssetTree("connectors") ?? "";

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
