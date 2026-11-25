import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { withFileLock } from "../node/storage.js";

test("legacy migration does not steal a fresh pre-upgrade participant", async () => {
	const home = await mkdtemp(join(tmpdir(), "sdk-legacy-lock-"));
	const lock = join(home, ".lock");
	const token = randomUUID();
	try {
		await mkdir(`${lock}.tickets`, { mode: 0o700 });
		await writeFile(
			join(`${lock}.tickets`, `${token}.json`),
			JSON.stringify({ pid: process.pid, token, createdAt: Date.now(), choosing: false, ticket: 1 }),
			{ mode: 0o600 },
		);
		let entered = false;
		await expect(
			withFileLock(
				lock,
				async () => {
					entered = true;
				},
				AbortSignal.timeout(100),
			),
		).rejects.toThrow();
		expect(entered).toBe(false);
	} finally {
		await rm(home, { force: true, recursive: true });
	}
});
