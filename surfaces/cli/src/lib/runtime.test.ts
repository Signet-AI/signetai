import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildLaunchdDaemonPlist,
	buildLaunchdDaemonStartArgs,
	buildLaunchdDaemonStopArgs,
	buildSystemdDaemonStartArgs,
	didLaunchdDaemonStart,
	didSystemdDaemonStart,
	getDaemonStatus,
	launchdDaemonPlistPath,
	readDaemonStartFailureDiagnostics,
	readManagedDaemonPid,
} from "./runtime.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("buildSystemdDaemonStartArgs", () => {
	it("starts daemon in a transient user service with explicit env and log routing", () => {
		const args = buildSystemdDaemonStartArgs({
			daemonPath: "/opt/signet/dist/daemon.js",
			agentsDir: "/home/user/.agents",
			port: 3850,
			host: "127.0.0.1",
			bind: "0.0.0.0",
			startupLogPath: "/home/user/.agents/.daemon/logs/startup.log",
		});

		expect(args).toContain("--user");
		expect(args).toContain("--collect");
		expect(args).toContain("--quiet");
		expect(args).toContain("--setenv=SIGNET_PORT=3850");
		expect(args).toContain("--setenv=SIGNET_HOST=127.0.0.1");
		expect(args).toContain("--setenv=SIGNET_BIND=0.0.0.0");
		expect(args).toContain("--setenv=SIGNET_PATH=/home/user/.agents");
		expect(args).toContain("--property=StandardError=append:/home/user/.agents/.daemon/logs/startup.log");
		expect(args.slice(-2)).toEqual([process.execPath, "/opt/signet/dist/daemon.js"]);
	});
});

describe("buildLaunchdDaemonPlist", () => {
	it("starts daemon as a macOS LaunchAgent with explicit env and log routing", () => {
		const plist = buildLaunchdDaemonPlist({
			daemonPath: "/opt/signet/dist/daemon.js",
			agentsDir: "/Users/user/.agents",
			port: 3850,
			host: "127.0.0.1",
			bind: "0.0.0.0",
			startupLogPath: "/Users/user/.agents/.daemon/logs/startup.log",
			label: "ai.signet.daemon.test",
		});

		expect(plist).toContain("<key>Label</key>");
		expect(plist).toContain("<string>ai.signet.daemon.test</string>");
		expect(plist).toContain("<key>ProgramArguments</key>");
		expect(plist).toContain(`<string>${process.execPath}</string>`);
		expect(plist).toContain("<string>/opt/signet/dist/daemon.js</string>");
		expect(plist).not.toContain("/bin/bash");
		expect(plist).not.toContain("exec");
		expect(plist).toContain("<key>SIGNET_PORT</key>");
		expect(plist).toContain("<string>3850</string>");
		expect(plist).toContain("<key>SIGNET_HOST</key>");
		expect(plist).toContain("<string>127.0.0.1</string>");
		expect(plist).toContain("<key>SIGNET_BIND</key>");
		expect(plist).toContain("<string>0.0.0.0</string>");
		expect(plist).toContain("<key>SIGNET_PATH</key>");
		expect(plist).toContain("<string>/Users/user/.agents</string>");
		expect(plist).toContain("<key>HOME</key>");
		expect(plist).toContain("<key>RunAtLoad</key>");
		expect(plist).toContain("<true/>");
		expect(plist).toContain("<key>KeepAlive</key>");
		expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
		expect(plist).toContain("<key>StandardErrorPath</key>");
		expect(plist).toContain("<string>/Users/user/.agents/.daemon/logs/startup.log</string>");
	});

	it("invokes runtime directly without bash wrapper", () => {
		const plist = buildLaunchdDaemonPlist({
			daemonPath: "/opt/signet/dist/daemon.js",
			agentsDir: "/Users/user/.agents",
			port: 3850,
			host: "127.0.0.1",
			bind: "0.0.0.0",
			startupLogPath: "/Users/user/.agents/.daemon/logs/startup.log",
		});

		const programArgsMatch = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
		expect(programArgsMatch).not.toBeNull();

		const inner = programArgsMatch?.[1] ?? "";
		const strings = [...inner.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
		expect(strings).toHaveLength(2);
		expect(strings[0]).toBe(process.execPath);
		expect(strings[1]).toBe("/opt/signet/dist/daemon.js");
		expect(strings[0]).toMatch(/^\//);
	});

	it("uses a persistent user LaunchAgent path", () => {
		expect(launchdDaemonPlistPath("/Users/user/.agents", "/Users/user")).toBe(
			"/Users/user/Library/LaunchAgents/ai.signet.daemon.plist",
		);
	});

	it("uses launchctl bootstrap against the current user launchd domain", () => {
		const args = buildLaunchdDaemonStartArgs("/Users/user/Library/LaunchAgents/ai.signet.daemon.plist");
		expect(args[0]).toBe("bootstrap");
		expect(args[1]).toStartWith("gui/");
		expect(args[2]).toBe("/Users/user/Library/LaunchAgents/ai.signet.daemon.plist");
	});

	it("uses launchctl bootout against the current user launchd service", () => {
		const args = buildLaunchdDaemonStopArgs();
		expect(args[0]).toBe("bootout");
		expect(args[1]).toStartWith("gui/");
		expect(args[1]).toEndWith("/ai.signet.daemon");
	});
});

describe("didLaunchdDaemonStart", () => {
	it("only treats clean launchctl exits as successful daemon ownership", () => {
		expect(didLaunchdDaemonStart({ status: 0, signal: null, error: undefined })).toBe(true);
		expect(didLaunchdDaemonStart({ status: 1, signal: null, error: undefined })).toBe(false);
		expect(didLaunchdDaemonStart({ status: null, signal: "SIGTERM", error: undefined })).toBe(false);
		expect(didLaunchdDaemonStart({ status: null, signal: null, error: new Error("spawn timed out") })).toBe(false);
	});
});

describe("didSystemdDaemonStart", () => {
	it("only treats clean systemd-run exits as successful daemon ownership", () => {
		expect(didSystemdDaemonStart({ status: 0, signal: null, error: undefined })).toBe(true);
		expect(didSystemdDaemonStart({ status: 1, signal: null, error: undefined })).toBe(false);
		expect(didSystemdDaemonStart({ status: null, signal: "SIGTERM", error: undefined })).toBe(false);
		expect(didSystemdDaemonStart({ status: null, signal: null, error: new Error("spawn timed out") })).toBe(false);
	});
});

describe("readDaemonStartFailureDiagnostics", () => {
	it("prefers startup log stderr when present", () => {
		const lines = readDaemonStartFailureDiagnostics(
			{ startupLogPath: "/tmp/startup.log", platform: "linux", systemdUnitName: "signet-daemon-test" },
			{
				existsSync: () => true,
				readFileSync: () => "first\nsecond\n",
				spawnSync: () => ({ stdout: "" }),
			},
		);

		expect(lines).toEqual(["Daemon failed to start. stderr output:", "first", "second"]);
	});

	it("falls back to the transient systemd unit journal when startup log is empty", () => {
		let command = "";
		let args: readonly string[] = [];
		const lines = readDaemonStartFailureDiagnostics(
			{ startupLogPath: "/tmp/startup.log", platform: "linux", systemdUnitName: "signet-daemon-123" },
			{
				existsSync: () => true,
				readFileSync: () => "",
				spawnSync: (cmd, argv) => {
					command = cmd;
					args = argv;
					return { stdout: "May 13 signet-daemon-123: Fatal error\nMay 13 signet-daemon-123: ENOSPC\n" };
				},
			},
		);

		expect(command).toBe("journalctl");
		expect(args).toContain("--unit");
		expect(args).toContain("signet-daemon-123");
		expect(lines).toEqual([
			"Daemon failed to start. journalctl for signet-daemon-123:",
			"May 13 signet-daemon-123: Fatal error",
			"May 13 signet-daemon-123: ENOSPC",
		]);
	});
});

describe("readManagedDaemonPid", () => {
	it("accepts a live daemon pid when the command matches the daemon path", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-runtime-test-"));
		const dir = join(root, ".daemon");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "pid"), "4242\n");

		const pid = readManagedDaemonPid(root, {
			daemonPaths: ["/opt/signet/dist/daemon.js"],
			isAlive: () => true,
			readCmd: () => "bun /opt/signet/dist/daemon.js",
		});

		expect(pid).toBe(4242);

		rmSync(root, { recursive: true, force: true });
	});

	it("accepts an older global install path for a live daemon pid", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-runtime-test-"));
		const dir = join(root, ".daemon");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "pid"), "5252\n");

		const pid = readManagedDaemonPid(root, {
			daemonPaths: ["/home/nicholai/.bun/install/global/node_modules/signetai/dist/daemon.js"],
			isAlive: () => true,
			readCmd: () => "bun /home/nicholai/.bun/install/cache/signetai@0.77.0/node_modules/signetai/dist/daemon.js",
		});

		expect(pid).toBe(5252);

		rmSync(root, { recursive: true, force: true });
	});

	it("rejects a live reused pid when the command does not match signet daemon", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-runtime-test-"));
		const dir = join(root, ".daemon");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "pid");
		writeFileSync(path, "7777\n");

		const pid = readManagedDaemonPid(root, {
			daemonPaths: ["/opt/signet/dist/daemon.js"],
			isAlive: () => true,
			readCmd: () => "/usr/bin/python3 /tmp/something-else.py",
		});

		expect(pid).toBeNull();
		expect(existsSync(path)).toBe(true);

		rmSync(root, { recursive: true, force: true });
	});

	it("cleans up the pid file when the process is no longer alive", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-runtime-test-"));
		const dir = join(root, ".daemon");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "pid");
		writeFileSync(path, "8888\n");

		const pid = readManagedDaemonPid(root, {
			daemonPaths: ["/opt/signet/dist/daemon.js"],
			isAlive: () => false,
			readCmd: () => null,
		});

		expect(pid).toBeNull();
		expect(existsSync(path)).toBe(false);

		rmSync(root, { recursive: true, force: true });
	});
});

describe("getDaemonStatus", () => {
	it("parses extraction provider degradation from /api/status", async () => {
		globalThis.fetch = async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith("/health")) {
				return new Response("ok", { status: 200 });
			}
			if (url.endsWith("/api/status")) {
				return Response.json({
					pid: 42,
					uptime: 123,
					version: "0.77.4",
					host: "127.0.0.1",
					bindHost: "127.0.0.1",
					networkMode: "local",
					providerResolution: {
						extraction: {
							configured: "claude-code",
							effective: "ollama",
							fallbackProvider: "ollama",
							status: "degraded",
							degraded: true,
							reason: "Claude Code CLI not found during extraction startup preflight",
							since: "2026-03-26T00:00:00.000Z",
						},
					},
					pipeline: {
						extraction: {
							running: true,
							overloaded: true,
							loadPerCpu: 1.82,
							maxLoadPerCpu: 0.8,
							overloadBackoffMs: 30000,
							overloadSince: "2026-03-26T00:00:02.000Z",
							nextTickInMs: 28000,
						},
					},
				});
			}
			return new Response("not found", { status: 404 });
		};

		const status = await getDaemonStatus();
		expect(status.running).toBe(true);
		expect(status.extraction).toEqual({
			configured: "claude-code",
			effective: "ollama",
			fallbackProvider: "ollama",
			status: "degraded",
			degraded: true,
			reason: "Claude Code CLI not found during extraction startup preflight",
			since: "2026-03-26T00:00:00.000Z",
		});
		expect(status.extractionWorker).toEqual({
			running: true,
			overloaded: true,
			loadPerCpu: 1.82,
			maxLoadPerCpu: 0.8,
			overloadBackoffMs: 30000,
			overloadSince: "2026-03-26T00:00:02.000Z",
			nextTickInMs: 28000,
		});
	});
});
