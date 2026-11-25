import "../../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectConnectorFiles } from "../lib/connector-doctor";

test("connector doctor identifies inline credentials without returning their values", async () => {
	const home = await mkdtemp(join(tmpdir(), "doctor-"));
	const key = `sig_sk_${crypto.randomUUID()}`;
	try {
		await mkdir(join(home, "plugins"));
		await writeFile(
			join(home, "settings.json"),
			JSON.stringify({ hooks: { SessionEnd: `SIGNET_API_KEY=${key} signet hook session-end` } }),
		);
		const report = await inspectConnectorFiles(join(home, "settings.json"));
		expect(report.inlineKeyFiles).toEqual([join(home, "settings.json")]);
		expect(JSON.stringify(report)).not.toContain(key);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
