import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDaemonStatus, readManagedDaemonPid } from "./runtime.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
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
