import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isSignetManagedForgeRecord,
	loadForgeManifest,
	managedForgeAssetNameForPlatform,
	managedForgeInstallSupportedForPlatform,
	parseYesNoAnswer,
	readForgeVersionFromBinaryMetadata,
	restartForgeService,
	selectLatestStableForgeRelease,
	showForgeServiceStatus,
	startForgeService,
	stopForgeService,
	withManagedForgeInstallLock,
} from "./forge.js";
type ForgeDeps = Parameters<typeof startForgeService>[1];

const originalHome = process.env.HOME;

afterEach(() => {
	if (originalHome === undefined) {
		process.env.HOME = undefined;
	} else {
		process.env.HOME = originalHome;
	}
});

describe("managed Forge release asset selection", () => {
	it("maps the published managed targets to release assets", () => {
		expect(managedForgeAssetNameForPlatform("darwin", "arm64")).toBe("forge-macos-arm64.tar.gz");
		expect(managedForgeAssetNameForPlatform("darwin", "x64")).toBe("forge-macos-x64.tar.gz");
		expect(managedForgeAssetNameForPlatform("linux", "x64")).toBe("forge-linux-x64.tar.gz");
		expect(managedForgeAssetNameForPlatform("linux", "arm64")).toBe("forge-linux-arm64.tar.gz");
	});

	it("rejects unsupported managed targets with a clear platform list", () => {
		expect(() => managedForgeAssetNameForPlatform("linux", "ppc64")).toThrow(
			"signet forge install/update currently publishes managed binaries for macOS arm64, macOS x64, Linux x64, and Linux arm64.",
		);
	});

	it("exposes the managed-install support matrix for setup gating", () => {
		expect(managedForgeInstallSupportedForPlatform("darwin", "arm64")).toBe(true);
		expect(managedForgeInstallSupportedForPlatform("linux", "arm64")).toBe(true);
		expect(managedForgeInstallSupportedForPlatform("win32", "x64")).toBe(false);
	});
});

describe("managed Forge ownership", () => {
	it("requires a matching managed install record before update ownership is granted", () => {
		expect(
			isSignetManagedForgeRecord(
				{
					managed: true,
					binaryPath: "/tmp/forge",
					source: "github-release",
				},
				"/tmp/forge",
			),
		).toBe(true);
		expect(
			isSignetManagedForgeRecord(
				{
					managed: true,
					binaryPath: "/tmp/other-forge",
					source: "github-release",
				},
				"/tmp/forge",
			),
		).toBe(false);
		expect(
			isSignetManagedForgeRecord(
				{
					managed: true,
					binaryPath: "/tmp/forge",
					source: "manual-copy",
				},
				"/tmp/forge",
			),
		).toBe(false);
	});
});

describe("stable Forge release selection", () => {
	it("ignores drafts and prereleases when choosing the default managed release", () => {
		const release = selectLatestStableForgeRelease(
			[
				{
					tag_name: "forge-v2.0.0-rc.1",
					html_url: "https://example.test/rc",
					draft: false,
					prerelease: true,
					assets: [],
				},
				{
					tag_name: "forge-v1.9.1",
					html_url: "https://example.test/stable-newest",
					draft: false,
					prerelease: false,
					assets: [],
				},
				{
					tag_name: "forge-v2.0.0",
					html_url: "https://example.test/draft",
					draft: true,
					prerelease: false,
					assets: [],
				},
			],
			{ tagPrefix: "forge-v", repository: "Signet-AI/signetai" },
		);

		expect(release.version).toBe("1.9.1");
		expect(release.tag).toBe("forge-v1.9.1");
	});

	it("fails clearly when only prereleases are available", () => {
		expect(() =>
			selectLatestStableForgeRelease(
				[
					{
						tag_name: "forge-v2.0.0-rc.1",
						html_url: "https://example.test/rc",
						draft: false,
						prerelease: true,
						assets: [],
					},
				],
				{ tagPrefix: "forge-v", repository: "Signet-AI/signetai" },
			),
		).toThrow("No stable Forge releases found in Signet-AI/signetai");
	});
});

describe("managed Forge manifest resolution", () => {
	it("prefers packages/forge/forge-version.json over the template copy when available", () => {
		const tempTemplates = mkdtempSync(join(tmpdir(), "forge-manifest-"));
		try {
			mkdirSync(join(tempTemplates, "forge"), { recursive: true });
			writeFileSync(
				join(tempTemplates, "forge", "manifest.json"),
				JSON.stringify({
					version: "0.0.0-test",
					tagPrefix: "wrong-v",
					repository: "wrong/repo",
					binary: "wrong",
				}),
			);

			const manifest = loadForgeManifest(() => tempTemplates);

			expect(manifest.repository).toBe("Signet-AI/signetai");
			expect(manifest.tagPrefix).toBe("forge-v");
			expect(manifest.binary).toBe("forge");
		} finally {
			rmSync(tempTemplates, { recursive: true, force: true });
		}
	});
});

describe("managed Forge install lock", () => {
	it("recovers a stale lock left behind by a dead process", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "forge-home-"));
		process.env.HOME = tempHome;
		try {
			const lockDir = join(tempHome, ".config", "signet", "bin", ".forge-install.lock");
			mkdirSync(lockDir, { recursive: true });
			writeFileSync(
				join(lockDir, "owner.json"),
				JSON.stringify({
					pid: 999_999,
					createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
				}),
			);
			const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
			utimesSync(lockDir, staleTime, staleTime);

			const result = await withManagedForgeInstallLock(async () => "ok", tempHome);

			expect(result).toBe("ok");
			expect(existsSync(lockDir)).toBe(false);
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("recovers a stale lock when pid metadata is invalid", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "forge-home-"));
		process.env.HOME = tempHome;
		try {
			const lockDir = join(tempHome, ".config", "signet", "bin", ".forge-install.lock");
			mkdirSync(lockDir, { recursive: true });
			writeFileSync(
				join(lockDir, "owner.json"),
				JSON.stringify({
					pid: "not-a-pid",
					createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
				}),
			);
			const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
			utimesSync(lockDir, staleTime, staleTime);

			const result = await withManagedForgeInstallLock(async () => "ok", tempHome);

			expect(result).toBe("ok");
			expect(existsSync(lockDir)).toBe(false);
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("does not treat lock as stale when the recorded pid is still alive", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "forge-home-"));
		process.env.HOME = tempHome;
		try {
			const lockDir = join(tempHome, ".config", "signet", "bin", ".forge-install.lock");
			mkdirSync(lockDir, { recursive: true });
			writeFileSync(
				join(lockDir, "owner.json"),
				JSON.stringify({
					pid: process.pid,
					createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
				}),
			);
			const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
			utimesSync(lockDir, staleTime, staleTime);

			await expect(
				(async () => {
					await withManagedForgeInstallLock(async () => "ok", tempHome);
				})(),
			).rejects.toThrow("already running");

			expect(existsSync(lockDir)).toBe(true);
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});

describe("Forge version metadata parsing", () => {
	it("extracts a semver version from passive binary metadata without executing the binary", () => {
		const tempHome = mkdtempSync(join(tmpdir(), "forge-version-"));
		try {
			const binaryPath = join(tempHome, "forge");
			writeFileSync(binaryPath, "Forge binary marker forge-v1.2.3 and build notes");
			expect(readForgeVersionFromBinaryMetadata(binaryPath)).toBe("1.2.3");
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("does not over-select unrelated higher semver strings in binary metadata", () => {
		const tempHome = mkdtempSync(join(tmpdir(), "forge-version-"));
		try {
			const binaryPath = join(tempHome, "forge");
			writeFileSync(binaryPath, "forge-v1.2.3 dependency-9.9.9 forge 1.2.3");
			expect(readForgeVersionFromBinaryMetadata(binaryPath)).toBe("1.2.3");
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});

describe("Forge service commands", () => {
	function createForgeDeps(overrides: Partial<ForgeDeps> = {}): ForgeDeps {
		return {
			agentsDir: "/tmp/.agents",
			defaultPort: 3850,
			extractPathOption: () => null,
			getTemplatesDir: () => "/tmp/templates",
			normalizeAgentPath: (pathValue) => pathValue,
			isDaemonRunning: async () => false,
			getDaemonStatus: async () => ({
				running: false,
				pid: null,
				uptime: null,
				version: "0.0.0-test",
				host: "127.0.0.1",
				bindHost: "127.0.0.1",
				networkMode: "localhost",
			}),
			startDaemon: async () => true,
			stopDaemon: async () => true,
			...overrides,
		};
	}

	it("startForgeService skips start when daemon is already running", async () => {
		let startCalled = false;
		const deps = createForgeDeps({
			getDaemonStatus: async () => ({
				running: true,
				pid: 123,
				uptime: 50,
				version: "1.0.0",
				host: "127.0.0.1",
				bindHost: "127.0.0.1",
				networkMode: "localhost",
			}),
			startDaemon: async () => {
				startCalled = true;
				return true;
			},
		});
		await startForgeService({}, deps);
		expect(startCalled).toBe(false);
	});

	it("startForgeService calls startDaemon when daemon is not running", async () => {
		let startCalledWith: string | null = null;
		const deps = createForgeDeps({
			startDaemon: async (basePath) => {
				startCalledWith = basePath ?? null;
				return true;
			},
		});
		await startForgeService({}, deps);
		expect(startCalledWith).toBe("/tmp/.agents");
	});

	it("startForgeService throws when startDaemon fails", async () => {
		const deps = createForgeDeps({
			startDaemon: async () => false,
		});
		await expect(startForgeService({}, deps)).rejects.toThrow("Failed to start Forge service daemon.");
	});

	it("stopForgeService skips stop when daemon is not running", async () => {
		let stopCalled = false;
		const deps = createForgeDeps({
			stopDaemon: async () => {
				stopCalled = true;
				return true;
			},
		});
		await stopForgeService({}, deps);
		expect(stopCalled).toBe(false);
	});

	it("stopForgeService calls stopDaemon when daemon is running", async () => {
		let stopCalledWith: string | null = null;
		let statusCalls = 0;
		const deps = createForgeDeps({
			getDaemonStatus: async () => ({
				running: (statusCalls += 1) === 1,
				pid: 456,
				uptime: 50,
				version: "1.0.0",
				host: "127.0.0.1",
				bindHost: "127.0.0.1",
				networkMode: "localhost",
			}),
			stopDaemon: async (basePath) => {
				stopCalledWith = basePath ?? null;
				return true;
			},
		});
		await stopForgeService({}, deps);
		expect(stopCalledWith).toBe("/tmp/.agents");
	});

	it("stopForgeService warns when daemon remains running after stop signal", async () => {
		const deps = createForgeDeps({
			getDaemonStatus: async () => ({
				running: true,
				pid: 456,
				uptime: 50,
				version: "1.0.0",
				host: "127.0.0.1",
				bindHost: "127.0.0.1",
				networkMode: "localhost",
			}),
			stopDaemon: async (basePath) => {
				void basePath;
				return true;
			},
			stopWaitAttempts: 1,
			sleep: async () => {},
		});

		const originalWarn = console.warn;
		const originalLog = console.log;
		const warned: string[] = [];
		const logged: string[] = [];
		console.warn = (...args: unknown[]) => {
			warned.push(args.map((arg) => String(arg)).join(" "));
		};
		console.log = (...args: unknown[]) => {
			logged.push(args.map((arg) => String(arg)).join(" "));
		};
		try {
			await stopForgeService({}, deps);
		} finally {
			console.warn = originalWarn;
			console.log = originalLog;
		}
		expect(warned.some((line) => line.includes("stop initiated"))).toBe(true);
		expect(logged.some((line) => line.includes("✓ Forge service stopped"))).toBe(false);
		expect(logged.some((line) => line.includes("Stop signal sent"))).toBe(true);
	});

	it("stopForgeService throws when stopDaemon fails", async () => {
		const deps = createForgeDeps({
			getDaemonStatus: async () => ({
				running: true,
				pid: 456,
				uptime: 50,
				version: "1.0.0",
				host: "127.0.0.1",
				bindHost: "127.0.0.1",
				networkMode: "localhost",
			}),
			stopDaemon: async () => false,
		});
		await expect(stopForgeService({}, deps)).rejects.toThrow("Failed to stop Forge service daemon.");
	});

	it("restartForgeService stops then starts when daemon is running", async () => {
		const sequence: string[] = [];
		let running = true;
		const deps = createForgeDeps({
			getDaemonStatus: async () => ({
				running,
				pid: running ? 321 : null,
				uptime: running ? 50 : null,
				version: "1.0.0",
				host: "127.0.0.1",
				bindHost: "127.0.0.1",
				networkMode: "localhost",
			}),
			stopDaemon: async () => {
				sequence.push("stop");
				running = false;
				return true;
			},
			startDaemon: async () => {
				sequence.push("start");
				return true;
			},
		});
		await restartForgeService({}, deps);
		expect(sequence).toEqual(["stop", "start"]);
	});

	it("restartForgeService starts without stop when daemon is not running", async () => {
		let stopCalls = 0;
		let startCalls = 0;
		const deps = createForgeDeps({
			getDaemonStatus: async () => ({
				running: false,
				pid: null,
				uptime: null,
				version: "1.0.0",
				host: "127.0.0.1",
				bindHost: "127.0.0.1",
				networkMode: "localhost",
			}),
			stopDaemon: async () => {
				stopCalls += 1;
				return true;
			},
			startDaemon: async () => {
				startCalls += 1;
				return true;
			},
		});

		await restartForgeService({}, deps);
		expect(stopCalls).toBe(0);
		expect(startCalls).toBe(1);
	});

	it("restartForgeService throws when stopDaemon fails", async () => {
		const deps = createForgeDeps({
			getDaemonStatus: async () => ({
				running: true,
				pid: 321,
				uptime: 50,
				version: "1.0.0",
				host: "127.0.0.1",
				bindHost: "127.0.0.1",
				networkMode: "localhost",
			}),
			stopDaemon: async () => false,
			startDaemon: async () => true,
		});
		await expect(restartForgeService({}, deps)).rejects.toThrow("Failed to stop Forge service daemon.");
	});

	it("restartForgeService warns and proceeds when daemon remains running after stop-wait", async () => {
		let startCalls = 0;
		let stopCalls = 0;
		let statusCalls = 0;
		const deps = createForgeDeps({
			getDaemonStatus: async () => {
				statusCalls += 1;
				return {
					running: true,
					pid: 321,
					uptime: 50,
					version: "1.0.0",
					host: "127.0.0.1",
					bindHost: "127.0.0.1",
					networkMode: "localhost",
				};
			},
			stopDaemon: async () => {
				stopCalls += 1;
				return true;
			},
			startDaemon: async () => {
				startCalls += 1;
				return true;
			},
			stopWaitAttempts: 3,
			stopWaitIntervalMs: 1,
			sleep: async () => {},
		});

		const originalWarn = console.warn;
		const originalLog = console.log;
		const warned: string[] = [];
		const logged: string[] = [];
		console.warn = (...args: unknown[]) => {
			warned.push(args.map((arg) => String(arg)).join(" "));
		};
		console.log = (...args: unknown[]) => {
			logged.push(args.map((arg) => String(arg)).join(" "));
		};
		try {
			await restartForgeService({}, deps);
		} finally {
			console.warn = originalWarn;
			console.log = originalLog;
		}

		expect(stopCalls).toBe(1);
		expect(startCalls).toBe(1);
		expect(statusCalls).toBe(4);
		expect(warned.some((line) => line.includes("Daemon still running after stop wait"))).toBe(true);
		expect(logged.some((line) => line.includes("previous daemon may still be exiting"))).toBe(true);
	});

	it("restartForgeService treats status probe errors during stop-wait as daemon offline", async () => {
		let startCalls = 0;
		let stopCalls = 0;
		let statusCalls = 0;
		const deps = createForgeDeps({
			getDaemonStatus: async () => {
				statusCalls += 1;
				if (statusCalls === 1) {
					return {
						running: true,
						pid: 321,
						uptime: 50,
						version: "1.0.0",
						host: "127.0.0.1",
						bindHost: "127.0.0.1",
						networkMode: "localhost",
					};
				}
				throw new Error("status probe failed");
			},
			stopDaemon: async () => {
				stopCalls += 1;
				return true;
			},
			startDaemon: async () => {
				startCalls += 1;
				return true;
			},
			sleep: async () => {},
		});

		await restartForgeService({}, deps);
		expect(stopCalls).toBe(1);
		expect(startCalls).toBe(1);
		expect(statusCalls).toBe(2);
	});

	it("restartForgeService includes port hint when start fails after daemon stays running", async () => {
		let statusCalls = 0;
		const deps = createForgeDeps({
			defaultPort: 3850,
			getDaemonStatus: async () => {
				statusCalls += 1;
				return {
					running: true,
					pid: 321,
					uptime: 50,
					version: "1.0.0",
					host: "127.0.0.1",
					bindHost: "127.0.0.1",
					networkMode: "localhost",
				};
			},
			stopDaemon: async () => true,
			startDaemon: async () => false,
			sleep: async () => {},
		});

		await expect(restartForgeService({}, deps)).rejects.toThrow("holding port 3850");
		expect(statusCalls).toBeGreaterThan(1);
	});

	it("showForgeServiceStatus prints json payload when --json is set", async () => {
		const deps = createForgeDeps({
			getDaemonStatus: async () => ({
				running: true,
				pid: 999,
				uptime: 1234,
				version: "9.9.9",
				host: "localhost",
				bindHost: "0.0.0.0",
				networkMode: "localhost",
			}),
		});

		const originalLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map((arg) => String(arg)).join(" "));
		};
		try {
			await showForgeServiceStatus({ json: true }, deps);
		} finally {
			console.log = originalLog;
		}

		expect(lines.length).toBe(1);
		const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
		expect(parsed.running).toBe(true);
		expect(parsed.pid).toBe(999);
		expect(parsed.basePath).toBe("/tmp/.agents");
	});
});

describe("parseYesNoAnswer", () => {
	it("accepts yes variants", () => {
		expect(parseYesNoAnswer("yes")).toBe(true);
		expect(parseYesNoAnswer("Y")).toBe(true);
		expect(parseYesNoAnswer("  YeS  ")).toBe(true);
	});

	it("accepts no variants", () => {
		expect(parseYesNoAnswer("no")).toBe(false);
		expect(parseYesNoAnswer("N")).toBe(false);
		expect(parseYesNoAnswer("  No  ")).toBe(false);
	});

	it("rejects unknown answers", () => {
		expect(parseYesNoAnswer("")).toBeNull();
		expect(parseYesNoAnswer("maybe")).toBeNull();
		expect(parseYesNoAnswer("1")).toBeNull();
	});
});
