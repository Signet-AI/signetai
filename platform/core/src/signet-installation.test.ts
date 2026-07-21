import { describe, expect, it } from "bun:test";
import { resolvePrimaryPackageManager } from "./package-manager";
import {
	detectSignetInstallations,
	inactivePackageManagerInstallations,
	packageManagerRemovalCommand,
} from "./signet-installation";

function existing(paths: readonly string[]): (path: string) => boolean {
	const known = new Set(paths);
	return (path) => known.has(path);
}

describe("detectSignetInstallations", () => {
	it("keeps a direct native executable active when an npm wrapper is also on PATH", () => {
		const nativePath = "/home/test/.local/bin/signet";
		const npmBin = "/home/test/.npm-global/bin/signet";
		const npmPackage = "/home/test/.npm-global/lib/node_modules/signetai";
		const report = detectSignetInstallations({
			execPath: nativePath,
			env: {
				HOME: "/home/test",
				PATH: "/home/test/.local/bin:/home/test/.npm-global/bin",
				SIGNET_DIR: "/home/test/.local",
			},
			home: "/home/test",
			platform: "linux",
			exists: existing([nativePath, npmBin]),
			realpath: (path) => (path === npmBin ? `${npmPackage}/bin/signet.js` : path),
		});

		expect(report.target).toEqual({ kind: "native", executablePath: nativePath });
		expect(inactivePackageManagerInstallations(report)).toEqual([
			{
				method: "npm",
				executablePath: npmBin,
				packagePath: npmPackage,
				active: false,
				removalCommand: "npm uninstall -g signetai",
			},
		]);
	});

	it("uses the package manager that owns the active executable without probing other managers", () => {
		const bunRoot = "/home/test/.bun";
		const activeBinary = `${bunRoot}/install/global/node_modules/@signetai/signet-darwin-arm64/bin/signet`;
		const bunBin = `${bunRoot}/bin/signet`;
		const npmBin = "/home/test/.npm-global/bin/signet";
		const report = detectSignetInstallations({
			execPath: activeBinary,
			env: {
				HOME: "/home/test",
				BUN_INSTALL: bunRoot,
				PATH: `${bunRoot}/bin:/home/test/.npm-global/bin`,
			},
			home: "/home/test",
			platform: "darwin",
			exists: existing([activeBinary, bunBin, npmBin]),
			realpath: (path) => {
				if (path === bunBin) return `${bunRoot}/install/global/node_modules/signetai/bin/signet.js`;
				if (path === npmBin) return "/home/test/.npm-global/lib/node_modules/signetai/bin/signet.js";
				return path;
			},
		});

		expect(report.target).toEqual({
			kind: "package-manager",
			family: "bun",
			executablePath: activeBinary,
		});
		expect(report.installations.filter((installation) => installation.active)).toHaveLength(1);
		expect(report.inactive.some((installation) => installation.method === "npm")).toBe(true);
		expect(inactivePackageManagerInstallations(report)).toEqual([]);
	});

	it("ignores package trees whose Signet wrapper no longer exists", () => {
		const nativePath = "/home/test/.local/bin/signet";
		const report = detectSignetInstallations({
			execPath: nativePath,
			env: { HOME: "/home/test", PATH: "/home/test/.local/bin:/home/test/.npm-global/bin" },
			home: "/home/test",
			platform: "linux",
			exists: existing([nativePath]),
			realpath: (path) => path,
		});

		expect(report.inactive).toEqual([]);
	});

	it("uses the injected Windows platform when locating wrappers", () => {
		const activePath = "C:\\Users\\test\\AppData\\Local\\Programs\\Signet\\signet.exe";
		const npmBin = "C:\\npm\\signet.cmd";
		const report = detectSignetInstallations({
			execPath: activePath,
			env: { PATH: "C:\\npm", NPM_CONFIG_PREFIX: "C:\\npm" },
			home: "C:\\Users\\test",
			platform: "win32",
			exists: existing([activePath, npmBin]),
			realpath: (path) => path,
		});

		expect(report.target.kind).toBe("native");
		expect(report.inactive).toMatchObject([{ method: "npm", executablePath: npmBin }]);
	});

	it("recognizes the native package binary launched by a default Windows npm wrapper", () => {
		const npmRoot = "C:\\Users\\test\\AppData\\Roaming\\npm";
		const activePath = `${npmRoot}\\node_modules\\@signetai\\signet-win32-x64\\bin\\signet.exe`;
		const npmBin = `${npmRoot}\\signet.cmd`;
		const report = detectSignetInstallations({
			execPath: activePath,
			env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming", PATH: npmRoot },
			home: "C:\\Users\\test",
			platform: "win32",
			exists: existing([activePath, npmBin]),
			realpath: (path) => (path === npmBin ? `${npmRoot}\\node_modules\\signetai\\bin\\signet.js` : path),
		});

		expect(report.target).toEqual({
			kind: "package-manager",
			family: "npm",
			executablePath: activePath,
		});
		expect(report.inactive).toEqual([]);
	});

	it("reports source runtimes as unsupported update targets", () => {
		const report = detectSignetInstallations({
			execPath: "/usr/local/bin/bun",
			env: { HOME: "/home/test", PATH: "" },
			home: "/home/test",
			platform: "linux",
			exists: () => false,
			realpath: (path) => path,
		});

		expect(report.target.kind).toBe("unsupported");
		expect(report.inactive).toEqual([]);
	});

	it("shares package-manager path inference with primary manager resolution", () => {
		const cases = [
			{
				family: "npm" as const,
				executablePath: "/home/test/.npm-global/bin/signet",
				env: { NPM_CONFIG_PREFIX: "/home/test/.npm-global" },
			},
			{
				family: "bun" as const,
				executablePath: "/home/test/.bun/bin/signet",
				env: { BUN_INSTALL: "/home/test/.bun" },
			},
			{
				family: "pnpm" as const,
				executablePath: "/home/test/.local/share/pnpm/signet",
				env: { PNPM_HOME: "/home/test/.local/share/pnpm" },
			},
			{
				family: "yarn" as const,
				executablePath: "/home/test/.yarn/bin/signet",
				env: {},
			},
		];

		for (const testCase of cases) {
			const report = detectSignetInstallations({
				execPath: testCase.executablePath,
				env: testCase.env,
				home: "/home/test",
				platform: "linux",
				exists: existing([testCase.executablePath]),
				realpath: (path) => path,
			});
			const primary = resolvePrimaryPackageManager({
				execPath: testCase.executablePath,
				env: testCase.env,
				home: "/home/test",
				platform: "linux",
				commandExists: (command) => command === testCase.family,
			});

			expect(report.target).toMatchObject({ kind: "package-manager", family: testCase.family });
			expect(primary.family).toBe(testCase.family);
		}
	});

	it("uses documented custom Bun global roots in both consumers", () => {
		const executablePath = "/custom/bin/signet";
		const realPath = "/custom/global/node_modules/signetai/native/signet";
		const env = {
			BUN_INSTALL_BIN: "/custom/bin",
			BUN_INSTALL_GLOBAL_DIR: "/custom/global",
		};
		const report = detectSignetInstallations({
			execPath: executablePath,
			env,
			home: "/home/test",
			platform: "linux",
			exists: existing([executablePath]),
			realpath: () => realPath,
		});
		const primary = resolvePrimaryPackageManager({
			execPath: executablePath,
			env,
			home: "/home/test",
			platform: "linux",
			commandExists: (command) => command === "bun",
		});

		expect(report.target).toMatchObject({ kind: "package-manager", family: "bun" });
		expect(primary.family).toBe("bun");
	});

	it("does not treat package-manager names in native paths as ownership evidence", () => {
		for (const executablePath of [
			"/opt/bun/signet",
			"/srv/pnpm/signet",
			"/usr/local/yarn/signet",
			"/opt/node_modules/signet",
		]) {
			const report = detectSignetInstallations({
				execPath: executablePath,
				env: { PATH: "" },
				home: "/home/test",
				platform: "linux",
				exists: existing([executablePath]),
				realpath: (path) => path,
			});

			expect(report.target).toEqual({ kind: "native", executablePath });
		}
	});
});

describe("packageManagerRemovalCommand", () => {
	it("returns an explicit manual uninstall command for every supported wrapper", () => {
		expect(packageManagerRemovalCommand("npm")).toBe("npm uninstall -g signetai");
		expect(packageManagerRemovalCommand("bun")).toBe("bun remove -g signetai");
		expect(packageManagerRemovalCommand("pnpm")).toBe("pnpm remove -g signetai");
		expect(packageManagerRemovalCommand("yarn")).toBe("yarn global remove signetai");
	});
});
