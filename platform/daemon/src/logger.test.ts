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
			await new Promise((resolve) => setTimeout(resolve, 1100));
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
				flushRetryBackoffMs: 60_000,
			});
			log.info("daemon", "crash trail entry");
			await new Promise((resolve) => setTimeout(resolve, 1100));
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
			await new Promise((resolve) => setTimeout(resolve, 1100));
			for (let i = 0; i < 5000; i++) {
				log.info("daemon", `entry ${i}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 1100));
			const buffered = (log as unknown as { buffer: LogEntry[] }).buffer;
			expect(buffered.length).toBeLessThanOrEqual(2000);
			log.shutdown();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
