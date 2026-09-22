#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");
const resources = resolve(desktopRoot, "resources");
const nativeRuntime = resolve(repoRoot, "dist/signetai/runtime/rust-daemon");
const dashboardBuild = resolve(repoRoot, "surfaces/dashboard/build");
const resourceLockOwnerGracePeriodMs = 60_000;

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

function probeBunRuntime(runtimePath) {
	const result = spawnSync(runtimePath, ["--print", "JSON.stringify({ platform: process.platform, arch: process.arch })"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error("Bun runtime probe failed");
	try {
		return JSON.parse(result.stdout.trim());
	} catch {
		throw new Error("Bun runtime probe returned an invalid result");
	}
}

export function assertBunRuntime(
	runtimePath,
	expectedArch,
	expectedPlatform = process.platform,
	probe = probeBunRuntime,
) {
	const arch = normalizeArch(expectedArch);
	const platform = normalizePlatform(expectedPlatform);
	if (!existsSync(runtimePath) || !statSync(runtimePath).isFile())
		throw new Error(`Bun runtime is not a regular file: ${runtimePath}`);
	if (platform !== "win32" && (statSync(runtimePath).mode & 0o111) === 0)
		throw new Error(`Bun runtime is not executable: ${runtimePath}`);
	let runtime;
	try {
		runtime = probe(runtimePath);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to execute Bun runtime at ${runtimePath}: ${detail}`);
	}
	if (runtime.platform !== platform)
		throw new Error(`Bun runtime platform mismatch: expected ${platform}, got ${runtime.platform} (${runtimePath})`);
	if (runtime.arch !== arch)
		throw new Error(`Bun runtime architecture mismatch: expected ${arch}, got ${runtime.arch} (${runtimePath})`);
	return runtime;
}

function targetPlatform() {
	return normalizePlatform(process.env.ELECTRON_BUILDER_PLATFORM ?? process.platform);
}

function resourceLockPath(target) {
	return join(dirname(target), `.${basename(target)}.lock`);
}

function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function resourceLockIsExpired(lockPath) {
	try {
		return Date.now() - statSync(lockPath).mtimeMs >= resourceLockOwnerGracePeriodMs;
	} catch (error) {
		return error?.code === "ENOENT";
	}
}

function acquireResourceLock(target) {
	const lockPath = resourceLockPath(target);
	while (true) {
		try {
			mkdirSync(lockPath);
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			let owner;
			let ownerError;
			try {
				const rawOwner = readFileSync(join(lockPath, "owner"), "utf8").trim();
				owner = /^\d+$/.test(rawOwner) ? Number(rawOwner) : Number.NaN;
			} catch (error) {
				ownerError = error;
			}
			if (ownerError && !resourceLockIsExpired(lockPath)) {
				throw new Error(`Desktop resources are already being replaced: ${target}`, { cause: ownerError });
			}
			if (!ownerError && Number.isInteger(owner) && owner > 0 && processIsAlive(owner)) {
				throw new Error(`Desktop resources are already being replaced: ${target}`);
			}
			if (!ownerError && (!Number.isInteger(owner) || owner <= 0) && !resourceLockIsExpired(lockPath)) {
				throw new Error(`Desktop resources are already being replaced: ${target}`);
			}
			const stalePath = `${lockPath}.stale-${randomUUID()}`;
			try {
				renameSync(lockPath, stalePath);
			} catch (staleError) {
				if (staleError?.code === "ENOENT") continue;
				throw staleError;
			}
			rmSync(stalePath, { recursive: true, force: true });
			continue;
		}
		try {
			writeFileSync(join(lockPath, "owner"), `${process.pid}\n`);
		} catch (error) {
			rmSync(lockPath, { recursive: true, force: true });
			throw error;
		}
		return lockPath;
	}
}

function releaseResourceLock(lockPath) {
	rmSync(lockPath, { recursive: true, force: true });
}

function removeBackup(backupParent, backup, remove = rmSync) {
	try {
		remove(backupParent, { recursive: true, force: true });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to remove desktop resource backup ${backup}: ${detail}`, { cause: error });
	}
}

export function removeStaging(stagedResources, remove = rmSync) {
	try {
		remove(stagedResources, { recursive: true, force: true });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to remove temporary desktop resources ${stagedResources}: ${detail}`, { cause: error });
	}
}

export function nativeDaemonPath(platform, arch) {
	const executable = platform === "win32" ? "signet-daemon.exe" : "signet-daemon";
	return resolve(nativeRuntime, `${platform}-${arch}`, executable);
}

export function assertNativeDaemon(path) {
	if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Rust daemon artifact not found: ${path}. Run build:native first.`);
	if (process.platform !== "win32" && (statSync(path).mode & 0o111) === 0) throw new Error(`Rust daemon artifact is not executable: ${path}`);
}

export function platformVecPackage(platform, arch) {
	const os = platform === "win32" ? "windows" : platform;
	return `sqlite-vec-${os}-${arch}`;
}

export function replaceResources(target, staged, rename = renameSync, remove = rmSync) {
	const lockPath = acquireResourceLock(target);
	let failure;
	try {
		const hadTarget = existsSync(target);
		const backupParent = mkdtempSync(join(dirname(target), ".resources-backup-"));
		const backup = join(backupParent, basename(target));
		let moved = false;
		try {
			if (hadTarget) {
				rename(target, backup);
				moved = true;
			}
			rename(staged, target);
		} catch (error) {
			if (moved) {
				try {
					if (existsSync(target)) {
						throw new Error(`Desktop resources changed during replacement: ${target}`);
					}
					rename(backup, target);
				} catch (restoreError) {
					const detail = restoreError instanceof Error ? restoreError.message : String(restoreError);
					throw new Error(`Unable to restore previous desktop resources from ${backup}: ${detail}`, { cause: error });
				}
			}
			try {
				removeBackup(backupParent, backup, remove);
			} catch (cleanupError) {
				const original = error instanceof Error ? error.message : String(error);
				const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
				throw new Error(`${original}; ${detail}`, { cause: error });
			}
			throw error;
		}
		removeBackup(backupParent, backup, remove);
	} catch (error) {
		failure = error;
	}
	let releaseError;
	try {
		releaseResourceLock(lockPath);
	} catch (error) {
		releaseError = error;
	}
	if (failure && releaseError) {
		const original = failure instanceof Error ? failure.message : String(failure);
		const detail = releaseError instanceof Error ? releaseError.message : String(releaseError);
		throw new Error(`${original}; Unable to release desktop resource lock ${lockPath}: ${detail}`, { cause: failure });
	}
	if (failure) throw failure;
	if (releaseError) throw releaseError;
}

export function stageRuntime() {
	const arch = targetArch();
	const target = targetPlatform();
	const hostPlatform = normalizePlatform(process.platform);
	const hostArch = normalizeArch(process.arch);
	if (target !== hostPlatform || arch !== hostArch) {
		throw new Error(
			`Desktop runtime staging requires a native ${target}/${arch} build runner; host is ${hostPlatform}/${hostArch}.`,
		);
	}
	const stagedResources = mkdtempSync(join(desktopRoot, ".resources-stage-"));
	const executable = target === "win32" ? "signet-daemon.exe" : "signet-daemon";
	const daemonSource = nativeDaemonPath(target, arch);
	try {
		assertNativeDaemon(daemonSource);
		if (!existsSync(resolve(dashboardBuild, "index.html")))
			throw new Error(`Dashboard build not found: ${dashboardBuild}`);
		const daemonOut = resolve(stagedResources, "rust-daemon", `${target}-${arch}`);
		mkdirSync(daemonOut, { recursive: true });
		cpSync(daemonSource, resolve(daemonOut, executable));
		if (target !== "win32") chmodSync(resolve(daemonOut, executable), 0o755);
		cpSync(dashboardBuild, resolve(stagedResources, "rust-daemon", "dashboard"), { recursive: true });
		// Preserve the complete daemon distribution and its native dependency assets
		// for compatibility consumers; production launch remains the Rust binary.
		const daemonRootOut = resolve(stagedResources, "rust-daemon");
		const daemonDist = resolve(repoRoot, "platform/daemon/dist");
		if (!existsSync(daemonDist)) throw new Error(`Daemon distribution not found: ${daemonDist}`);
		// The build output is authoritative: worker entrypoints and nested assets
		// are loaded by name at runtime, so do not reduce it to a file extension list.
		for (const entry of readdirSync(daemonDist)) {
			if (!entry) throw new Error(`Invalid daemon distribution entry: ${daemonDist}`);
		}
		cpSync(daemonDist, resolve(daemonRootOut, "dist"), { recursive: true });

		const daemonSkills = resolve(repoRoot, "platform/daemon/skills");
		if (existsSync(daemonSkills)) cpSync(daemonSkills, resolve(daemonRootOut, "skills"), { recursive: true });

		// Stage the exact external packages whose files are resolved at runtime.
		const packageSources = [
			["tiktoken", resolve(repoRoot, "node_modules/tiktoken")],
			[platformVecPackage(target, arch), resolve(repoRoot, "node_modules", platformVecPackage(target, arch))],
		];
		for (const [name, source] of packageSources) {
			if (!existsSync(source)) throw new Error(`Required daemon package not found: ${source}`);
			cpSync(source, resolve(daemonRootOut, "node_modules", name), { recursive: true });
		}

		// The native runtime still needs the hermes-agent Python plugin during harness install.
		const connectorsOut = resolve(stagedResources, "rust-daemon", "connectors");
		const hermesPluginSrc = resolve(repoRoot, "integrations/hermes-agent/connector/hermes-plugin");
		if (!existsSync(hermesPluginSrc)) throw new Error(`Hermes connector plugin source not found: ${hermesPluginSrc}`);
		cpSync(hermesPluginSrc, resolve(connectorsOut, "hermes-agent", "hermes-plugin"), { recursive: true });

		replaceResources(resources, stagedResources);
		console.log(`Staged Electron desktop resources in ${resources}`);
	} catch (error) {
		try {
			removeStaging(stagedResources);
		} catch (cleanupError) {
			const original = error instanceof Error ? error.message : String(error);
			const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
			throw new Error(`${original}; ${detail}`, { cause: error });
		}
		throw error;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) stageRuntime();
