import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type LogEntry, Logger, resolveLoggerConfig } from "./logger";

describe("logger config", () => {
	it("uses SIGNET_PATH for the default daemon log directory", () => {
		expect(resolveLoggerConfig({ SIGNET_PATH: "/tmp/signet-workspace" }, "/home/test")).toEqual({
			logDir: join("/tmp/signet-workspace", ".daemon", "logs"),
		});
	});

	it("keeps explicit log file and log directory overrides ahead of SIGNET_PATH", () => {
		expect(
			resolveLoggerConfig(
				{
					SIGNET_LOG_FILE: "/tmp/signet.log",
					SIGNET_LOG_DIR: "/tmp/logs",
					SIGNET_PATH: "/tmp/signet-workspace",
				},
				"/home/test",
			),
		).toEqual({ logFilePath: "/tmp/signet.log", logDir: "/tmp" });

		expect(
			resolveLoggerConfig(
				{
					SIGNET_LOG_DIR: "/tmp/logs",
					SIGNET_PATH: "/tmp/signet-workspace",
				},
				"/home/test",
			),
		).toEqual({ logDir: "/tmp/logs" });
	});

	it("falls back to the home-scoped agents directory", () => {
		expect(resolveLoggerConfig({}, "/home/test")).toEqual({
			logDir: join("/home/test", ".agents", ".daemon", "logs"),
		});
	});

	it("exposes the resolved log file path for the daemon boot line (#1162)", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-logger-"));
		try {
			const log = new Logger({
				logDir: root,
				consoleOutput: false,
				jsonFormat: false,
				level: "info",
			});
			const today = new Date().toISOString().split("T")[0];
			expect(log.logFilePath).toBe(join(root, `signet-${today}.log`));
			log.shutdown();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// Regression for issue #1148: the daemon exit path calls logger.shutdown()
// before process.exit(); without that explicit flush, the final log lines
// ("Received SIGTERM; shutting down") can sit in the 1s-flush buffer and be
// lost on exit, which is exactly the "vanished with no shutdown log" symptom.
describe("logger shutdown flush", () => {
	it("writes buffered entries to the log file on shutdown", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-logger-"));
		try {
			const log = new Logger({
				logDir: root,
				consoleOutput: false,
				jsonFormat: false,
				level: "info",
			});
			log.info("daemon", "Received signal:SIGTERM; shutting down");
			// No 1s timer flush has run yet (the test is sub-second); shutdown()
			// must flush the buffer synchronously.
			log.shutdown();
			const today = new Date().toISOString().split("T")[0];
			const content = readFileSync(join(root, `signet-${today}.log`), "utf-8");
			expect(content).toContain("Received signal:SIGTERM; shutting down");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not create the log file until the first flush (#1180)", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-logger-"));
		try {
			const log = new Logger({
				logDir: root,
				consoleOutput: false,
				jsonFormat: false,
				level: "info",
			});
			const today = new Date().toISOString().split("T")[0];
			const logPath = join(root, `signet-${today}.log`);
			// Regression for the #1180 review finding: the constructor used
			// to write a startup line, so any process importing logger.ts
			// (tests, CLI, MCP) appended to the daemon's log file at import.
			expect(existsSync(logPath)).toBe(false);
			log.shutdown();
			expect(existsSync(logPath)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("recovers file logging after the log directory becomes writable (#1162)", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-logger-"));
		try {
			// A file where the log directory should be: the initial mkdir fails
			// and every append fails until the path is fixed.
			const blocker = join(root, "blocker");
			writeFileSync(blocker, "i am a file, not a directory");
			const logPath = join(blocker, "logs", "signet.log");
			const log = new Logger({
				logFilePath: logPath,
				logDir: dirname(logPath),
				consoleOutput: false,
				jsonFormat: false,
				level: "info",
				flushRetryBackoffMs: 20,
			});
			log.info("daemon", "before failure");
			// Let the 1s flush timer run: the append fails (missing directory),
			// but the buffered entries must be retained for the retry.
			await new Promise((resolve) => setTimeout(resolve, 1100));
			// Fix the path, then write more; the next flush retry must re-append
			// the retained buffer and recover file logging.
			rmSync(blocker, { force: true });
			mkdirSync(join(root, "blocker", "logs"), { recursive: true });
			log.info("daemon", "after recovery");
			await new Promise((resolve) => setTimeout(resolve, 1100));
			log.shutdown();
			const content = readFileSync(logPath, "utf-8");
			expect(content).toContain("before failure");
			expect(content).toContain("after recovery");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("flushes the retained buffer on shutdown even inside the retry backoff (#1180)", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-logger-"));
		try {
			const blocker = join(root, "blocker");
			writeFileSync(blocker, "i am a file, not a directory");
			const logPath = join(blocker, "logs", "signet.log");
			const log = new Logger({
				logFilePath: logPath,
				logDir: dirname(logPath),
				consoleOutput: false,
				jsonFormat: false,
				level: "info",
				flushRetryBackoffMs: 60_000, // long backoff: no timer retry can fire
			});
			log.info("daemon", "crash trail entry");
			// Let the 1s flush timer fail the append once.
			await new Promise((resolve) => setTimeout(resolve, 1100));
			// Disk recovers, but the next timer retry is 60s away. A SIGTERM
			// here must not drop the retained buffer (the #1148 crash-trail
			// failure class): shutdown() force-flushes past the backoff gate.
			rmSync(blocker, { force: true });
			mkdirSync(dirname(logPath), { recursive: true });
			log.shutdown();
			const content = readFileSync(logPath, "utf-8");
			expect(content).toContain("crash trail entry");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("caps the retained buffer during the retry backoff window (#1180)", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-logger-"));
		try {
			const blocker = join(root, "blocker");
			writeFileSync(blocker, "i am a file, not a directory");
			const log = new Logger({
				logFilePath: join(blocker, "logs", "signet.log"),
				logDir: join(blocker, "logs"),
				consoleOutput: false,
				jsonFormat: false,
				level: "info",
				flushRetryBackoffMs: 60_000,
			});
			log.info("daemon", "first entry");
			// First append fails; the retry gate then holds the buffer.
			await new Promise((resolve) => setTimeout(resolve, 1100));
			for (let i = 0; i < 5000; i++) {
				log.info("daemon", `entry ${i}`);
			}
			// The next flush tick must trim to the cap even though it cannot
			// append yet (it is inside the backoff window).
			await new Promise((resolve) => setTimeout(resolve, 1100));
			const buffered = (log as unknown as { buffer: LogEntry[] }).buffer;
			expect(buffered.length).toBeLessThanOrEqual(2000);
			log.shutdown();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
