import "../../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectConnectorFiles } from "../lib/connector-doctor";

test.each(["sig_sk_", "legacy-"])(
	"connector doctor identifies %s credentials without returning their values",
	async (prefix) => {
		const home = await mkdtemp(join(tmpdir(), "doctor-"));
		const key = `${prefix}${crypto.randomUUID()}`;
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
	},
);
