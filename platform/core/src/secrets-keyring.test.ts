import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import {
	getSecretKeyring,
	resetSecretKeyringModuleForTests,
	setSecretKeyringHelperForTests,
	type SecretKeyringResult,
} from "./secrets-keyring";

const directories: string[] = [];

afterEach(async () => {
	setSecretKeyringHelperForTests(null);
	resetSecretKeyringModuleForTests();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("native secret keyring containment", () => {
	test("kills and reaps a helper that blocks native keyring work without blocking timers", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-helper-"));
		directories.push(directory);
		const pidPath = join(directory, "pid.txt");
		const helperPath = join(directory, "hang.ts");
		await writeFile(
			helperPath,
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`,
		);
		setSecretKeyringHelperForTests({ entryPath: helperPath, deadlineMs: 100 });
		let timerAdvanced = false;
		setTimeout(() => {
			timerAdvanced = true;
		}, 10);

		const descriptors = Array.from({ length: 1_100 }, () => openSync(devNull, "r"));
		const adapter = getSecretKeyring(directory);
		const getStatus = adapter.getStatus;
		if (getStatus === undefined) throw new Error("expected keyring status operation");
		let result: SecretKeyringResult;
		try {
			result = await getStatus.call(adapter);
		} finally {
			for (const descriptor of descriptors) closeSync(descriptor);
		}

		expect(result).toMatchObject({ state: "unavailable" });
		expect(result.message).toContain("deadline");
		expect(timerAdvanced).toBe(true);
		const pid = Number(await readFile(pidPath, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test("keeps the native addon import outside the parent adapter", async () => {
		const source = await readFile(new URL("./secrets-keyring.ts", import.meta.url), "utf8");
		expect(source).not.toContain('from "@napi-rs/keyring"');
		expect(source).not.toContain('require("@napi-rs/keyring")');
	});
});
