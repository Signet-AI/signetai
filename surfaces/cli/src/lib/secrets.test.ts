import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSecretKeyringAdapterForTests } from "@signet/core";
import { createOfflineSecretApiCall } from "./secrets.js";

const originalSignetPath = process.env.SIGNET_PATH;
let workspace = "";
let writerScript = "";

function runWriter(script: string, name: string, value: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, name, value], {
			env: { ...process.env, SIGNET_PATH: workspace },
			stdio: "ignore",
		});
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
	});
}

function unavailableKeyring() {
	return {
		platform: "test",
		service: "test",
		account: "test",
		async get() {
			return { state: "unavailable" as const, message: "test keyring unavailable" };
		},
		async set() {
			return { state: "unavailable" as const, message: "test keyring unavailable" };
		},
	};
}

afterEach(() => {
	setSecretKeyringAdapterForTests(null);
	if (originalSignetPath === undefined) delete process.env.SIGNET_PATH;
	else process.env.SIGNET_PATH = originalSignetPath;
	if (workspace) rmSync(workspace, { recursive: true, force: true });
	workspace = "";
	if (writerScript) rmSync(writerScript, { force: true });
	writerScript = "";
});

describe("daemonless secret API", () => {
	test("round-trips local secrets without a daemon", async () => {
		workspace = mkdtempSync(join(tmpdir(), "signet-offline-secrets-"));
		process.env.SIGNET_PATH = workspace;
		setSecretKeyringAdapterForTests(unavailableKeyring());
		const api = createOfflineSecretApiCall();

		expect(await api("GET", "/api/secrets")).toEqual({ ok: true, data: { secrets: [], provider: "local" } });
		expect(await api("POST", "/api/secrets/OFFLINE_KEY", { value: "offline-value" })).toEqual({
			ok: true,
			data: { success: true, name: "OFFLINE_KEY" },
		});
		expect(await api("GET", "/api/secrets")).toEqual({
			ok: true,
			data: { secrets: ["OFFLINE_KEY"], provider: "local" },
		});
		expect(await api("DELETE", "/api/secrets/OFFLINE_KEY")).toEqual({
			ok: true,
			data: { success: true, name: "OFFLINE_KEY" },
		});
		expect(await api("GET", "/api/secrets")).toEqual({ ok: true, data: { secrets: [], provider: "local" } });
	});

	test("executes a local secret synchronously without a daemon", async () => {
		workspace = mkdtempSync(join(tmpdir(), "signet-offline-secret-exec-"));
		process.env.SIGNET_PATH = workspace;
		setSecretKeyringAdapterForTests(unavailableKeyring());
		const api = createOfflineSecretApiCall();
		await api("POST", "/api/secrets/OFFLINE_KEY", { value: "offline-value" });
		const script = join(workspace, "print-secret.mjs");
		writeFileSync(script, "process.stdout.write(process.env.OFFLINE_KEY ?? '');\n");

		const response = await api("POST", "/api/secrets/exec", {
			command: `bun ${script}`,
			secrets: { OFFLINE_KEY: "OFFLINE_KEY" },
		});
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		expect(response.data.status).toBe("completed");
		expect(response.data.id).toBeNull();
		expect(response.data.result.stdout).toBe("[REDACTED]");
	});

	test("serializes concurrent CLI and daemon store writers", async () => {
		workspace = mkdtempSync(join(tmpdir(), "signet-concurrent-secrets-"));
		const writer = join(import.meta.dir, `.secret-writer-${process.pid}.mjs`);
		writerScript = writer;
		writeFileSync(
			writer,
			[
				'import { putLocalSecret, setSecretKeyringAdapterForTests } from "@signet/core";',
				'setSecretKeyringAdapterForTests({ platform: "test", service: "test", account: "test", async get() { return { state: "unavailable" }; }, async set() { return { state: "unavailable" }; } });',
				"await putLocalSecret(process.argv[2], process.argv[3]);",
			].join("\n"),
		);

		expect(
			await Promise.all([runWriter(writer, "FIRST_KEY", "first"), runWriter(writer, "SECOND_KEY", "second")]),
		).toEqual([0, 0]);
		process.env.SIGNET_PATH = workspace;
		setSecretKeyringAdapterForTests(unavailableKeyring());
		expect(await createOfflineSecretApiCall()("GET", "/api/secrets")).toEqual({
			ok: true,
			data: { secrets: ["FIRST_KEY", "SECOND_KEY"], provider: "local" },
		});
	});

	test("keeps external provider operations daemon-only", async () => {
		const api = createOfflineSecretApiCall();
		expect(await api("GET", "/api/secrets/bitwarden/status")).toEqual({
			ok: false,
			data: { error: "This secret operation requires a running Signet daemon" },
		});
	});
});
