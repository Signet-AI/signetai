#!/usr/bin/env bun

/** Build the CLI-only Bun executable used by release packaging.
 *
 * This entrypoint deliberately compiles surfaces/cli/src/cli.ts only. The
 * Rust daemon/core are not bundled, and no TypeScript daemon workers or
 * fallback runtime are emitted.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outDir = join(root, "dist", "native");
const buildDir = join(root, ".native-build");
const daemonRequire = createRequire(join(root, "platform", "daemon", "package.json"));
const tokenizerWasmPath = daemonRequire.resolve("tiktoken/tiktoken_bg.wasm");
const platformKey = process.env.SIGNET_NATIVE_PLATFORM?.trim() || `${platform()}-${arch()}`;
const targetByPlatform: Record<string, string> = {
	"linux-x64": "bun-linux-x64",
	"linux-arm64": "bun-linux-arm64",
	"darwin-x64": "bun-darwin-x64",
	"darwin-arm64": "bun-darwin-arm64",
	"win32-x64": "bun-windows-x64",
};
const target = targetByPlatform[platformKey];
if (!target) throw new Error(`Unsupported native compile platform: ${platformKey}`);
const binaryName = platformKey === "win32-x64" ? `signet-${platformKey}.exe` : `signet-${platformKey}`;
const outfile = join(outDir, binaryName);
const nativeVersion = (() => {
	const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
	return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
})();

type EmbeddedFileAsset = { path: string; contentBase64: string; mode: number };

function walkFiles(dir: string): string[] {
	return readdirSync(dir)
		.sort()
		.flatMap((name) => {
			const path = join(dir, name);
			const info = statSync(path);
			return info.isDirectory() ? walkFiles(path) : info.isFile() ? [path] : [];
		});
}

function fileAssetsFor(dir: string, prefix = ""): EmbeddedFileAsset[] {
	return walkFiles(dir).map((path) => {
		const relative = path.slice(dir.length).replaceAll("\\", "/").replace(/^\//, "");
		return {
			path: prefix ? `${prefix}/${relative}` : relative,
			contentBase64: readFileSync(path).toString("base64"),
			mode: statSync(path).mode & 0o777,
		};
	});
}

const templatesDir = join(root, "surfaces", "cli", "templates");
const skillsDir = join(root, "skills");
const connectorDir = join(root, "integrations", "hermes-agent", "connector", "hermes-plugin");
const graphiqScript = join(root, "scripts", "install-graphiq.sh");
const templateAssets = fileAssetsFor(templatesDir);
const skillAssets = fileAssetsFor(skillsDir);
const connectorAssets = fileAssetsFor(connectorDir, "hermes-agent/hermes-plugin");
const wasmAssets = [
	{
		name: "tiktoken_bg.wasm",
		contentBase64: readFileSync(tokenizerWasmPath).toString("base64"),
	},
];
const graphiqAssets = [
	{
		path: "scripts/install-graphiq.sh",
		contentBase64: readFileSync(graphiqScript).toString("base64"),
		mode: statSync(graphiqScript).mode & 0o777,
	},
];
const nativeEntry = join(buildDir, "cli-native.ts");
// Bun.build's compile option is the programmatic form of `bun build --compile`.
try {
	mkdirSync(outDir, { recursive: true });
	mkdirSync(buildDir, { recursive: true });
	rmSync(outfile, { force: true });
	writeFileSync(
		nativeEntry,
		`import { join } from "node:path";
import { materializeEmbeddedAssetTree, materializeEmbeddedWasmAssets, registerNativeAssets } from ${JSON.stringify("../platform/daemon/src/native-runtime-assets")};
import { runSecretKeyringChild } from ${JSON.stringify("../platform/core/src/secrets-keyring-child")};
if (process.env.SIGNET_KEYRING_HELPER === "1") {
  await runSecretKeyringChild();
} else {
  process.env.SIGNET_COMPILED_NATIVE = "1";
  process.env.SIGNET_NATIVE_SOURCE_WORKER_SMOKE ??= "1";
  registerNativeAssets({
    connectors: ${JSON.stringify(connectorAssets)},
    graphiq: ${JSON.stringify(graphiqAssets)},
    skills: ${JSON.stringify(skillAssets)},
    templates: ${JSON.stringify(templateAssets)},
    wasm: ${JSON.stringify(wasmAssets)},
  });
  process.env.SIGNET_VERSION = process.env.SIGNET_VERSION?.trim() || ${JSON.stringify(nativeVersion)};
  process.env.SIGNET_TEMPLATES_DIR ??= materializeEmbeddedAssetTree("templates") ?? "";
  process.env.SIGNET_SKILLS_SOURCE ??= materializeEmbeddedAssetTree("skills") ?? "";
  process.env.SIGNET_CONNECTOR_ASSETS_DIR ??= materializeEmbeddedAssetTree("connectors") ?? "";
  process.env.SIGNET_GRAPHIQ_ASSETS_DIR ??= materializeEmbeddedAssetTree("graphiq") ?? "";
  const wasmDir = materializeEmbeddedWasmAssets();
  if (wasmDir) process.env.SIGNET_TIKTOKEN_WASM_PATH ??= join(wasmDir, "tiktoken_bg.wasm");
  await import(${JSON.stringify(join(root, "surfaces", "cli", "src", "cli.ts"))});
}
`,
	);
	const result = await Bun.build({
		entrypoints: [nativeEntry],
		compile: {
			target: target as "bun-linux-x64" | "bun-linux-arm64" | "bun-darwin-x64" | "bun-darwin-arm64" | "bun-windows-x64",
			outfile,
		},
		external: ["better-sqlite3"],
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error("Native CLI build failed");
	}
	if (!existsSync(outfile)) throw new Error(`Native CLI build did not produce ${outfile}`);
	if (platform() !== "win32") chmodSync(outfile, 0o755);
} finally {
	rmSync(buildDir, { recursive: true, force: true });
}
if (!process.env.SIGNET_NATIVE_PLATFORM && platformKey === `${platform()}-${arch()}`) {
	const localName = platform() === "win32" ? "signet.exe" : "signet";
	const localPath = join(outDir, localName);
	const { copyFileSync } = await import("node:fs");
	copyFileSync(outfile, localPath);
	if (platform() !== "win32") chmodSync(localPath, 0o755);
}
console.log(`Built CLI-only Bun executable: ${outfile}`);
