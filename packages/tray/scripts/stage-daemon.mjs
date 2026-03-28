#!/usr/bin/env node

import { execSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const win = process.platform === "win32";
const ext = win ? ".exe" : "";

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

const fromEnv = process.env.SIGNET_DAEMON_BIN ?? null;
const bin = `signet-daemon${ext}`;
const here = resolve(fileURLToPath(import.meta.url), "..");
const root = resolve(here, "..");
const sourceList = [
	fromEnv,
	resolve(root, "..", "daemon-rs", "target", triple, "release", bin),
	resolve(root, "..", "daemon-rs", "target", "release", bin),
	pathLookup(),
].filter(Boolean);

const src = sourceList.find((value) => existsSync(value));
if (!src) {
	throw new Error(
		[
			`Unable to stage daemon sidecar for target ${triple}`,
			"Looked for:",
			...sourceList.map((value) => `- ${value}`),
		].join("\n"),
	);
}

const outDir = resolve(root, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });

const out = resolve(outDir, `signet-daemon-${triple}${ext}`);
copyFileSync(src, out);

if (!win) {
	chmodSync(out, 0o755);
}

console.log(`Staged daemon sidecar: ${out}`);
