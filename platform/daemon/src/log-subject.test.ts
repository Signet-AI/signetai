import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger, type LogEntry } from "./logger";
import { withLogSubject } from "./log-subject";

test("hook log subjects survive async boundaries without crossing requests or trusting log data", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-log-subject-"));
	const logger = new Logger({ logDir: root, consoleOutput: false, level: "debug" });
	const entries: LogEntry[] = [];
	logger.on("log", (entry: LogEntry) => entries.push(entry));
	try {
		await Promise.all(
			["hr", "public"].map((agentId) =>
				withLogSubject({ agentId, compartmentId: agentId === "hr" ? 7 : null }, async () => {
					await Promise.resolve();
					logger.info("hooks", agentId, { agentId: "spoof", compartmentId: null });
					logger.warn("hooks", agentId, new Error("hook failure"));
					logger.error("hooks", agentId, new Error("hook failure"));
				}),
			),
		);
		logger.info("hooks", "unattributed");
		for (const entry of entries) {
			if (entry.message === "unattributed") expect(entry.subject).toBeUndefined();
			else expect(entry.subject).toEqual({ agentId: entry.message, compartmentId: entry.message === "hr" ? 7 : null });
		}
		expect(entries).toHaveLength(7);
	} finally {
		logger.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});
