import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arch, platform } from "node:os";
import { findSqliteVecExtension } from "./database";

function getPlatformPackageName(): string {
	const os = platform() === "win32" ? "windows" : platform();
	return `sqlite-vec-${os}-${arch() === "x64" ? "x64" : arch()}`;
}

function getExtSuffix(): string {
	return platform() === "win32" ? "dll" : platform() === "darwin" ? "dylib" : "so";
}

describe("sqlite-vec extension path resolution (bun global native binary)", () => {
	let tempDir: string;
	let savedExecPath: string;
	let savedEnvPath: string | undefined;
	let savedBunInstall: string | undefined;
	let savedDaemonJsPath: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "vec-path-test-"));
		savedExecPath = process.execPath;
		savedEnvPath = process.env.SIGNET_VEC_PATH;
		savedBunInstall = process.env.BUN_INSTALL;
		savedDaemonJsPath = process.env.SIGNET_DAEMON_JS_PATH;
		delete process.env.SIGNET_VEC_PATH;
		delete process.env.BUN_INSTALL;
		delete process.env.SIGNET_DAEMON_JS_PATH;
	});

	afterEach(() => {
		try {
			Object.defineProperty(process, "execPath", { value: savedExecPath, writable: true });
		} catch {}
		if (savedEnvPath !== undefined) process.env.SIGNET_VEC_PATH = savedEnvPath;
		else delete process.env.SIGNET_VEC_PATH;
		if (savedBunInstall !== undefined) process.env.BUN_INSTALL = savedBunInstall;
		else delete process.env.BUN_INSTALL;
		if (savedDaemonJsPath !== undefined) process.env.SIGNET_DAEMON_JS_PATH = savedDaemonJsPath;
		else delete process.env.SIGNET_DAEMON_JS_PATH;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("resolves extension as sibling of signetai in parent node_modules (native binary layout)", () => {
		const nodeModules = join(tempDir, "node_modules");
		const signetaiPkg = join(nodeModules, "signetai");
		const nativeDir = join(signetaiPkg, "native");
		const binaryPath = join(nativeDir, "signet");
		mkdirSync(nativeDir, { recursive: true });
		writeFileSync(binaryPath, "", { mode: 0o755 });
		const platformPkg = getPlatformPackageName();
		const extFile = `vec0.${getExtSuffix()}`;
		const extDir = join(nodeModules, platformPkg);
		mkdirSync(extDir, { recursive: true });
		const extPath = join(extDir, extFile);
		writeFileSync(extPath, "fake extension");
		const { dirname } = require("node:path");
		const resolved = join(dirname(dirname(dirname(binaryPath))), platformPkg, extFile);
		expect(resolved).toBe(extPath);
		const { existsSync } = require("node:fs");
		expect(existsSync(resolved)).toBe(true);
	});

	it("resolves extension nested in signetai/node_modules (without lib prefix)", () => {
		const nodeModules = join(tempDir, "node_modules");
		const signetaiPkg = join(nodeModules, "signetai");
		const nativeDir = join(signetaiPkg, "native");
		const binaryPath = join(nativeDir, "signet");
		mkdirSync(nativeDir, { recursive: true });
		writeFileSync(binaryPath, "", { mode: 0o755 });

		const platformPkg = getPlatformPackageName();
		const extFile = `vec0.${getExtSuffix()}`;
		const extDir = join(signetaiPkg, "node_modules", platformPkg);
		mkdirSync(extDir, { recursive: true });
		const extPath = join(extDir, extFile);
		writeFileSync(extPath, "fake extension");

		const { dirname } = require("node:path");
		const resolved = join(dirname(dirname(binaryPath)), "node_modules", platformPkg, extFile);
		expect(resolved).toBe(extPath);

		const { existsSync } = require("node:fs");
		expect(existsSync(resolved)).toBe(true);
	});

	it("three-levels-up invariant holds for alternative binary layouts", () => {
		const layouts = [
			["signetai", "native", "signet"],
			["signetai-linux-x64", "bin", "signet"],
		];

		for (const [pkgDir, binDir, binName] of layouts) {
			const tempLayout = mkdtempSync(join(tmpdir(), "vec-layout-"));
			const nodeModules = join(tempLayout, "node_modules");
			const binaryPath = join(nodeModules, pkgDir, binDir, binName);
			mkdirSync(join(nodeModules, pkgDir, binDir), { recursive: true });
			writeFileSync(binaryPath, "", { mode: 0o755 });

			const platformPkg = getPlatformPackageName();
			const extFile = `vec0.${getExtSuffix()}`;
			const extDir = join(nodeModules, platformPkg);
			mkdirSync(extDir, { recursive: true });
			writeFileSync(join(extDir, extFile), "fake");

			const { dirname } = require("node:path");
			const resolved = join(dirname(dirname(dirname(binaryPath))), platformPkg, extFile);
			expect(resolved).toBe(join(nodeModules, platformPkg, extFile));

			const { existsSync } = require("node:fs");
			expect(existsSync(resolved)).toBe(true);

			rmSync(tempLayout, { recursive: true, force: true });
		}
	});
	it("resolves extension from the staged daemon runtime package", () => {
		const daemonRoot = join(tempDir, "resources", "daemon");
		const entrypoint = join(daemonRoot, "dist", "daemon.js");
		const extensionPath = join(daemonRoot, "node_modules", getPlatformPackageName(), `vec0.${getExtSuffix()}`);
		mkdirSync(join(daemonRoot, "dist"), { recursive: true });
		mkdirSync(join(daemonRoot, "node_modules", getPlatformPackageName()), { recursive: true });
		writeFileSync(entrypoint, "");
		writeFileSync(extensionPath, "fake extension");
		process.env.SIGNET_DAEMON_JS_PATH = entrypoint;

		expect(findSqliteVecExtension()).toBe(extensionPath);
	});
});
