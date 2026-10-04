import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLocalSecretNames, setSecretKeyringAdapterForTests } from "./secrets";

const originalSignetPath = process.env.SIGNET_PATH;
let workspace = "";

afterEach(async () => {
	setSecretKeyringAdapterForTests(null);
	if (originalSignetPath === undefined) delete process.env.SIGNET_PATH;
	else process.env.SIGNET_PATH = originalSignetPath;
	if (workspace) await rm(workspace, { recursive: true, force: true });
	workspace = "";
});

const absent = { state: "unavailable", backend: "absent" } as const;
const headlessKeyring = {
	platform: "test",
	service: "test",
	account: "test",
	async get() {
		return absent;
	},
	async set() {
		return absent;
	},
};

function runWriter(script: string, prefix: string, count: number): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, prefix, String(count)], {
			env: { ...process.env, SIGNET_PATH: workspace },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.once("error", reject);
		child.once("exit", (code) => resolve({ code, stderr }));
	});
}

test("concurrent writers never fail releasing the store lock to a waiting writer", async () => {
	workspace = await mkdtemp(join(tmpdir(), "signet-secrets-lock-"));
	const script = join(workspace, "writer.mjs");
	await writeFile(
		script,
		[
			`import { putLocalSecret, setSecretKeyringAdapterForTests } from ${JSON.stringify(join(import.meta.dir, "secrets.ts"))};`,
			'const absent = async () => ({ state: "unavailable", backend: "absent" });',
			'setSecretKeyringAdapterForTests({ platform: "test", service: "test", account: "test", get: absent, set: absent });',
			"const [prefix, count] = process.argv.slice(2);",
			'for (let index = 0; index < Number(count); index += 1) await putLocalSecret(prefix + "_" + index, "value-" + index);',
		].join("\n"),
	);

	const writers = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
	const results = await Promise.all(writers.map((prefix) => runWriter(script, prefix, 40)));

	expect(results.filter((result) => result.code !== 0)).toEqual([]);
	process.env.SIGNET_PATH = workspace;
	setSecretKeyringAdapterForTests(headlessKeyring);
	const names = listLocalSecretNames();
	expect(names).toHaveLength(writers.length * 40);
}, 60_000);
