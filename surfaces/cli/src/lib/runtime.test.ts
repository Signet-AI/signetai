import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
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
	isDaemonEntrypointEnvironment,
	isDaemonRunning,
	isLaunchdDaemonLoaded,
	launchdDaemonPlistPath,
	macOSLaunchAgentAttributionNotice,
	readDaemonStartFailureDiagnostics,
	readManagedDaemonPid,
	resolveDaemonLaunchCommand,
	resolveDaemonPaths,
	resolveDaemonRuntimeCommand,
	stopManagedDaemonProcess,
	waitForDaemonLiveness,
} from "./runtime.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("resolveDaemonPaths", () => {
	it("keeps the JavaScript daemon bundle as the default when SIGNET_DIR is set", () => {
		const paths = resolveDaemonPaths({ SIGNET_DIR: "/opt/signet" });
		expect(paths[0]).toBe("/opt/signet/runtime/daemon-js/daemon.js");
	});
});

describe("daemon entrypoint ownership", () => {
	it("accepts the explicit daemon marker and rejects an unmarked CLI environment", () => {
		expect(isDaemonEntrypointEnvironment("PATH=/usr/bin\u0000SIGNET_DAEMON_ENTRYPOINT=1\u0000")).toBe(true);
		expect(isDaemonEntrypointEnvironment("PATH=/usr/bin\u0000")).toBe(false);
	});
});

describe("resolveDaemonRuntimeCommand", () => {
	it("uses the bundled Node runtime when SIGNET_DIR points at a native bundle install", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-runtime-node-"));
		const nodePath = join(root, "runtime", "node", "bin", "node");
		mkdirSync(join(root, "runtime", "node", "bin"), { recursive: true });
		writeFileSync(nodePath, "");

		expect(resolveDaemonRuntimeCommand({ SIGNET_DIR: root }, "/usr/bin/node", "")).toBe(nodePath);

		rmSync(root, { recursive: true, force: true });
	});
});

describe("resolveDaemonLaunchCommand", () => {
	it("launches native daemon binaries directly", () => {
		expect(resolveDaemonLaunchCommand("/opt/signet/bin/signet")).toEqual(["/opt/signet/bin/signet"]);
	});

	it("launches JavaScript daemon scripts through the runtime command", () => {
		expect(resolveDaemonLaunchCommand("/opt/signet/runtime/daemon-js/daemon.js")).toEqual([
			process.execPath,
			"/opt/signet/runtime/daemon-js/daemon.js",
		]);
	});
});

describe("macOSLaunchAgentAttributionNotice", () => {
	it("warns when macOS launchd will attribute a JavaScript daemon to Bun", () => {
		const notice = macOSLaunchAgentAttributionNotice("/opt/signet/dist/daemon.js", {
			env: {},
			execPath: "/Users/user/.bun/bin/bun",
			pathValue: "",
			platform: "darwin",
		});

		expect(notice).toContain("Background Activity");
		expect(notice).toContain("Jarred Sumner");
		expect(notice).toContain("compiled Signet binary");
	});

	it("does not warn for native daemon binaries", () => {
		expect(
			macOSLaunchAgentAttributionNotice("/opt/signet/bin/signet", {
				env: {},
				execPath: "/Users/user/.bun/bin/bun",
				pathValue: "",
				platform: "darwin",
			}),
		).toBeNull();
	});

	it("does not warn outside macOS", () => {
		expect(
			macOSLaunchAgentAttributionNotice("/opt/signet/dist/daemon.js", {
				env: {},
				execPath: "/Users/user/.bun/bin/bun",
				pathValue: "",
				platform: "linux",
			}),
		).toBeNull();
	});
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
		expect(args).toContain("--setenv=SIGNET_DAEMON_ENTRYPOINT=1");
		expect(args.some((arg) => arg.startsWith("--setenv=BUN_INSPECT="))).toBe(false);
		expect(args).toContain("--property=StandardError=append:/home/user/.agents/.daemon/logs/startup.log");
		expect(args.slice(-2)).toEqual([process.execPath, "/opt/signet/dist/daemon.js"]);
	});

	it("forwards the Bun inspector setting through the transient service boundary", () => {
		const args = buildSystemdDaemonStartArgs({
			daemonPath: "/opt/signet/dist/daemon.js",
			agentsDir: "/home/user/.agents",
			port: 3850,
			host: "127.0.0.1",
			bind: "0.0.0.0",
			startupLogPath: "/home/user/.agents/.daemon/logs/startup.log",
			bunInspect: "127.0.0.1:9230",
		});

		expect(args).toContain("--setenv=BUN_INSPECT=127.0.0.1:9230");
	});

	it("forwards only allowlisted telemetry variables through service-manager boundaries", () => {
		const input = {
			daemonPath: "/opt/signet/dist/daemon.js",
			agentsDir: "/home/user/.agents",
			port: 3850,
			host: "127.0.0.1",
			bind: "0.0.0.0",
			startupLogPath: "/home/user/.agents/.daemon/logs/startup.log",
			telemetryEnv: {
				SIGNET_TELEMETRY_ENV: "dev",
				SIGNET_TELEMETRY_OPTOUT: "1",
				SIGNET_TELEMETRY_DEPLOYMENT_ROLE: "ci",
				SIGNET_TELEMETRY_INSTALL_CHANNEL: "package-manager",
				SIGNET_TELEMETRY_SECRET: "must-not-cross-boundary",
			},
		};

		const args = buildSystemdDaemonStartArgs(input);
		const plist = buildLaunchdDaemonPlist(input);

		expect(args).toEqual(
			expect.arrayContaining([
				"--setenv=SIGNET_TELEMETRY_ENV=dev",
				"--setenv=SIGNET_TELEMETRY_OPTOUT=1",
				"--setenv=SIGNET_TELEMETRY_DEPLOYMENT_ROLE=ci",
				"--setenv=SIGNET_TELEMETRY_INSTALL_CHANNEL=package-manager",
			]),
		);
		expect(plist).toContain("<key>SIGNET_TELEMETRY_ENV</key>");
		expect(plist).toContain("<key>SIGNET_TELEMETRY_OPTOUT</key>");
		expect(plist).toContain("<key>SIGNET_TELEMETRY_DEPLOYMENT_ROLE</key>");
		expect(plist).toContain("<key>SIGNET_TELEMETRY_INSTALL_CHANNEL</key>");
		expect(args.join(" ")).not.toContain("SIGNET_TELEMETRY_SECRET");
		expect(plist).not.toContain("SIGNET_TELEMETRY_SECRET");
	});

	it("omits empty inspector settings", () => {
		const input = {
			daemonPath: "/opt/signet/dist/daemon.js",
			agentsDir: "/home/user/.agents",
			port: 3850,
			host: "127.0.0.1",
			bind: "0.0.0.0",
			startupLogPath: "/home/user/.agents/.daemon/logs/startup.log",
		};

		const args = buildSystemdDaemonStartArgs({ ...input, bunInspect: "" });
		const plist = buildLaunchdDaemonPlist({ ...input, bunInspect: "" });

		expect(args.some((arg) => arg.startsWith("--setenv=BUN_INSPECT="))).toBe(false);
		expect(plist).not.toContain("<key>BUN_INSPECT</key>");
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
		expect(plist).toContain("<key>SIGNET_DAEMON_ENTRYPOINT</key>");
		expect(plist).toMatch(/<key>SIGNET_DAEMON_SERVICE<\/key>\s*<string>launchd<\/string>/);
		expect(plist).not.toContain("<key>BUN_INSPECT</key>");
		expect(plist).toContain("<string>1</string>");
		expect(plist).toContain("<key>HOME</key>");
		expect(plist).toContain("<key>RunAtLoad</key>");
		expect(plist).toContain("<true/>");
		expect(plist).toContain("<key>KeepAlive</key>");
		expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
		expect(plist).toContain("<key>StandardErrorPath</key>");
		expect(plist).toContain("<string>/Users/user/.agents/.daemon/logs/startup.log</string>");
	});

	it("forwards the Bun inspector setting into the persistent launch agent", () => {
		const plist = buildLaunchdDaemonPlist({
			daemonPath: "/opt/signet/dist/daemon.js",
			agentsDir: "/Users/user/.agents",
			port: 3850,
			host: "127.0.0.1",
			bind: "0.0.0.0",
			startupLogPath: "/Users/user/.agents/.daemon/logs/startup.log",
			bunInspect: "127.0.0.1:9230",
		});

		expect(plist).toContain("<key>BUN_INSPECT</key>");
		expect(plist).toContain("<string>127.0.0.1:9230</string>");
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
			readEnv: () => "SIGNET_DAEMON_ENTRYPOINT=1\u0000",
		});

		expect(pid).toBe(4242);

		rmSync(root, { recursive: true, force: true });
	});

	it("rejects a daemon-path CLI process without the daemon entrypoint marker", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-runtime-test-"));
		const dir = join(root, ".daemon");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "pid"), "6262\n");

		const pid = readManagedDaemonPid(root, {
			daemonPaths: ["/opt/signet/dist/daemon.js"],
			isAlive: () => true,
			readCmd: () => "bun /opt/signet/dist/daemon.js daemon start",
			readEnv: () => "PATH=/usr/bin\u0000",
		});

		expect(pid).toBeNull();

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
			readEnv: () => "SIGNET_DAEMON_ENTRYPOINT=1\u0000",
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
			readEnv: () => "PATH=/usr/bin\u0000",
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

describe("stopManagedDaemonProcess", () => {
	it("terminates the detached process group and releases a child-held port", async () => {
		const port = 39871;
		const holderScript = [
			'const net = require("node:net");',
			"const server = net.createServer();",
			'server.listen(Number(process.env.SIGNET_TEST_PORT), "127.0.0.1");',
			"setInterval(() => {}, 1000);",
		].join(" ");
		const leaderScript = [
			'const { spawn } = require("node:child_process");',
			`spawn(process.execPath, ["-e", ${JSON.stringify(holderScript)}], { env: { ...process.env, SIGNET_TEST_PORT: process.env.SIGNET_TEST_PORT }, stdio: "ignore" });`,
			'setTimeout(() => process.stdout.write("ready\\n"), 100);',
			"setInterval(() => {}, 1000);",
		].join(" ");
		const child = spawn(process.execPath, ["-e", leaderScript], {
			detached: true,
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, SIGNET_TEST_PORT: String(port) },
		});
		if (typeof child.pid !== "number") throw new Error("detached child did not expose a pid");

		try {
			await new Promise<void>((resolve, reject) => {
				const deadline = setTimeout(() => reject(new Error("child did not start")), 5000);
				child.stdout?.once("data", () => {
					clearTimeout(deadline);
					resolve();
				});
				child.once("error", reject);
			});

			await new Promise<void>((resolve, reject) => {
				const deadline = setTimeout(() => reject(new Error("child did not bind the test port")), 5000);
				const probe = (): void => {
					const socket = connect({ host: "127.0.0.1", port });
					socket.once("connect", () => {
						clearTimeout(deadline);
						socket.destroy();
						resolve();
					});
					socket.once("error", () => {
						socket.destroy();
						setTimeout(probe, 25);
					});
				};
				probe();
			});

			await stopManagedDaemonProcess(child.pid);

			await new Promise<void>((resolve, reject) => {
				const socket = connect({ host: "127.0.0.1", port });
				socket.once("error", () => {
					socket.destroy();
					resolve();
				});
				socket.once("connect", () => {
					socket.destroy();
					reject(new Error("detached child still holds the port"));
				});
			});
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
		}
	});
});

describe("getDaemonStatus", () => {
	it("single-flights concurrent daemon status probes", async () => {
		let healthRequests = 0;
		let statusRequests = 0;
		const healthResolvers: Array<(response: Response) => void> = [];
		globalThis.fetch = (async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith("/health")) {
				healthRequests += 1;
				return new Promise<Response>((resolve) => {
					healthResolvers.push(resolve);
				});
			}
			if (url.endsWith("/api/status")) {
				statusRequests += 1;
				return Response.json({ pid: 42, uptime: 10, version: "0.199.32" });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const first = getDaemonStatus();
		const second = getDaemonStatus();
		expect(first).toBe(second);
		await Promise.resolve();
		expect(healthRequests).toBe(2);
		expect(statusRequests).toBe(0);
		expect(healthResolvers).toHaveLength(2);
		for (const resolve of healthResolvers) resolve(new Response("ok", { status: 200 }));
		const [firstStatus, secondStatus] = await Promise.all([first, second]);
		expect(firstStatus.running).toBe(true);
		expect(secondStatus.running).toBe(true);
		expect(statusRequests).toBe(2);
	});

	it("single-flights concurrent liveness checks without waiting on metadata health", async () => {
		const requests: string[] = [];
		const resolvers: Array<(response: Response) => void> = [];
		globalThis.fetch = (async (input: string | URL) => {
			const url = String(input);
			requests.push(url);
			if (url.endsWith("/health/live")) {
				return new Promise<Response>((resolve) => resolvers.push(resolve));
			}
			return new Response("unexpected probe", { status: 500 });
		}) as typeof fetch;

		const first = isDaemonRunning();
		const second = isDaemonRunning();
		await Promise.resolve();
		expect(requests).toHaveLength(2);
		expect(resolvers).toHaveLength(2);
		for (const resolve of resolvers) resolve(new Response("ok", { status: 200 }));
		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect(requests.every((url) => url.endsWith("/health/live"))).toBe(true);
	});

	it("bounds startup liveness polling while allowing readiness to resolve", async () => {
		let requests = 0;
		let now = 0;
		globalThis.fetch = (async (input: string | URL) => {
			expect(String(input)).toEndWith("/health/live");
			requests += 1;
			return new Response("ok", { status: requests >= 6 ? 200 : 503 });
		}) as typeof fetch;

		const result = await waitForDaemonLiveness(
			1000,
			() => false,
			async (ms) => {
				now += ms;
			},
			() => now,
		);

		expect(result).toBe(true);
		expect(now).toBe(750);
		expect(requests).toBe(6);
	});

	it("parses extraction provider degradation from /api/status", async () => {
		globalThis.fetch = async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith("/api/diagnostics/openclaw")) {
				return Response.json({
					status: "connected",
					lastHeartbeat: "2026-06-25T00:00:00.000Z",
					pluginVersion: "test-plugin",
					hooksRegistered: ["before_prompt_build"],
					hooksSucceeded: 2,
					hooksFailed: 1,
					lastLatencyMs: 42,
					lastError: "daemon returned no prompt memory injection",
				});
			}
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
					resources: {
						rss: 169,
						heapUsed: 106,
						physicalFootprint: 2867,
						peakPhysicalFootprint: 3584,
					},
					providerResolution: {
						extraction: {
							configured: "claude-code",
							resolved: "claude-code",
							effective: "ollama",
							fallbackProvider: "ollama",
							status: "degraded",
							degraded: true,
							reason: "Claude Code CLI not found during extraction startup preflight",
							blockedBy: ["missing credential", 42, "", "account state missing"],
							since: "2026-03-26T00:00:00.000Z",
							enabled: true,
							paused: false,
							workerRunning: true,
							ready: true,
							blockedReason: null,
						},
					},
					pipeline: {
						dreaming: { status: "deferred", reason: "system_pressure", checkedAt: "2026-08-11T15:00:00.000Z" },
					},
				});
			}
			return new Response("not found", { status: 404 });
		};

		const status = await getDaemonStatus();
		expect(status.running).toBe(true);
		// The mock has no /health/ready route (older daemon): readiness is unknown, not a regression.
		expect(status.probe.status).toBe("healthy");
		expect(status.probe.readinessReasons).toBeUndefined();
		expect(status.scheduler).toEqual({
			status: "deferred",
			reason: "system_pressure",
			checkedAt: "2026-08-11T15:00:00.000Z",
		});
		expect(status.extraction).toEqual({
			configured: "claude-code",
			resolved: "claude-code",
			effective: "ollama",
			fallbackProvider: "ollama",
			status: "degraded",
			degraded: true,
			reason: "Claude Code CLI not found during extraction startup preflight",
			blockedBy: ["missing credential", "account state missing"],
			since: "2026-03-26T00:00:00.000Z",
			enabled: true,
			paused: false,
			workerRunning: true,
			ready: true,
			blockedReason: null,
			hasWorkloadState: true,
		});
		expect(status.resources).toEqual({
			rss: 169,
			heapUsed: 106,
			physicalFootprint: 2867,
			peakPhysicalFootprint: 3584,
		});
		expect(status.openclaw).toEqual({
			status: "connected",
			lastHeartbeat: "2026-06-25T00:00:00.000Z",
			pluginVersion: "test-plugin",
			hooksRegistered: ["before_prompt_build"],
			hooksSucceeded: 2,
			hooksFailed: 1,
			lastLatencyMs: 42,
			lastError: "daemon returned no prompt memory injection",
		});
	});

	it("keeps the probe healthy when /health/ready reports ready", async () => {
		globalThis.fetch = async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith("/health/ready")) {
				return Response.json({
					status: "ready",
					version: "0.148.0",
					shuttingDown: false,
					checks: { db: true, migrations: true },
					reasons: [],
				});
			}
			if (url.endsWith("/health")) {
				return new Response("ok", { status: 200 });
			}
			if (url.endsWith("/api/status")) {
				return Response.json({ pid: 42, uptime: 10, version: "0.148.0" });
			}
			return new Response("not found", { status: 404 });
		};

		const status = await getDaemonStatus();
		expect(status.running).toBe(true);
		expect(status.probe.status).toBe("healthy");
		expect(status.probe.readinessReasons).toBeUndefined();
	});

	it("marks the probe degraded with reasons when /health/ready reports not_ready", async () => {
		globalThis.fetch = async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith("/health/ready")) {
				return Response.json(
					{
						status: "not_ready",
						version: "0.148.0",
						shuttingDown: false,
						checks: { db: true, migrations: false },
						reasons: ["pending migrations"],
					},
					{ status: 503 },
				);
			}
			if (url.endsWith("/health")) {
				return new Response("ok", { status: 200 });
			}
			if (url.endsWith("/api/status")) {
				return Response.json({ pid: 42, uptime: 10, version: "0.148.0" });
			}
			return new Response("not found", { status: 404 });
		};

		const status = await getDaemonStatus();
		expect(status.running).toBe(true);
		expect(status.probe.status).toBe("degraded");
		expect(status.probe.readinessReasons).toEqual(["pending migrations"]);
		expect(status.probe.detail).toContain("readiness degraded");
	});
});

describe("isLaunchdDaemonLoaded", () => {
	it("never probes launchctl off macOS", () => {
		let spawned = false;
		const loaded = isLaunchdDaemonLoaded({
			platform: "linux",
			spawnSync: (_command, _args, _options) => {
				spawned = true;
				return { status: 0 };
			},
		});
		expect(loaded).toBe(false);
		expect(spawned).toBe(false);
	});

	it("reports loaded when launchctl print succeeds", () => {
		const loaded = isLaunchdDaemonLoaded({
			platform: "darwin",
			spawnSync: () => ({ status: 0 }),
		});
		expect(loaded).toBe(true);
	});

	it("reports not loaded when launchctl print fails (no such job)", () => {
		const loaded = isLaunchdDaemonLoaded({
			platform: "darwin",
			spawnSync: () => ({ status: 3 }),
		});
		expect(loaded).toBe(false);
	});
});
