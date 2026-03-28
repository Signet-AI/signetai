#!/usr/bin/env node

import { execSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const win = process.platform === "win32";

const map = {
	darwin: {
		arm64: "aarch64-apple-darwin",
		x64: "x86_64-apple-darwin",
	},
	linux: {
		arm64: "aarch64-unknown-linux-gnu",
		x64: "x86_64-unknown-linux-gnu",
	},
	win32: {
		arm64: "aarch64-pc-windows-msvc",
		x64: "x86_64-pc-windows-msvc",
	},
};

function hostTarget() {
	const byOs = map[process.platform];
	if (!byOs) return null;
	return byOs[process.arch] ?? null;
}

function target() {
	const envTarget =
		process.env.TAURI_ENV_TARGET_TRIPLE ?? process.env.CARGO_BUILD_TARGET ?? process.env.RELEASE_TARGET ?? null;
	if (envTarget) return envTarget;
	return hostTarget();
}

function targetExt(triple) {
	if (triple.includes("-windows-")) return ".exe";
	return "";
}

function pathLookup() {
	try {
		const cmd = win ? "where signet-daemon" : "which signet-daemon";
		const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (!out) return null;
		return out.split(/\r?\n/)[0]?.trim() ?? null;
	} catch {
		return null;
	}
}

const triple = target();
if (!triple) {
	throw new Error("Could not resolve target triple for daemon sidecar staging");
}

const host = hostTarget();
const cross = host !== null && triple !== host;
const ext = targetExt(triple);
const fromEnv = process.env.SIGNET_DAEMON_BIN ?? null;
const bin = `signet-daemon${ext}`;
const here = resolve(fileURLToPath(import.meta.url), "..");
const root = resolve(here, "..");

const items = [
	{
		kind: "env",
		path: fromEnv,
	},
	{
		kind: "target",
		path: resolve(root, "..", "daemon-rs", "target", triple, "release", bin),
	},
];

if (!cross) {
	items.push(
		{
			kind: "host",
			path: resolve(root, "..", "daemon-rs", "target", "release", bin),
		},
		{
			kind: "path",
			path: pathLookup(),
		},
	);
}

const sourceList = items.filter((item) => item.path !== null);
const srcItem = sourceList.find((item) => existsSync(item.path));
if (srcItem && cross && srcItem.kind === "env" && !srcItem.path.includes(triple)) {
	throw new Error(
		[
			`Refusing to stage SIGNET_DAEMON_BIN for cross-target build (${triple}).`,
			`Expected the provided path to include target triple '${triple}'.`,
			`Provided path: ${srcItem.path}`,
		].join("\n"),
	);
}

const src = srcItem?.path ?? null;
if (!src) {
	throw new Error(
		[
			`Unable to stage daemon sidecar for target ${triple}`,
			cross ? "Cross-target mode is enabled, host fallbacks are disabled." : "Host and PATH fallbacks are enabled.",
			"Looked for:",
			...sourceList.map((item) => `- [${item.kind}] ${item.path}`),
		].join("\n"),
	);
}

const outDir = resolve(root, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });

for (const name of readdirSync(outDir)) {
	if (!name.startsWith("signet-daemon-")) continue;
	rmSync(resolve(outDir, name), { force: true });
}

const out = resolve(outDir, `signet-daemon-${triple}${ext}`);
copyFileSync(src, out);

if (ext === "") {
	chmodSync(out, 0o755);
}

console.log(`Staged daemon sidecar: ${out}`);
