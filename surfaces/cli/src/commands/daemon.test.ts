import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Command } from "commander";
import { doRestart, doStart } from "../features/daemon.js";
import { DAEMON_JS_WORKER_FILES, resolveDaemonLaunchCommand, resolveDaemonPathForRuntime } from "../lib/runtime.js";
import { registerDaemonCommands } from "./daemon.js";

describe("daemon bundle flag", () => {
	let directory: string;
	let entry: string;
	let calls: string[];
	const originalRuntime = process.env.SIGNET_DAEMON_RUNTIME;
	const originalPath = process.env.SIGNET_DAEMON_JS_PATH;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "signet-cli-bundle-"));
		entry = join(directory, "daemon.js");
		writeFileSync(entry, 'console.log("selected developer bundle");');
		for (const worker of DAEMON_JS_WORKER_FILES) writeFileSync(join(directory, worker), "export {};");
		mkdirSync(join(directory, "dashboard"));
		writeFileSync(join(directory, "dashboard", "index.html"), "<!doctype html>");
		mkdirSync(join(directory, "skills"));
		writeFileSync(join(directory, "skills", "README.md"), "skills");
		mkdirSync(join(directory, "vendor", "node_modules", "@firecrawl", "anydoc"), { recursive: true });
		writeFileSync(join(directory, "vendor", "tiktoken_bg.wasm"), "wasm");
		calls = [];
		delete process.env.SIGNET_DAEMON_RUNTIME;
		process.env.SIGNET_DAEMON_JS_PATH = join(directory, "wrong.js");
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
		if (originalRuntime === undefined) delete process.env.SIGNET_DAEMON_RUNTIME;
		else process.env.SIGNET_DAEMON_RUNTIME = originalRuntime;
		if (originalPath === undefined) delete process.env.SIGNET_DAEMON_JS_PATH;
		else process.env.SIGNET_DAEMON_JS_PATH = originalPath;
	});

	function program(): Command {
		const command = new Command().exitOverride();
		const deps: Parameters<typeof doStart>[1] = {
			agentsDir: directory,
			defaultPort: 3850,
			extractPathOption: () => null,
			normalizeAgentPath: (path) => path,
			signetLogo: () => "",
			isDaemonRunning: async () => true,
			hasDaemonProcess: async () => false,
			getDaemonStatus: async () => ({
				running: true,
				pid: 42,
				uptime: 1,
				version: "test",
				runtime: "bun-js",
				host: "127.0.0.1",
				bindHost: "127.0.0.1",
				networkMode: "local",
			}),
			stopDaemon: async () => {
				calls.push("stop");
				return true;
			},
			sleep: async () => {},
			startDaemon: async (_workspace, runtime, path) => {
				const resolved = resolveDaemonPathForRuntime(runtime ?? "bun-js", process.env, path);
				calls.push(resolved ?? "missing");
				if (resolved === null) return false;
				const child = Bun.spawnSync(resolveDaemonLaunchCommand(resolved, process.env, "bun-js"));
				expect(child.exitCode).toBe(0);
				expect(child.stdout.toString().trim()).toBe("selected developer bundle");
				return true;
			},
		};
		registerDaemonCommands(command, {
			doStart: async (options = {}) => doStart(options, deps),
			doRestart: async (options = {}) => doRestart(options, deps),
			doStop: async () => {},
			doPause: async () => {},
			doResume: async () => {},
			showLogs: async () => {},
			showStatus: async () => {},
		});
		return command;
	}

	for (const invocation of [["daemon", "start"], ["daemon", "restart"], ["start"], ["restart"]]) {
		it(`${invocation.join(" ")} selects the relative flag path over the environment and restarts bun-js`, async () => {
			await program().parseAsync(
				[...invocation, "--runtime", "bun-js", "--daemon-js-path", relative(process.cwd(), entry)],
				{ from: "user" },
			);
			expect(calls).toEqual(["stop", entry]);
		});
	}

	it("accepts bun-js selected through the environment", async () => {
		process.env.SIGNET_DAEMON_RUNTIME = "bun-js";
		await program().parseAsync(["start", "--daemon-js-path", entry], { from: "user" });
		expect(calls).toEqual(["stop", entry]);
	});

	for (const invocation of ["start", "restart"]) {
		it(`${invocation} rejects an incomplete bundle before stopping the daemon`, async () => {
			rmSync(join(directory, "embedding-worker.js"));
			await expect(
				program().parseAsync([invocation, "--runtime", "bun-js", "--daemon-js-path", entry], { from: "user" }),
			).rejects.toThrow("embedding-worker.js");
			expect(calls).toEqual([]);
		});
	}

	it("rejects the flag with the compiled runtime before stopping", async () => {
		await expect(
			program().parseAsync(["restart", "--runtime", "compiled", "--daemon-js-path", entry], { from: "user" }),
		).rejects.toThrow("requires --runtime bun-js");
		expect(calls).toEqual([]);
	});

	it("shows the flag in help", () => {
		const start = program().commands.find((command) => command.name() === "start");
		expect(start?.helpInformation()).toContain("--daemon-js-path <path>");
	});
});
