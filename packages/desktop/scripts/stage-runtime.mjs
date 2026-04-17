#!/usr/bin/env node

import { execFileSync, execSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const win = process.platform === "win32";
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");
const resources = resolve(desktopRoot, "resources");
const daemonOut = resolve(resources, "daemon");
const runtimeOut = resolve(resources, "runtime");
const daemonPkgPath = resolve(repoRoot, "packages/daemon/package.json");
const corePkgPath = resolve(repoRoot, "packages/core/package.json");

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function pathLookup(cmd) {
	try {
		const out = execFileSync(win ? "where" : "which", [cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return out.trim().split(/\r?\n/)[0] || null;
	} catch {
		return null;
	}
}

function bunRuntime() {
	const candidates = [process.env.BUN_RUNTIME, process.execPath, pathLookup("bun")].filter(Boolean);
	for (const candidate of candidates) {
		const name = basename(candidate).toLowerCase();
		if ((name === "bun" || name === "bun.exe") && existsSync(candidate)) return candidate;
	}
	throw new Error("Unable to locate Bun runtime. Run this script with bun or set BUN_RUNTIME.");
}

function platformVecPackage() {
	const os = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `sqlite-vec-${os}-${arch}`;
}

function pkgVersion(pkg, name) {
	return pkg.dependencies?.[name] ?? pkg.optionalDependencies?.[name] ?? pkg.devDependencies?.[name] ?? null;
}

rmSync(resources, { recursive: true, force: true });
mkdirSync(daemonOut, { recursive: true });
mkdirSync(runtimeOut, { recursive: true });

const bunSrc = bunRuntime();
const bunDest = resolve(runtimeOut, win ? "bun.exe" : "bun");
cpSync(bunSrc, bunDest);
if (!win) chmodSync(bunDest, 0o755);

mkdirSync(resolve(daemonOut, "dist"), { recursive: true });
for (const name of ["daemon.js", "mcp-stdio.js", "index.js", "synthesis-render-worker.js"]) {
	cpSync(resolve(repoRoot, "packages/daemon/dist", name), resolve(daemonOut, "dist", name));
}
cpSync(resolve(repoRoot, "packages/daemon/dashboard"), resolve(daemonOut, "dashboard"), { recursive: true });
cpSync(resolve(repoRoot, "packages/daemon/skills"), resolve(daemonOut, "skills"), { recursive: true });

const daemonPkg = readJson(daemonPkgPath);
const corePkg = readJson(corePkgPath);
const vecPkg = platformVecPackage();
const dependencies = {};
for (const name of ["@1password/sdk", "@huggingface/transformers", "onnxruntime-node"]) {
	const version = pkgVersion(daemonPkg, name);
	if (version) dependencies[name] = version;
}
for (const name of ["sqlite-vec", vecPkg]) {
	const version = pkgVersion(corePkg, name);
	if (version) dependencies[name] = version;
}

writeFileSync(
	resolve(daemonOut, "package.json"),
	`${JSON.stringify({ private: true, type: "module", dependencies }, null, "\t")}\n`,
);

execSync("bun install --production", {
	cwd: daemonOut,
	stdio: "inherit",
	env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
});

console.log(`Staged Electron desktop resources in ${resources}`);
