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
const platformKey = process.env.SIGNET_NATIVE_PLATFORM ?? `${platform()}-${arch()}`;
const binaryName = platformKey.startsWith("win32-") ? `signet-${platformKey}.exe` : `signet-${platformKey}`;
const outfile = join(outDir, binaryName);
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
const nativeVersion = typeof rootPackage.version === "string" ? rootPackage.version : "0.0.0";
const nativeExternalArgs = ["--external", "better-sqlite3"] as const;

mkdirSync(outDir, { recursive: true });
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

function runBunBuild(args: readonly string[]): void {
	const result = spawnSync(process.execPath, ["build", ...args], {
		cwd: root,
		stdio: "inherit",
		windowsHide: true,
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
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

function walkFiles(dir: string): string[] {
	return readdirSync(dir)
		.flatMap((name) => {
			const path = join(dir, name);
			const entry = statSync(path);
			return entry.isDirectory() ? walkFiles(path) : entry.isFile() ? [path] : [];
		})
		.sort();
}

function fileAssetsFor(dir: string, prefix = "") {
	return walkFiles(dir).map((path) => {
		const relative = path.slice(dir.length).replaceAll("\\", "/");
		const normalized = relative.startsWith("/") ? relative.slice(1) : relative;
		return {
			path: prefix ? `${prefix}/${normalized}` : normalized,
			contentBase64: readFileSync(path).toString("base64"),
			mode: statSync(path).mode & 0o777,
		};
	});
}

const templatesDir = join(root, "surfaces", "cli", "templates");
const skillsDir = join(root, "skills");
const hermesPluginDir = join(root, "integrations", "hermes-agent", "connector", "hermes-plugin");
const graphiqScriptPath = join(root, "scripts", "install-graphiq.sh");
for (const requiredPath of [templatesDir, skillsDir, hermesPluginDir, graphiqScriptPath]) {
	if (!existsSync(requiredPath)) throw new Error(`Native CLI asset is missing: ${requiredPath}`);
}

const coreRequire = createRequire(join(root, "platform", "core", "package.json"));
const packagePlatformKey = platformKey.startsWith("linux-") ? `${platformKey}-gnu` : platformKey;
const packageSuffix = platformKey === "win32-x64" ? "win32-x64-msvc" : packagePlatformKey;
const platformPackageName = `@napi-rs/keyring-${packageSuffix}`;
const keyringPackageJson = coreRequire.resolve("@napi-rs/keyring/package.json");
const keyringRequire = createRequire(keyringPackageJson);
const platformPackageJson = keyringRequire.resolve(`${platformPackageName}/package.json`);
const keyringNodeFile = join(dirname(platformPackageJson), `keyring.${packageSuffix}.node`);
if (!existsSync(keyringNodeFile)) {
	throw new Error(`Required @napi-rs/keyring native asset is missing for ${platformKey}: ${keyringNodeFile}`);
}
const nativeAddonAssets = [
	{ name: "napi-rs-keyring", contentBase64: readFileSync(keyringNodeFile).toString("base64") },
];
const connectorAssets = fileAssetsFor(hermesPluginDir, "hermes-agent/hermes-plugin");
const graphiqAssets = [
	{
		path: "scripts/install-graphiq.sh",
		contentBase64: readFileSync(graphiqScriptPath).toString("base64"),
		mode: statSync(graphiqScriptPath).mode & 0o777,
	},
];
const skillAssets = fileAssetsFor(skillsDir);
const templateAssets = fileAssetsFor(templatesDir);

writeFileSync(
	join(buildDir, "native-assets.ts"),
	`export const connectorAssets = ${JSON.stringify(connectorAssets)} as const;\n` +
		`export const graphiqAssets = ${JSON.stringify(graphiqAssets)} as const;\n` +
		`export const nativeAddonAssets = ${JSON.stringify(nativeAddonAssets)} as const;\n` +
		`export const skillAssets = ${JSON.stringify(skillAssets)} as const;\n` +
		`export const templateAssets = ${JSON.stringify(templateAssets)} as const;\n`,
);

writeFileSync(
	join(buildDir, "cli-native.ts"),
	`import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectorAssets, graphiqAssets, nativeAddonAssets, skillAssets, templateAssets } from "./native-assets";

const root = join(tmpdir(), "signet-native", ${JSON.stringify(nativeVersion)});
function materialize(name: string, assets: readonly { readonly path: string; readonly contentBase64: string; readonly mode?: number }[]): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  for (const asset of assets) {
    const path = join(directory, asset.path);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, Buffer.from(asset.contentBase64, "base64"));
    if (asset.mode !== undefined && process.platform !== "win32") chmodSync(path, asset.mode);
  }
  return directory;
}
process.env.SIGNET_TEMPLATES_DIR ??= materialize("templates", templateAssets);
process.env.SIGNET_SKILLS_SOURCE ??= materialize("skills", skillAssets);
process.env.SIGNET_CONNECTOR_ASSETS_DIR ??= materialize("connectors", connectorAssets);
process.env.SIGNET_GRAPHIQ_ASSETS_DIR ??= materialize("graphiq", graphiqAssets);
if (!process.env.SIGNET_KEYRING_NATIVE_MODULE_PATH?.trim()) {
  const addon = nativeAddonAssets[0];
  if (addon !== undefined) process.env.SIGNET_KEYRING_NATIVE_MODULE_PATH = materialize("native", [{ path: "keyring.node", contentBase64: addon.contentBase64 }]) + "/keyring.node";
}
process.env.SIGNET_VERSION = process.env.SIGNET_VERSION?.trim() || ${JSON.stringify(nativeVersion)};
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

console.log(`Built native CLI executable: ${outfile}`);
if (!process.env.SIGNET_NATIVE_PLATFORM) {
	const localName = platform() === "win32" ? "signet.exe" : "signet";
	const localPath = join(outDir, localName);
	copyFileSync(outfile, localPath);
	if (platform() !== "win32") chmodSync(localPath, 0o755);
	console.log(`Updated local smoke binary: ${localPath}`);
}
