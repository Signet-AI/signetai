#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const win = process.platform === "win32";
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");
const resources = resolve(desktopRoot, "resources");
const daemonOut = resolve(resources, "daemon");
const runtimeOut = resolve(resources, "runtime");
const daemonPkgPath = resolve(repoRoot, "platform/daemon/package.json");
const corePkgPath = resolve(repoRoot, "platform/core/package.json");

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
		if ((name === "bun" || name === "bun.exe") && existsSync(candidate)) return resolve(candidate);
	}
	throw new Error("Unable to locate Bun runtime. Run this script with bun or set BUN_RUNTIME.");
}

function normalizeArch(value) {
	if (value === "arm") return "arm64";
	if (value === "arm64" || value === "x64" || value === "ia32") return value;
	throw new Error(`Unsupported desktop build architecture: ${value}`);
}

function normalizePlatform(value) {
	if (value === "mac") return "darwin";
	if (value === "windows") return "win32";
	if (value === "darwin" || value === "linux" || value === "win32") return value;
	throw new Error(`Unsupported desktop build platform: ${value}`);
}

function targetArch() {
	return normalizeArch(process.env.ELECTRON_BUILDER_ARCH ?? process.env.npm_config_arch ?? process.arch);
}

function targetPlatform() {
	return normalizePlatform(process.env.ELECTRON_BUILDER_PLATFORM ?? process.platform);
}

function probeBunRuntime(runtimePath) {
	const output = execFileSync(
		runtimePath,
		["-e", "console.log(JSON.stringify({ platform: process.platform, arch: process.arch }))"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	const result = JSON.parse(output.trim());
	if (
		typeof result !== "object" ||
		result === null ||
		typeof result.platform !== "string" ||
		typeof result.arch !== "string"
	) {
		throw new Error("Bun runtime probe returned an invalid result");
	}
	return { platform: normalizePlatform(result.platform), arch: normalizeArch(result.arch) };
}

export function assertBunRuntime(
	runtimePath,
	expectedArch,
	expectedPlatform = process.platform,
	probe = probeBunRuntime,
) {
	if (!existsSync(runtimePath) || !statSync(runtimePath).isFile()) {
		throw new Error(`Bun runtime is not a regular file: ${runtimePath}`);
	}
	if (process.platform !== "win32" && (statSync(runtimePath).mode & 0o111) === 0) {
		throw new Error(`Bun runtime is not executable: ${runtimePath}`);
	}

	let runtime;
	try {
		runtime = probe(runtimePath);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to execute Bun runtime at ${runtimePath}: ${detail}`);
	}

	const arch = normalizeArch(expectedArch);
	const platform = normalizePlatform(expectedPlatform);
	if (runtime.platform !== platform) {
		throw new Error(`Bun runtime platform mismatch: expected ${platform}, got ${runtime.platform} (${runtimePath})`);
	}
	if (runtime.arch !== arch) {
		throw new Error(`Bun runtime architecture mismatch: expected ${arch}, got ${runtime.arch} (${runtimePath})`);
	}
}

function platformVecPackage(arch) {
	const os = process.platform === "win32" ? "windows" : process.platform;
	return `sqlite-vec-${os}-${arch}`;
}

function pkgVersion(pkg, name) {
	return pkg.dependencies?.[name] ?? pkg.optionalDependencies?.[name] ?? pkg.devDependencies?.[name] ?? null;
}

export function stageRuntime() {
	const bunSrc = bunRuntime();
	const bunArch = targetArch();
	assertBunRuntime(bunSrc, bunArch, targetPlatform());

	rmSync(resources, { recursive: true, force: true });
	mkdirSync(daemonOut, { recursive: true });
	mkdirSync(runtimeOut, { recursive: true });

	const bunDest = resolve(runtimeOut, win ? "bun.exe" : "bun");
	cpSync(bunSrc, bunDest);
	if (!win) chmodSync(bunDest, 0o755);

	mkdirSync(resolve(daemonOut, "dist"), { recursive: true });
	for (const name of ["daemon.js", "mcp-stdio.js", "index.js", "synthesis-render-worker.js"]) {
		cpSync(resolve(repoRoot, "platform/daemon/dist", name), resolve(daemonOut, "dist", name));
	}
	cpSync(resolve(repoRoot, "platform/daemon/dashboard"), resolve(daemonOut, "dashboard"), { recursive: true });
	cpSync(resolve(repoRoot, "platform/daemon/skills"), resolve(daemonOut, "skills"), { recursive: true });

	const daemonPkg = readJson(daemonPkgPath);
	const corePkg = readJson(corePkgPath);
	const vecPkg = platformVecPackage(bunArch);
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
		`${JSON.stringify({ private: true, type: "module", dependencies }, null, "	")}\n`,
	);

	execFileSync(bunSrc, ["install", "--production"], {
		cwd: daemonOut,
		stdio: "inherit",
		env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
	});

	console.log(`Staged Electron desktop resources in ${resources}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) stageRuntime();
