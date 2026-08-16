import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setSecretStoreLockHookForTests, getLocalSecretValue, setSecretKeyringAdapterForTests } from "@signet/core";
import { createOfflineSecretApiCall, createSecretCommandApiCall } from "./secrets.js";

const originalSignetPath = process.env.SIGNET_PATH;
const originalDbusSessionBusAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
let workspace = "";
let writerScript = "";

function runWriter(
	script: string,
	name: string,
	value: string,
	extraEnv: Record<string, string> = {},
): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, name, value], {
			env: { ...process.env, SIGNET_PATH: workspace, ...extraEnv },
			stdio: "ignore",
		});
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
	});
}

async function waitForFile(path: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (existsSync(path)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Timed out waiting for ${path}`);
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
	__setSecretStoreLockHookForTests(null);
	setSecretKeyringAdapterForTests(null);
	if (originalSignetPath === undefined) delete process.env.SIGNET_PATH;
	else process.env.SIGNET_PATH = originalSignetPath;
	if (originalDbusSessionBusAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
	else process.env.DBUS_SESSION_BUS_ADDRESS = originalDbusSessionBusAddress;
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

	test("does not leak short secrets from offline exec output", async () => {
		workspace = mkdtempSync(join(tmpdir(), "signet-offline-short-secret-exec-"));
		process.env.SIGNET_PATH = workspace;
		setSecretKeyringAdapterForTests(unavailableKeyring());
		const api = createOfflineSecretApiCall();
		await api("POST", "/api/secrets/SHORT_KEY", { value: "x" });
		const script = join(workspace, "print-short-secret.mjs");
		writeFileSync(script, "process.stdout.write(process.env.SHORT_KEY ?? '');\n");

		const response = await api("POST", "/api/secrets/exec", {
			command: `bun ${script}`,
			secrets: { SHORT_KEY: "SHORT_KEY" },
		});
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		expect(response.data.result.stdout).not.toContain("x");
		expect(response.data.result.stdout).toBe("[REDACTED]");
	});

	test("falls back to synchronous encrypted-store exec when D-Bus is absent", async () => {
		workspace = mkdtempSync(join(tmpdir(), "signet-headless-secret-exec-"));
		process.env.SIGNET_PATH = workspace;
		delete process.env.DBUS_SESSION_BUS_ADDRESS;
		const offline = createOfflineSecretApiCall();
		await offline("POST", "/api/secrets/HEADLESS_KEY", { value: "headless-value" });
		const script = join(workspace, "print-headless-secret.mjs");
		writeFileSync(script, "process.stdout.write(process.env.HEADLESS_KEY ?? '');\n");
		let daemonCalls = 0;
		const api = createSecretCommandApiCall({
			daemonApiCall: async () => {
				daemonCalls += 1;
				return { ok: true, data: { daemon: true } };
			},
			offlineApiCall: offline,
			isDaemonRunning: async () => true,
			agentsDir: workspace,
		});

		const response = await api("POST", "/api/secrets/exec", {
			command: `bun ${script}`,
			secrets: { HEADLESS_KEY: "HEADLESS_KEY" },
		});

		expect(daemonCalls).toBe(0);
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		expect(response.data.result.stdout).toBe("[REDACTED]");
		expect(response.data.result.stdout).not.toContain("headless-value");
	});

	test("keeps daemon keyring preference and fail-closed keyring classifications", async () => {
		workspace = mkdtempSync(join(tmpdir(), "signet-keyring-preference-"));
		const offline = createOfflineSecretApiCall();
		let daemonCalls = 0;
		const daemon = async () => {
			daemonCalls += 1;
			return { ok: true, data: { daemon: true } };
		};

		const foundApi = createSecretCommandApiCall({
			daemonApiCall: daemon,
			offlineApiCall: offline,
			isDaemonRunning: async () => true,
			agentsDir: workspace,
			readKeyring: async () => ({ state: "found", value: "not-used-by-test" }),
		});
		expect(await foundApi("GET", "/api/secrets")).toEqual({ ok: true, data: { daemon: true } });
		expect(daemonCalls).toBe(1);

		const lockedApi = createSecretCommandApiCall({
			daemonApiCall: daemon,
			offlineApiCall: offline,
			isDaemonRunning: async () => true,
			agentsDir: workspace,
			readKeyring: async () => ({ state: "locked", message: "keyring is locked" }),
		});
		expect(await lockedApi("POST", "/api/secrets/exec", { command: "true", secrets: { X: "X" } })).toEqual({
			ok: true,
			data: { daemon: true },
		});
		expect(daemonCalls).toBe(2);
	});

	test("serializes racing CLI and daemon store writers", async () => {
		workspace = mkdtempSync(join(tmpdir(), "signet-concurrent-secrets-"));
		const writer = join(import.meta.dir, `.secret-writer-${process.pid}.mjs`);
		writerScript = writer;
		const ownerReady = join(workspace, "owner-ready");
		const ownerGo = join(workspace, "owner-go");
		const loserStarted = join(workspace, "loser-started");
		writeFileSync(
			writer,
			[
				'import { existsSync, writeFileSync } from "node:fs";',
				'import { __setSecretStoreLockHookForTests, putLocalSecret, setSecretKeyringAdapterForTests } from "@signet/core";',
				'setSecretKeyringAdapterForTests({ platform: "test", service: "test", account: "test", async get() { return { state: "unavailable" }; }, async set() { return { state: "unavailable" }; } });',
				'const pause = (stage, expected, ready, go) => { if (stage !== expected || !ready || !go) return; writeFileSync(ready, "ready"); while (!existsSync(go)) {} };',
				'if (process.env.SIGNET_LOCK_READY || process.env.SIGNET_STALE_READY) __setSecretStoreLockHookForTests((stage) => { pause(stage, "after-acquire", process.env.SIGNET_LOCK_READY, process.env.SIGNET_LOCK_GO); pause(stage, "after-stale-check", process.env.SIGNET_STALE_READY, process.env.SIGNET_STALE_GO); });',
				'if (process.env.SIGNET_WRITER_STARTED) writeFileSync(process.env.SIGNET_WRITER_STARTED, "started");',
				"await putLocalSecret(process.argv[2], process.argv[3]);",
			].join("\n"),
		);

		const owner = runWriter(writer, "FIRST_KEY", "first", {
			SIGNET_LOCK_READY: ownerReady,
			SIGNET_LOCK_GO: ownerGo,
		});
		await waitForFile(ownerReady);
		const loser = runWriter(writer, "SECOND_KEY", "second", { SIGNET_WRITER_STARTED: loserStarted });
		await waitForFile(loserStarted);
		writeFileSync(ownerGo, "go");
		expect(await Promise.all([owner, loser])).toEqual([0, 0]);
		process.env.SIGNET_PATH = workspace;
		setSecretKeyringAdapterForTests(unavailableKeyring());
		expect(await createOfflineSecretApiCall()("GET", "/api/secrets")).toEqual({
			ok: true,
			data: { secrets: ["FIRST_KEY", "SECOND_KEY"], provider: "local" },
		});
	});

	test("a delayed stale reaper cannot remove a newly reacquired lock", async () => {
		workspace = mkdtempSync(join(tmpdir(), "signet-delayed-stale-reaper-"));
		const lockDirectory = join(workspace, ".secrets", "secrets.enc.lock");
		mkdirSync(lockDirectory, { recursive: true });
		writeFileSync(join(lockDirectory, "owner"), "999999999-dead-owner\n");

		const writer = join(import.meta.dir, `.secret-stale-writer-${process.pid}.mjs`);
		writerScript = writer;
		const staleReady = join(workspace, "stale-ready");
		const staleGo = join(workspace, "stale-go");
		const replacementReady = join(workspace, "replacement-ready");
		const replacementGo = join(workspace, "replacement-go");
		writeFileSync(
			writer,
			[
				'import { existsSync, writeFileSync } from "node:fs";',
				'import { __setSecretStoreLockHookForTests, putLocalSecret, setSecretKeyringAdapterForTests } from "@signet/core";',
				'setSecretKeyringAdapterForTests({ platform: "test", service: "test", account: "test", async get() { return { state: "unavailable" }; }, async set() { return { state: "unavailable" }; } });',
				'const pause = (stage, expected, ready, go) => { if (stage !== expected || !ready || !go) return; writeFileSync(ready, "ready"); while (!existsSync(go)) {} };',
				'__setSecretStoreLockHookForTests((stage) => { pause(stage, "after-acquire", process.env.SIGNET_LOCK_READY, process.env.SIGNET_LOCK_GO); pause(stage, "after-stale-check", process.env.SIGNET_STALE_READY, process.env.SIGNET_STALE_GO); });',
				"await putLocalSecret(process.argv[2], process.argv[3]);",
			].join("\n"),
		);

		const reaper = runWriter(writer, "FIRST_KEY", "first", {
			SIGNET_STALE_READY: staleReady,
			SIGNET_STALE_GO: staleGo,
		});
		await waitForFile(staleReady);

		const replacement = runWriter(writer, "SECOND_KEY", "second", {
			SIGNET_LOCK_READY: replacementReady,
			SIGNET_LOCK_GO: replacementGo,
		});
		await waitForFile(replacementReady);
		const replacementOwner = readFileSync(join(lockDirectory, "owner"), "utf-8");

		writeFileSync(staleGo, "go");
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		expect(readFileSync(join(lockDirectory, "owner"), "utf-8")).toBe(replacementOwner);
		writeFileSync(replacementGo, "go");
		expect(await Promise.all([reaper, replacement])).toEqual([0, 0]);

		process.env.SIGNET_PATH = workspace;
		setSecretKeyringAdapterForTests(unavailableKeyring());
		expect(await getLocalSecretValue("FIRST_KEY")).toBe("first");
		expect(await getLocalSecretValue("SECOND_KEY")).toBe("second");
	});

	test("keeps external provider operations daemon-only", async () => {
		const api = createOfflineSecretApiCall();
		expect(await api("GET", "/api/secrets/bitwarden/status")).toEqual({
			ok: false,
			data: { error: "This secret operation requires a running Signet daemon" },
		});
	});
});
