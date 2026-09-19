#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	renameSync,
	statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");
const resources = resolve(desktopRoot, "resources");
const nativeRuntime = resolve(repoRoot, "dist/signetai/runtime/rust-daemon");
const dashboardBuild = resolve(repoRoot, "surfaces/dashboard/dist");
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
	const stagedResources = mkdtempSync(join(desktopRoot, ".resources-stage-"));
	const executable = target === "win32" ? "signet-daemon.exe" : "signet-daemon";
	const daemonSource = resolve(nativeRuntime, `${target}-${arch}`, executable);
	try {
		if (!existsSync(daemonSource))
			throw new Error(`Rust daemon artifact not found: ${daemonSource}. Run build:native first.`);
		if (!existsSync(resolve(dashboardBuild, "index.html")))
			throw new Error(`Dashboard build not found: ${dashboardBuild}`);
		const daemonOut = resolve(stagedResources, "rust-daemon", `${target}-${arch}`);
		mkdirSync(daemonOut, { recursive: true });
		cpSync(daemonSource, resolve(daemonOut, executable));
		if (target !== "win32") chmodSync(resolve(daemonOut, executable), 0o755);
		cpSync(dashboardBuild, resolve(stagedResources, "rust-daemon", "dashboard"), { recursive: true });

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
