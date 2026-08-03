import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
/**
 * Tests for update-system bug fixes.
 *
 * These tests exercise the exported pure/config functions directly.
 * Network-dependent functions are mostly covered with structural tests,
 * but critical post-install behavior should be exercised directly.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseExecutableVersion, parseNativeReleaseManifest, verifyExecutableVersion } from "./update-install";
import {
	MAX_UPDATE_INTERVAL_SECONDS,
	MIN_UPDATE_INTERVAL_SECONDS,
	canUpdateDesktopFromSourceSync,
	categorizeUpdateError,
	detectDesktopInstall,
	finalizeSuccessfulUpdateInstall,
	getUpdateState,
	initUpdateSystem,
	normalizeTargetVersion,
	npmTagForUpdateChannel,
	parseBooleanFlag,
	parseUpdateChannel,
	parseUpdateInterval,
	runUpdate,
	selectUpdateTarget,
	updateDesktopInstallAfterUpdate,
} from "./update-system";

const UPDATE_SYSTEM_SRC = readFileSync(join(__dirname, "update-system.ts"), "utf-8");
const UPDATE_INSTALL_SRC = readFileSync(join(__dirname, "update-install.ts"), "utf-8");
const SERVICE_SRC = readFileSync(join(__dirname, "service.ts"), "utf-8");

function mustMatch(src: string, pattern: RegExp): string {
	const match = src.match(pattern);
	expect(match).not.toBeNull();
	if (!match) {
		throw new Error(`expected source to match ${pattern}`);
	}
	return match[0];
}

describe("Bug 5: pendingRestartVersion is set only after successful verification", () => {
	it("does not gate pendingRestartVersion on targetVersion", () => {
		const hasOldGuard = /if\s*\(\s*targetVersion\s*\)\s*\{?\s*\n?\s*pendingRestartVersion\s*=/.test(UPDATE_SYSTEM_SRC);
		expect(hasOldGuard).toBe(false);
	});

	it("sets pendingRestartVersion from verified installed version", () => {
		expect(UPDATE_SYSTEM_SRC).toContain("pendingRestartVersion = installedVersion");
	});
});

describe("Issue 322: verify installed version after update install", () => {
	it("prefers the direct native install when an npm daemon coexists with it", () => {
		expect(
			selectUpdateTarget({
				target: {
					kind: "package-manager",
					family: "npm",
					executablePath: "/opt/homebrew/lib/node_modules/signetai/native/signet",
				},
				installations: [],
				inactive: [
					{
						method: "native",
						executablePath: "/Users/test/.local/bin/signet",
						active: false,
					},
				],
			}),
		).toEqual({ kind: "native", executablePath: "/Users/test/.local/bin/signet" });
	});

	it("pins install command to targetVersion when provided", () => {
		expect(UPDATE_INSTALL_SRC).toContain("const installPackage = `${settings.packageName}@${version}`");
		expect(UPDATE_SYSTEM_SRC).toContain("detectSignetInstallations()");
	});

	it("verifies installed package version after exit code 0", () => {
		expect(UPDATE_SYSTEM_SRC).toContain("verifyExecutableVersion(");
		expect(UPDATE_SYSTEM_SRC).toContain("activeExecutablePath");
	});

	it("syncs the managed Signet source checkout after a successful update", async () => {
		const workspaceDir = join(tmpdir(), `signet-update-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const calls: string[] = [];
		initUpdateSystem("0.78.0", workspaceDir);

		const result = await finalizeSuccessfulUpdateInstall(
			"0.78.1",
			"installed ok",
			{
				installMethod: "native",
				activeExecutablePath: "/home/test/.local/bin/signet",
			},
			{
				syncWorkspaceSourceRepoAsync: async (dir) => {
					calls.push(dir);
					return {
						status: "current",
						path: join(dir, "signetai"),
						message: "Signet source checkout is already current",
						branch: "main",
						defaultBranch: "main",
					};
				},
				updateDesktopInstallAfterUpdate: async () => ({
					status: "skipped",
					message: "Signet desktop app is not installed",
				}),
			},
		);

		expect(calls).toEqual([workspaceDir]);
		expect(result).toEqual({
			success: true,
			message: "Update installed. Restart daemon to apply.",
			output: "installed ok",
			installedVersion: "0.78.1",
			restartRequired: true,
			installMethod: "native",
			activeExecutablePath: "/home/test/.local/bin/signet",
			activeExecutableVerified: true,
			observedVersion: "0.78.1",
			desktopUpdate: {
				status: "skipped",
				message: "Signet desktop app is not installed",
			},
		});
		expect(getUpdateState().pendingRestartVersion).toBe("0.78.1");
	});

	it("attempts managed desktop update after source checkout sync", async () => {
		const workspaceDir = join(tmpdir(), `signet-update-desktop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const calls: string[] = [];
		initUpdateSystem("0.78.0", workspaceDir);

		const result = await finalizeSuccessfulUpdateInstall(
			"0.78.1",
			"installed ok",
			{
				installMethod: "npm",
				activeExecutablePath: "/npm/native/signet",
			},
			{
				syncWorkspaceSourceRepoAsync: async (dir) => ({
					status: "pulled",
					path: join(dir, "signetai"),
					message: "fast-forwarded Signet source checkout",
					branch: "main",
					defaultBranch: "main",
				}),
				updateDesktopInstallAfterUpdate: async (repoSync, version, activeExecutablePath) => {
					calls.push(`${version}@${repoSync.path}:${activeExecutablePath}`);
					return {
						status: "updated",
						message: `Signet desktop app updated to v${version}.`,
					};
				},
			},
		);

		expect(calls).toEqual([`0.78.1@${join(workspaceDir, "signetai")}:/npm/native/signet`]);
		expect(result.success).toBe(true);
		if (!result.success) throw new Error(result.message);
		expect(result.desktopUpdate).toEqual({
			status: "updated",
			message: "Signet desktop app updated to v0.78.1.",
		});
	});
});

describe("desktop update integration", () => {
	it("detects absent, managed, and unmanaged Linux desktop installs", () => {
		const home = "/home/tester";
		const launcher = join(home, ".local", "bin", "signet-desktop");
		const appImage = join(home, ".local", "share", "signet", "desktop", "Signet.AppImage");

		expect(
			detectDesktopInstall(home, {
				existsSync: () => false,
				readFileSync: () => "",
			}),
		).toMatchObject({ installed: false, managed: false });

		expect(
			detectDesktopInstall(home, {
				existsSync: (path) => path === launcher,
				readFileSync: () => "# signet-desktop managed launcher\n",
			}),
		).toMatchObject({ installed: true, managed: true });

		expect(
			detectDesktopInstall(home, {
				existsSync: (path) => path === appImage,
				readFileSync: () => "",
			}),
		).toMatchObject({
			installed: true,
			managed: false,
			reason: "Signet desktop AppImage exists without a managed launcher",
		});

		expect(
			detectDesktopInstall(home, {
				existsSync: (path) => path === launcher,
				readFileSync: () => "#!/usr/bin/env sh\nexec /custom/Signet.AppImage\n",
			}),
		).toMatchObject({ installed: true, managed: false });
	});

	it("only updates desktop from a current or fast-forwarded source checkout", () => {
		expect(canUpdateDesktopFromSourceSync("cloned")).toBe(true);
		expect(canUpdateDesktopFromSourceSync("pulled")).toBe(true);
		expect(canUpdateDesktopFromSourceSync("current")).toBe(true);
		expect(canUpdateDesktopFromSourceSync("fetched")).toBe(false);
		expect(canUpdateDesktopFromSourceSync("skipped")).toBe(false);
		expect(canUpdateDesktopFromSourceSync("error")).toBe(false);
	});

	it("runs the installed Signet CLI desktop installer for managed installs", async () => {
		const home = "/home/tester";
		const repo = "/workspace/signetai";
		const launcher = join(home, ".local", "bin", "signet-desktop");
		const signetBin = "/pkg/bin/signet.js";
		const calls: string[] = [];
		initUpdateSystem("0.78.0", "/workspace");

		const result = await updateDesktopInstallAfterUpdate(
			{
				status: "pulled",
				path: repo,
				message: "fast-forwarded Signet source checkout",
				branch: "main",
				defaultBranch: "main",
			},
			"0.78.1",
			{
				home,
				env: { SIGNET_DAEMON_ENTRYPOINT: "1" },
				execPath: "/usr/bin/node",
				existsSync: (path) => path === launcher || path === signetBin,
				readFileSync: () => "# signet-desktop managed launcher\n",
				resolvePrimaryPackageManager: () => ({
					family: "bun",
					source: "fallback",
					reason: "test",
					available: { bun: true, npm: false, pnpm: false, yarn: false },
				}),
				resolveGlobalPackagePath: () => "/pkg",
				runCommand: async (command, args, options) => {
					expect(options.env.SIGNET_DAEMON_ENTRYPOINT).toBeUndefined();
					calls.push(`${command} ${args.join(" ")} @ ${options.cwd}`);
					return { exitCode: 0, stdout: "desktop installed", stderr: "", timedOut: false };
				},
			},
		);

		expect(result).toEqual({
			status: "updated",
			message: "Signet desktop app updated to v0.78.1.",
			output: "desktop installed",
		});
		expect(calls).toEqual([`/usr/bin/node ${signetBin} desktop install --repo ${repo} @ ${repo}`]);
	});

	it("skips desktop update when the source checkout was not fast-forwarded", async () => {
		const calls: string[] = [];
		const result = await updateDesktopInstallAfterUpdate(
			{
				status: "fetched",
				path: "/workspace/signetai",
				message: "skipped pull because the working tree has local changes",
				branch: "main",
				defaultBranch: "main",
			},
			"0.78.1",
			{
				home: "/home/tester",
				existsSync: () => true,
				readFileSync: () => "# signet-desktop managed launcher\n",
				runCommand: async () => {
					calls.push("ran");
					return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
				},
			},
		);

		expect(result.status).toBe("skipped");
		expect(result.message).toContain("source checkout sync status was 'fetched'");
		expect(calls).toEqual([]);
	});
});

describe("active executable update targeting", () => {
	const version = "0.78.1";
	const activeNative = "/home/test/.local/bin/signet";

	function manifestFor(binary: Buffer, sha256?: string): string {
		return JSON.stringify({
			schemaVersion: 1,
			version,
			assets: [
				{
					name: "signet-linux-x64",
					platform: "linux-x64",
					sha256: sha256 ?? createHash("sha256").update(binary).digest("hex"),
					size: binary.length,
				},
			],
			components: {},
		});
	}

	function successResult(installMethod: "native" | "bun", activeExecutablePath: string) {
		return {
			success: true as const,
			message: "Update installed. Restart daemon to apply.",
			installedVersion: version,
			restartRequired: true,
			installMethod,
			activeExecutablePath,
			activeExecutableVerified: true as const,
			observedVersion: version,
		};
	}

	it("updates a direct native target without invoking npm", async () => {
		const binary = Buffer.from("fake-native-binary");
		const temp = mkdtempSync(join(tmpdir(), "signet-native-update-test-"));
		const commands: string[] = [];
		initUpdateSystem("0.78.0", temp);

		const result = await runUpdate(version, {
			detectInstallations: () => ({
				target: {
					kind: "native",
					executablePath: activeNative,
				},
				installations: [
					{
						method: "native",
						executablePath: activeNative,
						active: true,
					},
					{
						method: "npm",
						executablePath: "/home/test/.npm-global/bin/signet",
						packagePath: "/home/test/.npm-global/lib/node_modules/signetai",
						active: false,
						removalCommand: "rm -f -- '/home/test/.npm-global/bin/signet'",
					},
				],
				inactive: [],
			}),
			platform: "linux",
			arch: "x64",
			downloadBase: "https://release.test/v0.78.1",
			env: {
				SIGNET_DAEMON_ENTRYPOINT: "1",
				SIGNET_VERSION: "0.78.0",
				SIGNET_DOWNLOAD_BASE: "https://release.test/v0.78.1",
			},
			createTempDir: async () => temp,
			fetch: (async (input) => {
				const url = String(input);
				if (url.endsWith("/native-manifest.json")) {
					return new Response(manifestFor(binary));
				}
				if (url.endsWith("/signet-linux-x64")) {
					return new Response(binary);
				}
				return new Response("not found", { status: 404 });
			}) as typeof fetch,
			runCommand: async (command, args, options) => {
				expect(options.env?.SIGNET_DAEMON_ENTRYPOINT).toBeUndefined();
				expect(options.env?.SIGNET_VERSION).toBeUndefined();
				commands.push(`${command} ${args.join(" ")}`);
				if (args[0] === "--version") {
					return {
						exitCode: 0,
						stdout: `${version}\n`,
						stderr: "",
						timedOut: false,
					};
				}
				return {
					exitCode: 0,
					stdout: "installed",
					stderr: "",
					timedOut: false,
				};
			},
			finalizeSuccessfulUpdate: async (installedVersion, _output, metadata) => {
				expect(installedVersion).toBe(version);
				expect(metadata).toEqual({
					installMethod: "native",
					activeExecutablePath: activeNative,
				});
				return successResult("native", activeNative);
			},
		});

		expect(result.success).toBe(true);
		expect(commands.some((command) => command.startsWith("npm "))).toBe(false);
		expect(commands.at(-1)).toBe(`${activeNative} --version`);
		expect(
			commands.some((command) => command.includes(`install --bin-dir ${join("/home/test/.local/bin")} --force`)),
		).toBe(true);
		expect(existsSync(temp)).toBe(false);
	});

	it("keeps the package manager that owns the active executable", async () => {
		const activeExecutable = "/home/test/.bun/install/global/node_modules/signetai/native/signet";
		const commands: string[] = [];
		const temp = mkdtempSync(join(tmpdir(), "signet-bun-update-test-"));
		initUpdateSystem("0.78.0", temp);
		try {
			const result = await runUpdate(version, {
				detectInstallations: () => ({
					target: {
						kind: "package-manager",
						family: "bun",
						executablePath: activeExecutable,
					},
					installations: [],
					inactive: [],
				}),
				runCommand: async (command, args) => {
					commands.push(`${command} ${args.join(" ")}`);
					return args[0] === "--version"
						? {
								exitCode: 0,
								stdout: `${version}\n`,
								stderr: "",
								timedOut: false,
							}
						: {
								exitCode: 0,
								stdout: "installed",
								stderr: "",
								timedOut: false,
							};
				},
				finalizeSuccessfulUpdate: async () => successResult("bun", activeExecutable),
			});

			expect(result.success).toBe(true);
			expect(commands[0]).toBe(`bun add -g signetai@${version}`);
			expect(commands[1]).toBe(`${activeExecutable} --version`);
			expect(commands.some((command) => command.startsWith("npm "))).toBe(false);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("does not mark the active executable verified when it reports another version", async () => {
		const activeExecutable = "/home/test/.bun/install/global/node_modules/signetai/native/signet";
		const temp = mkdtempSync(join(tmpdir(), "signet-version-mismatch-test-"));
		initUpdateSystem("0.78.0", temp);
		const pendingVersionBeforeAttempt = getUpdateState().pendingRestartVersion;
		try {
			const result = await runUpdate(version, {
				detectInstallations: () => ({
					target: {
						kind: "package-manager",
						family: "bun",
						executablePath: activeExecutable,
					},
					installations: [],
					inactive: [],
				}),
				runCommand: async (_command, args) =>
					args[0] === "--version"
						? {
								exitCode: 0,
								stdout: "0.78.0\n",
								stderr: "",
								timedOut: false,
							}
						: {
								exitCode: 0,
								stdout: "installed",
								stderr: "",
								timedOut: false,
							},
			});

			expect(result).toMatchObject({
				success: false,
				errorCode: "verification_failed",
				activeExecutableVerified: false,
				observedVersion: "0.78.0",
			});
			expect(getUpdateState().pendingRestartVersion).toBe(pendingVersionBeforeAttempt);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("rejects a checksum mismatch before running the downloaded binary", async () => {
		const binary = Buffer.from("tampered-native-binary");
		const temp = mkdtempSync(join(tmpdir(), "signet-bad-sha-update-test-"));
		const commands: string[] = [];
		initUpdateSystem("0.78.0", temp);

		const result = await runUpdate(version, {
			detectInstallations: () => ({
				target: {
					kind: "native",
					executablePath: activeNative,
				},
				installations: [],
				inactive: [],
			}),
			platform: "linux",
			arch: "x64",
			downloadBase: "https://release.test/v0.78.1",
			createTempDir: async () => temp,
			fetch: (async (input) =>
				String(input).endsWith("/native-manifest.json")
					? new Response(manifestFor(binary, "0".repeat(64)))
					: new Response(binary)) as typeof fetch,
			runCommand: async (command, args) => {
				commands.push(`${command} ${args.join(" ")}`);
				return {
					exitCode: 0,
					stdout: "",
					stderr: "",
					timedOut: false,
				};
			},
		});

		expect(result).toMatchObject({
			success: false,
			errorCode: "checksum_mismatch",
			activeExecutableVerified: false,
		});
		expect(commands).toEqual([]);
		rmSync(temp, { recursive: true, force: true });
	});

	it("keeps the active binary when a download is interrupted", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-interrupted-update-test-"));
		const activeExecutable = join(root, "bin", "signet");
		const expectedBinary = Buffer.from("complete-native-binary");
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(activeExecutable, "old-native-binary");
		initUpdateSystem("0.78.0", root);

		try {
			const result = await runUpdate(version, {
				detectInstallations: () => ({
					target: {
						kind: "native",
						executablePath: activeExecutable,
					},
					installations: [],
					inactive: [],
				}),
				platform: "linux",
				arch: "x64",
				downloadBase: "https://release.test/v0.78.1",
				fetch: (async (input) => {
					if (String(input).endsWith("/native-manifest.json")) {
						return new Response(manifestFor(expectedBinary));
					}
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode("partial"));
								controller.error(new Error("connection reset"));
							},
						}),
					);
				}) as typeof fetch,
			});

			expect(result).toMatchObject({
				success: false,
				errorCode: "download_failed",
				activeExecutableVerified: false,
			});
			expect(readFileSync(activeExecutable, "utf8")).toBe("old-native-binary");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("installs and verifies a downloaded native binary through the active path", async () => {
		if (process.platform === "win32") return;

		const root = mkdtempSync(join(tmpdir(), "signet-native-update-e2e-"));
		const activeExecutable = join(root, "bin", "signet");
		const newBinary = Buffer.from(`#!/bin/sh
set -eu
if [ "\${1:-}" = "install" ]; then
	shift
	bin_dir=""
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--bin-dir) bin_dir="$2"; shift 2 ;;
			--force) shift ;;
			*) shift ;;
		esac
	done
	cp "$0" "$bin_dir/.signet-update-test"
	chmod +x "$bin_dir/.signet-update-test"
	mv "$bin_dir/.signet-update-test" "$bin_dir/signet"
	exit 0
fi
if [ "\${1:-}" = "--version" ]; then
	echo "${version}"
	exit 0
fi
exit 1
`);
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(activeExecutable, '#!/bin/sh\n[ "${1:-}" = "--version" ] && echo 0.78.0\n');
		chmodSync(activeExecutable, 0o755);
		initUpdateSystem("0.78.0", root);

		try {
			const result = await runUpdate(version, {
				detectInstallations: () => ({
					target: {
						kind: "native",
						executablePath: activeExecutable,
					},
					installations: [],
					inactive: [],
				}),
				platform: "linux",
				arch: "x64",
				downloadBase: "https://release.test/v0.78.1",
				fetch: (async (input) =>
					String(input).endsWith("/native-manifest.json")
						? new Response(manifestFor(newBinary))
						: new Response(newBinary)) as typeof fetch,
				finalizeSuccessfulUpdate: async () => successResult("native", activeExecutable),
			});

			expect(result).toMatchObject({
				success: true,
				activeExecutablePath: activeExecutable,
				activeExecutableVerified: true,
				observedVersion: version,
			});
			const observed = spawnSync(activeExecutable, ["--version"], {
				encoding: "utf8",
			});
			expect(observed.status).toBe(0);
			expect(observed.stdout.trim()).toBe(version);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("native update validation", () => {
	it("requires the manifest version, platform, checksum, and bounded size", () => {
		const binary = Buffer.from("binary");
		const sha256 = createHash("sha256").update(binary).digest("hex");
		const valid = JSON.stringify({
			schemaVersion: 1,
			version: "1.2.3",
			assets: [
				{
					name: "signet-darwin-arm64",
					platform: "darwin-arm64",
					sha256,
					size: binary.length,
				},
			],
			components: {},
		});

		expect(parseNativeReleaseManifest(valid, "1.2.3", "darwin-arm64")).toMatchObject({
			version: "1.2.3",
			asset: {
				name: "signet-darwin-arm64",
				sha256,
				size: binary.length,
			},
		});
		expect(() => parseNativeReleaseManifest(valid, "1.2.4", "darwin-arm64")).toThrow("version does not match");
	});

	it("verifies the exact version reported by the active path", async () => {
		expect(parseExecutableVersion("v1.2.3\n")).toBe("1.2.3");
		expect(parseExecutableVersion("1.2.3-rc.1+build.7\n")).toBe("1.2.3-rc.1+build.7");
		expect(parseExecutableVersion("Signet 1.2.3")).toBeNull();
		for (const invalid of ["01.2.3", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+build..7"]) {
			expect(parseExecutableVersion(invalid)).toBeNull();
		}

		const mismatch = await verifyExecutableVersion("/home/test/.local/bin/signet", "1.2.3", {
			runCommand: async () => ({
				exitCode: 0,
				stdout: "1.2.2\n",
				stderr: "",
				timedOut: false,
			}),
		});
		expect(mismatch).toMatchObject({ ok: false, observedVersion: "1.2.2" });
		if (!mismatch.ok) {
			expect(mismatch.message).toContain("is 1.2.2, expected 1.2.3");
		}
	});

	it("does not let the current daemon version override the installed binary version", async () => {
		const verification = await verifyExecutableVersion("/home/test/.local/bin/signet", "1.2.3", {
			env: {
				signet_daemon_entrypoint: "1",
				Signet_Version: "1.2.2",
				SIGNET_DOWNLOAD_BASE: "https://release.test/v1.2.3",
			},
			runCommand: async (_command, _args, options) => {
				expect(
					Object.keys(options.env ?? {}).some((key) =>
						["SIGNET_DAEMON_ENTRYPOINT", "SIGNET_VERSION"].includes(key.toUpperCase()),
					),
				).toBe(false);
				expect(options.env?.SIGNET_DOWNLOAD_BASE).toBe("https://release.test/v1.2.3");
				return {
					exitCode: 0,
					stdout: "1.2.3\n",
					stderr: "",
					timedOut: false,
				};
			},
		});

		expect(verification).toEqual({ ok: true, installedVersion: "1.2.3" });
	});

	it("retries transient Windows launch failures within one timeout budget", async () => {
		let attempts = 0;
		let clock = 1_000;
		const commandTimeouts: number[] = [];
		const verification = await verifyExecutableVersion("C:\\Signet\\signet.exe", "1.2.3", {
			platform: "win32",
			timeoutMs: 1_000,
			now: () => clock,
			wait: async (delayMs) => {
				clock += delayMs;
			},
			runCommand: async (_command, _args, options) => {
				attempts += 1;
				commandTimeouts.push(options.timeoutMs);
				clock += 100;
				return attempts < 3
					? {
							exitCode: null,
							stdout: "",
							stderr: "",
							errorMessage: "EPERM: executable is temporarily locked",
							timedOut: false,
						}
					: {
							exitCode: 0,
							stdout: "1.2.3\n",
							stderr: "",
							timedOut: false,
						};
			},
		});

		expect(verification).toEqual({ ok: true, installedVersion: "1.2.3" });
		expect(attempts).toBe(3);
		expect(commandTimeouts).toEqual([1_000, 650, 300]);
	});

	it("reports uncertain Windows install state after bounded verification failures", async () => {
		let attempts = 0;
		const verification = await verifyExecutableVersion("C:\\Signet\\signet.exe", "1.2.3", {
			platform: "win32",
			wait: async () => {},
			runCommand: async () => {
				attempts += 1;
				return {
					exitCode: null,
					stdout: "",
					stderr: "",
					errorMessage: "EPERM: executable is temporarily locked",
					timedOut: false,
				};
			},
		});

		expect(attempts).toBe(3);
		expect(verification.ok).toBe(false);
		if (!verification.ok) {
			expect(verification.message).toContain("after 3 attempts");
			expect(verification.message).toContain("replacement may already have succeeded");
			expect(verification.message).toContain("stop or restart the daemon");
		}
	});

	it("does not retry on POSIX or after a valid version mismatch", async () => {
		let posixAttempts = 0;
		const posixFailure = await verifyExecutableVersion("/home/test/.local/bin/signet", "1.2.3", {
			platform: "linux",
			runCommand: async () => {
				posixAttempts += 1;
				return {
					exitCode: null,
					stdout: "",
					stderr: "",
					errorMessage: "EACCES",
					timedOut: false,
				};
			},
		});
		expect(posixAttempts).toBe(1);
		expect(posixFailure.ok).toBe(false);

		let windowsMismatchAttempts = 0;
		const windowsMismatch = await verifyExecutableVersion("C:\\Signet\\signet.exe", "1.2.3", {
			platform: "win32",
			wait: async () => {},
			runCommand: async () => {
				windowsMismatchAttempts += 1;
				return {
					exitCode: 0,
					stdout: "1.2.2\n",
					stderr: "",
					timedOut: false,
				};
			},
		});
		expect(windowsMismatchAttempts).toBe(1);
		expect(windowsMismatch).toMatchObject({ ok: false, observedVersion: "1.2.2" });
	});
});

describe("Bug 3: auto-restart after successful install", () => {
	it("calls process.exit(0) in runAutoUpdateCycle after success", () => {
		// Extract the runAutoUpdateCycle function body
		const cycleBody = mustMatch(UPDATE_SYSTEM_SRC, /async function runAutoUpdateCycle[\s\S]*?^}/m);

		// Must contain process.exit(0) for auto-restart
		expect(cycleBody).toContain("process.exit(0)");
		// Must stop the timer before exiting
		expect(cycleBody).toContain("stopUpdateTimer()");
		// Exit should come after successful install check
		expect(cycleBody.indexOf("installResult.success")).toBeLessThan(cycleBody.indexOf("process.exit(0)"));
	});
});

describe("Bug 4: log level for disabled auto-updates", () => {
	it("uses logger.info (not debug) when auto-updates disabled", () => {
		// Find the startUpdateTimer function
		const timerBody = mustMatch(UPDATE_SYSTEM_SRC, /export function startUpdateTimer[\s\S]*?^}/m);

		// Should use info level, not debug
		expect(timerBody).not.toContain('logger.debug("system", "Auto-update disabled"');
		expect(timerBody).toContain("logger.info");
		expect(timerBody).toContain("signet update enable");
	});
});

describe("Bug 6: systemd unit uses dynamic runtime path", () => {
	it("does not hardcode /usr/bin/bun in systemd unit", () => {
		// The function generateSystemdUnit should NOT have a hardcoded path
		const hasHardcoded = SERVICE_SRC.includes('runtime === "bun" ? "/usr/bin/bun" : "/usr/bin/node"');
		expect(hasHardcoded).toBe(false);
	});

	it("does not hardcode /opt/homebrew/bin/bun in launchd plist", () => {
		const hasHardcoded = SERVICE_SRC.includes("/opt/homebrew/bin/bun");
		expect(hasHardcoded).toBe(false);
	});

	it("uses resolveRuntimePath() for both service types", () => {
		expect(SERVICE_SRC).toContain("function resolveRuntimePath()");
		// systemd
		expect(SERVICE_SRC).toMatch(/const runtimePath = resolveRuntimePath\(\)/);
		// launchd
		expect(SERVICE_SRC).toContain("${resolveRuntimePath()}");
	});

	it("resolveRuntimePath tries process.execPath first", () => {
		const fnBody = mustMatch(SERVICE_SRC, /function resolveRuntimePath[\s\S]*?^}/m);
		expect(fnBody).toContain("process.execPath");
		expect(fnBody).toContain('const locator = platform() === "win32" ? "where" : "which"');
		expect(fnBody).toContain("${locator} bun");
		expect(fnBody).toContain("${locator} node");
	});

	it("uses Restart=always instead of Restart=on-failure", () => {
		const unitBody = mustMatch(SERVICE_SRC, /function generateSystemdUnit[\s\S]*?^}/m);
		expect(unitBody).toContain("Restart=always");
		expect(unitBody).not.toContain("Restart=on-failure");
	});
});

describe("version parsing helpers", () => {
	it("normalizeTargetVersion strips leading v and validates format", () => {
		expect(normalizeTargetVersion("1.2.3")).toBe("1.2.3");
		expect(normalizeTargetVersion("v1.2.3")).toBe("1.2.3");
		expect(normalizeTargetVersion("V2.0.0-rc.1+build.7")).toBe("2.0.0-rc.1+build.7");
		expect(normalizeTargetVersion("latest")).toBeNull();
		expect(normalizeTargetVersion("1.2.x")).toBeNull();
		expect(normalizeTargetVersion("")).toBeNull();
		expect(normalizeTargetVersion("   ")).toBeNull();
		expect(normalizeTargetVersion("--1.2.3")).toBeNull();
		expect(normalizeTargetVersion("1.2.3 bad")).toBeNull();
		expect(normalizeTargetVersion("01.2.3")).toBeNull();
		expect(normalizeTargetVersion("1.2.3-01")).toBeNull();
		expect(normalizeTargetVersion("1.2.3-alpha..1")).toBeNull();
		expect(normalizeTargetVersion("1.2.3+build..7")).toBeNull();
	});
});

describe("config helpers", () => {
	it("parseBooleanFlag handles all cases", () => {
		expect(parseBooleanFlag(true)).toBe(true);
		expect(parseBooleanFlag(false)).toBe(false);
		expect(parseBooleanFlag("true")).toBe(true);
		expect(parseBooleanFlag("false")).toBe(false);
		expect(parseBooleanFlag("maybe")).toBeNull();
		expect(parseBooleanFlag(42)).toBeNull();
	});

	it("parseUpdateInterval enforces bounds", () => {
		expect(parseUpdateInterval(MIN_UPDATE_INTERVAL_SECONDS)).toBe(MIN_UPDATE_INTERVAL_SECONDS);
		expect(parseUpdateInterval(MAX_UPDATE_INTERVAL_SECONDS)).toBe(MAX_UPDATE_INTERVAL_SECONDS);
		expect(parseUpdateInterval(100)).toBeNull(); // Below min
		expect(parseUpdateInterval(999999999)).toBeNull(); // Above max
		expect(parseUpdateInterval("not a number")).toBeNull();
	});

	it("parseUpdateChannel normalizes product channels and legacy npm aliases", () => {
		expect(parseUpdateChannel("stable")).toBe("stable");
		expect(parseUpdateChannel("latest")).toBe("stable");
		expect(parseUpdateChannel("nightly")).toBe("nightly");
		expect(parseUpdateChannel("next")).toBe("nightly");
		expect(parseUpdateChannel("canary")).toBeNull();
		expect(parseUpdateChannel(undefined)).toBeNull();
	});

	it("maps update channels to npm dist-tags", () => {
		expect(npmTagForUpdateChannel("stable")).toBe("latest");
		expect(npmTagForUpdateChannel("nightly")).toBe("next");
	});

	it("only queries GitHub latest for the stable channel", () => {
		expect(UPDATE_SYSTEM_SRC).toContain('if (updateConfig.channel === "stable")');
		expect(UPDATE_SYSTEM_SRC).toContain("fetchStableFromGitHub()");
		expect(UPDATE_SYSTEM_SRC).toContain("fetchLatestFromNpm(updateConfig.channel)");
	});

	it("categorizeUpdateError classifies known patterns", () => {
		expect(categorizeUpdateError("403 Forbidden")).toContain("rate limit");
		expect(categorizeUpdateError("ENOTFOUND")).toContain("internet");
		expect(categorizeUpdateError("EACCES")).toContain("Permission");
		expect(categorizeUpdateError("timeout")).toContain("timed out");
		expect(categorizeUpdateError("something else")).toBe("something else");
	});
});
