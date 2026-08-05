import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	doRestart,
	doStart,
	doStop,
	launchDashboard,
	requestPipelinePauseApi,
	showLogs,
	summarizePipelineToggle,
} from "./daemon.js";

describe("requestPipelinePauseApi", () => {
	it("uses the live daemon pause endpoint when available", async () => {
		const result = await requestPipelinePauseApi(3850, true, async (input, init) => {
			expect(String(input)).toBe("http://localhost:3850/api/pipeline/pause");
			expect(init?.method).toBe("POST");
			return new Response(
				JSON.stringify({
					success: true,
					changed: true,
					paused: true,
					file: "/tmp/agent.yaml",
					mode: "paused",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		expect(result).toEqual({
			kind: "ok",
			data: {
				success: true,
				changed: true,
				paused: true,
				file: "/tmp/agent.yaml",
				mode: "paused",
			},
		});
	});

	it("falls back when the live endpoint is unavailable", async () => {
		const result = await requestPipelinePauseApi(3850, false, async () => {
			return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
		});

		expect(result).toEqual({ kind: "fallback" });
	});

	it("surfaces daemon API errors instead of silently falling back", async () => {
		await expect(
			requestPipelinePauseApi(3850, true, async () => {
				return new Response(JSON.stringify({ error: "Pipeline transition already in progress" }), {
					status: 409,
					headers: { "Content-Type": "application/json" },
				});
			}),
		).rejects.toThrow("Pipeline transition already in progress");
	});
});

describe("summarizePipelineToggle", () => {
	it("reports resume as still disabled when the pause flag clears under disabled mode", () => {
		expect(summarizePipelineToggle(false, "disabled", true)).toEqual({
			title: "Pipeline pause cleared, still disabled",
			detail:
				"  Pause flag cleared, but the pipeline is still disabled in config. Enable it before extraction can run.",
		});
	});
});

function makeDeps(overrides?: Partial<Parameters<typeof doRestart>[1]>): Parameters<typeof doRestart>[1] {
	return {
		agentsDir: "/tmp/.agents",
		defaultPort: 3850,
		extractPathOption: () => null,
		getDaemonStatus: async () => ({
			running: true,
			pid: 42,
			uptime: 1,
			version: "0.77.1",
			host: "127.0.0.1",
			bindHost: "0.0.0.0",
			networkMode: "local",
			extraction: null,
		}),
		hasDaemonProcess: async () => false,
		isDaemonRunning: async () => false,
		normalizeAgentPath: (pathValue) => pathValue,
		signetLogo: () => "",
		sleep: async () => {},
		startDaemon: async () => true,
		stopDaemon: async () => true,
		...overrides,
	};
}

describe("daemon lifecycle recovery", () => {
	it("lets an already-running daemon reconcile its installation owner", async () => {
		let started = false;
		const deps = makeDeps({
			isDaemonRunning: async () => true,
			startDaemon: async () => {
				started = true;
				return true;
			},
		});

		await doStart({}, deps);

		expect(started).toBe(true);
	});

	it("restart stops a stale daemon process even when health checks say stopped", async () => {
		const calls: string[] = [];
		const deps = makeDeps({
			hasDaemonProcess: async () => true,
			startDaemon: async () => {
				calls.push("start");
				return true;
			},
			stopDaemon: async () => {
				calls.push("stop");
				return true;
			},
		});

		await doRestart({ sync: false }, deps);

		expect(calls).toEqual(["stop", "start"]);
	});

	it("stop attempts cleanup for a stale daemon process even when health checks fail", async () => {
		let stopped = false;
		const deps = makeDeps({
			hasDaemonProcess: async () => true,
			stopDaemon: async () => {
				stopped = true;
				return true;
			},
		});

		await doStop({}, deps);

		expect(stopped).toBe(true);
	});

	// Regression (#1074): under launchd KeepAlive the daemon respawns on exit,
	// so "stop" must boot the job out even when the health endpoint says
	// stopped — otherwise the reported stop is silently undone.
	it("stop unloads the launchd keepalive when the daemon is unhealthy but launchd-managed", async () => {
		let stopped = false;
		const deps = makeDeps({
			isDaemonRunning: async () => false,
			hasDaemonProcess: async () => false,
			isLaunchdDaemonLoaded: async () => true,
			stopDaemon: async () => {
				stopped = true;
				return true;
			},
		});

		await doStop({}, deps);

		expect(stopped).toBe(true);
	});

	it("stop reports not running when nothing is alive and no launchd agent is loaded", async () => {
		let stopped = false;
		const deps = makeDeps({
			isDaemonRunning: async () => false,
			hasDaemonProcess: async () => false,
			isLaunchdDaemonLoaded: async () => false,
			stopDaemon: async () => {
				stopped = true;
				return true;
			},
		});

		await doStop({}, deps);

		expect(stopped).toBe(false);
	});

	it("restart runs signet sync when the user accepts the sync prompt", async () => {
		let synced = false;
		const deps = makeDeps({
			isInteractive: () => true,
			confirmRestartSync: async () => true,
			syncTemplates: async () => {
				synced = true;
			},
		});

		await doRestart({}, deps);

		expect(synced).toBe(true);
	});

	it("restart sync uses the resolved restart path", async () => {
		let syncedPath: string | null = null;
		const deps = makeDeps({
			extractPathOption: () => "/tmp/custom-agents",
			isInteractive: () => true,
			confirmRestartSync: async () => true,
			normalizeAgentPath: (pathValue) => `${pathValue}-normalized`,
			syncTemplates: async (basePath) => {
				syncedPath = basePath;
			},
		});

		await doRestart({ path: "/tmp/custom-agents" }, deps);

		expect(syncedPath).toBe("/tmp/custom-agents-normalized");
	});

	it("restart skips signet sync when the user declines the sync prompt", async () => {
		let synced = false;
		const deps = makeDeps({
			isInteractive: () => true,
			confirmRestartSync: async () => false,
			syncTemplates: async () => {
				synced = true;
			},
		});

		await doRestart({}, deps);

		expect(synced).toBe(false);
	});

	it("restart honors --no-sync even in an interactive terminal", async () => {
		let synced = false;
		const deps = makeDeps({
			isInteractive: () => true,
			confirmRestartSync: async () => true,
			syncTemplates: async () => {
				synced = true;
			},
		});

		await doRestart({ sync: false }, deps);

		expect(synced).toBe(false);
	});

	it("restart treats deprecated --no-openclaw as --no-sync", async () => {
		let synced = false;
		const deps = makeDeps({
			isInteractive: () => true,
			confirmRestartSync: async () => true,
			syncTemplates: async () => {
				synced = true;
			},
		});

		await doRestart({ openclaw: false }, deps);

		expect(synced).toBe(false);
	});
});

describe("showLogs follow mode", () => {
	it("streams daemon logs without relying on a global EventSource", async () => {
		const logs: string[] = [];
		const originalEventSource = (globalThis as typeof globalThis & { EventSource?: unknown }).EventSource;
		const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		try {
			(globalThis as typeof globalThis & { EventSource?: unknown }).EventSource = undefined;
			const encoder = new TextEncoder();
			const streamed = [
				'data: {"type":"connected"}\n\n',
				'data: {"timestamp":"2026-05-08T21:05:00.000Z","level":"info","category":"daemon","message":"follow works"}\n\n',
			];
			let requestCount = 0;
			const deps = makeDeps({
				getDaemonStatus: async () => ({
					running: true,
					pid: 42,
					uptime: 1,
					version: "0.115.3",
					host: "127.0.0.1",
					bindHost: "127.0.0.1",
					networkMode: "local",
					extraction: null,
				}),
				fetch: async (input) => {
					requestCount += 1;
					const url = String(input);
					if (url.includes("/api/logs/stream")) {
						return new Response(
							new ReadableStream({
								start(controller) {
									for (const chunk of streamed) {
										controller.enqueue(encoder.encode(chunk));
									}
									controller.close();
								},
							}),
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					}
					return new Response(JSON.stringify({ logs: [], count: 0 }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				},
			});

			await showLogs({ follow: true }, deps);

			expect(requestCount).toBe(2);
			expect(logs.join("\n")).toContain("Streaming logs");
			expect(logs.join("\n")).toContain("follow works");
		} finally {
			logSpy.mockRestore();
			if (originalEventSource !== undefined) {
				(globalThis as typeof globalThis & { EventSource?: unknown }).EventSource = originalEventSource;
			}
		}
	});
});

// Regression: #429 — failure paths must exit non-zero
describe("daemon exit codes on failure", () => {
	let exitSpy: ReturnType<typeof spyOn>;

	afterEach(() => {
		exitSpy?.mockRestore();
	});

	it("doStart exits with code 1 when startDaemon returns false", async () => {
		exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});

		const deps = makeDeps({ startDaemon: async () => false });

		await expect(doStart({}, deps)).rejects.toThrow("EXIT_1");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("doStop exits with code 1 when stopDaemon returns false", async () => {
		exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});

		const deps = makeDeps({
			isDaemonRunning: async () => true,
			stopDaemon: async () => false,
		});

		await expect(doStop({}, deps)).rejects.toThrow("EXIT_1");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("doRestart exits with code 1 when startDaemon returns false", async () => {
		exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});

		const deps = makeDeps({ startDaemon: async () => false });

		await expect(doRestart({ sync: false }, deps)).rejects.toThrow("EXIT_1");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("doRestart exits with code 1 when stopDaemon returns false during restart", async () => {
		exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});

		const deps = makeDeps({
			isDaemonRunning: async () => true,
			stopDaemon: async () => false,
		});

		await expect(doRestart({ sync: false }, deps)).rejects.toThrow("EXIT_1");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});

describe("launchDashboard", () => {
	let exitSpy: ReturnType<typeof spyOn>;
	let lines: string[];

	beforeEach(() => {
		lines = [];
		spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});
		spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});
	});

	afterEach(() => {
		exitSpy?.mockRestore();
		spyOn(console, "log").mockRestore();
		spyOn(console, "error").mockRestore();
	});

	function dashboardDeps(overrides?: {
		getDaemonStatus?: () => Promise<{
			running: boolean;
			pid: number | null;
			uptime: number | null;
			version: string | null;
			host: string | null;
			bindHost: string | null;
			networkMode: string | null;
		}>;
		startDaemon?: () => Promise<boolean>;
	}) {
		return {
			agentsDir: "/tmp/.agents",
			defaultPort: 3850,
			extractPathOption: () => null,
			getDaemonStatus: async () => ({
				running: true,
				pid: 3046866,
				uptime: 54,
				version: "0.156.4",
				host: "127.0.0.1",
				bindHost: "127.0.0.1",
				networkMode: "local",
			}),
			hasDaemonProcess: async () => false,
			isDaemonRunning: async () => false,
			normalizeAgentPath: (pathValue: string) => pathValue,
			signetLogo: () => "signet",
			sleep: async () => {},
			startDaemon: async () => true,
			stopDaemon: async () => true,
			openUrl: async (url: string) => {
				lines.push(`OPEN:${url}`);
			},
			...overrides,
		};
	}

	// Regression (#1045): a healthy daemon must not be reported as stopped,
	// started, or restarted by the dashboard command.
	it("does not claim a start when the daemon is already running", async () => {
		let startCalls = 0;
		const deps = dashboardDeps({
			startDaemon: async () => {
				startCalls += 1;
				return true;
			},
		});
		await launchDashboard({}, deps);
		expect(startCalls).toBe(0);
		expect(lines.join("\n")).not.toContain("Daemon is not running");
		expect(lines.join("\n")).not.toContain("Daemon started");
		expect(lines.join("\n")).toContain("http://localhost:3850");
	});

	// Regression (#1045): the health probe can transiently false-negative while
	// the daemon process is alive (same PID). startDaemon short-circuits to
	// "already running", so the command must not claim it started the daemon.
	it("does not claim a start when the probe false-negatives but the daemon process was alive the whole time", async () => {
		let statusCalls = 0;
		const deps = dashboardDeps({
			getDaemonStatus: async () => {
				statusCalls += 1;
				if (statusCalls === 1) {
					// Transient false negative: health probe failed, but the
					// daemon process is alive and its PID is known.
					return {
						running: false,
						pid: 3046866,
						uptime: null,
						version: null,
						host: null,
						bindHost: null,
						networkMode: null,
					};
				}
				// startDaemon short-circuited ("already-current"); the same
				// process is still running moments later.
				return {
					running: true,
					pid: 3046866,
					uptime: 58,
					version: "0.156.4",
					host: "127.0.0.1",
					bindHost: "127.0.0.1",
					networkMode: "local",
				};
			},
		});
		await launchDashboard({}, deps);
		expect(lines.join("\n")).toContain("Daemon is not running. Starting...");
		expect(lines.join("\n")).not.toContain("Daemon started");
		expect(lines.join("\n")).toContain("Daemon is running");
		expect(statusCalls).toBe(2);
	});

	it("claims a start only when the daemon was genuinely absent before", async () => {
		let statusCalls = 0;
		const deps = dashboardDeps({
			getDaemonStatus: async () => {
				statusCalls += 1;
				if (statusCalls === 1) {
					return {
						running: false,
						pid: null,
						uptime: null,
						version: null,
						host: null,
						bindHost: null,
						networkMode: null,
					};
				}
				return {
					running: true,
					pid: 4242,
					uptime: 1,
					version: "0.156.4",
					host: "127.0.0.1",
					bindHost: "127.0.0.1",
					networkMode: "local",
				};
			},
		});
		await launchDashboard({}, deps);
		expect(lines.join("\n")).toContain("Daemon is not running. Starting...");
		expect(lines.join("\n")).toContain("Daemon started");
		expect(lines.join("\n")).toContain("OPEN:http://localhost:3850");
	});

	it("exits non-zero when the daemon still cannot be reached after start", async () => {
		exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		const deps = dashboardDeps({
			getDaemonStatus: async () => ({
				running: false,
				pid: null,
				uptime: null,
				version: null,
				host: null,
				bindHost: null,
				networkMode: null,
			}),
		});
		await expect(launchDashboard({}, deps)).rejects.toThrow("EXIT_1");
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(lines.join("\n")).toContain("Failed to start daemon");
	});
});
