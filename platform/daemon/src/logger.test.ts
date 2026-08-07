import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Logger, resolveLoggerConfig } from "./logger";

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

	it("logs the resolved log file path at startup (#1162)", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-logger-"));
		try {
			const log = new Logger({ logDir: root, consoleOutput: false, jsonFormat: false, level: "info" });
			log.shutdown();
			const today = new Date().toISOString().split("T")[0];
			const expected = join(root, `signet-${today}.log`);
			const content = readFileSync(expected, "utf-8");
			expect(content).toContain("File logging to");
			expect(content).toContain(expected);
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
});
