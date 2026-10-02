import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { type BitwardenClient, setBitwardenClientFactoryForTests } from "../bitwarden.js";
import { ONEPASSWORD_SERVICE_ACCOUNT_SECRET } from "../onepassword.js";
import { queryPluginAuditEvents } from "../plugins/audit.js";
import { SIGNET_SECRETS_PLUGIN_ID, signetSecretsManifest } from "../plugins/bundled/secrets.js";
import { PluginHostV1 } from "../plugins/host.js";
import {
	getLocalSecretValue,
	getSecret,
	putSecret,
	resetSecretExecJobsForTests,
	setSecretKeyringAdapterForTests,
} from "../secrets.js";
import { registerSecretRoutes } from "./secrets-routes.js";

const originalSignetPath = process.env.SIGNET_PATH;
let agentsDir = "";

function makeHost(grantedCapabilities: readonly string[] = signetSecretsManifest.capabilities): PluginHostV1 {
	const host = new PluginHostV1({
		storagePath: null,
		auditPath: null,
		corePluginIds: [SIGNET_SECRETS_PLUGIN_ID],
		now: () => new Date("2026-04-16T12:00:00.000Z"),
	});
	host.discover(signetSecretsManifest, { grantedCapabilities });
	return host;
}

function makeApp(host: PluginHostV1): Hono {
	const app = new Hono();
	registerSecretRoutes(app, host);
	return app;
}

describe("secrets routes plugin capability enforcement", () => {
	beforeEach(() => {
		agentsDir = join(tmpdir(), `signet-secrets-routes-${process.pid}-${Date.now()}`);
		process.env.SIGNET_PATH = agentsDir;
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, "agent.yaml"), "name: fixture\n");
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		writeFileSync(join(agentsDir, "memory", "memories.db"), "");
		let key: string | undefined = Buffer.alloc(32, 7).toString("base64");
		setSecretKeyringAdapterForTests({
			platform: "darwin",
			service: "fixture",
			account: "fixture",
			async get() {
				return key ? { state: "found", value: key } : { state: "missing" };
			},
			async set(value) {
				key = value;
				return { state: "found", value };
			},
		});
	});

	afterEach(() => {
		resetSecretExecJobsForTests();
		setSecretKeyringAdapterForTests(null);
		if (originalSignetPath === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = originalSignetPath;
		}
		if (agentsDir && existsSync(agentsDir)) {
			rmSync(agentsDir, { recursive: true, force: true });
		}
	});

	test("denies routes when required plugin capabilities are not granted", async () => {
		const app = makeApp(makeHost(["secrets:list"]));

		const res = await app.request("/api/secrets/OPENAI_API_KEY", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: "sk-test", authorizeKeyring: true }),
		});
		const body = (await res.json()) as { status: string; missingCapabilities: string[] };

		expect(res.status).toBe(403);
		expect(body.status).toBe("capability-missing");
		expect(body.missingCapabilities).toEqual(["secrets:write"]);
		const audit = queryPluginAuditEvents({
			pluginId: SIGNET_SECRETS_PLUGIN_ID,
			event: "plugin.capability_denied",
		});
		expect(audit.count).toBe(1);
		expect(audit.events[0]?.result).toBe("denied");
		expect(audit.events[0]?.source).toBe("secrets-routes");
	});

	test("API-key recovery requires explicit consent and verifies persistent access before writing", async () => {
		await putSecret("EXISTING", "fixture-existing");
		const file = join(agentsDir, ".secrets", "secrets.enc");
		const before = readFileSync(file, "utf8");
		const calls: boolean[] = [];
		let persistent = false;
		let grantOnConsent = false;
		const key = Buffer.alloc(32, 7).toString("base64");
		setSecretKeyringAdapterForTests({
			platform: "darwin",
			service: "fixture",
			account: "fixture",
			async get(options) {
				calls.push(options?.allowInteraction === true);
				if (options?.allowInteraction === true && grantOnConsent) persistent = true;
				if (options?.allowInteraction || persistent) return { state: "found", value: key };
				return {
					state: "locked",
					message: "Platform failure: The user name or passphrase you entered is not correct.",
				};
			},
			async set() {
				throw new Error("must not replace the master key");
			},
		});
		const app = makeApp(makeHost());
		const post = (body: unknown) =>
			app.request("/api/secrets/ZAI_API_KEY", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const locked = await post({ value: "fixture-zai" });
		expect(locked.status).toBe(423);
		expect(await locked.json()).toMatchObject({
			code: "keyring-locked",
			authorizationRequired: process.platform === "darwin",
		});
		expect(calls).toEqual([false]);
		expect(readFileSync(file, "utf8")).toBe(before);
		calls.length = 0;
		const once = await post({ value: "fixture-zai", authorizeKeyring: true });
		expect(once.status).toBe(423);
		expect(calls).toEqual([false, true, false]);
		expect(readFileSync(file, "utf8")).toBe(before);
		calls.length = 0;
		const invalid = await post({ value: "fixture-zai", authorizeKeyring: "yes" });
		expect(invalid.status).toBe(400);
		expect(calls).toEqual([]);
		grantOnConsent = true;
		const saved = await post({ value: "fixture-zai", authorizeKeyring: true });
		expect(saved.status).toBe(200);
		expect(calls).toEqual([false, true, false]);
		expect(await getLocalSecretValue("EXISTING")).toBe("fixture-existing");
		expect(await getLocalSecretValue("ZAI_API_KEY")).toBe("fixture-zai");
	});

	test("failed first-use key creation offers unlock guidance instead of unusable consent", async () => {
		setSecretKeyringAdapterForTests({
			platform: "darwin",
			service: "fixture",
			account: "fixture",
			async get() {
				return { state: "missing" };
			},
			async set() {
				return { state: "locked" };
			},
		});
		const res = await makeApp(makeHost()).request("/api/secrets/ZAI_API_KEY", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: "fixture-zai" }),
		});
		expect(res.status).toBe(423);
		expect(await res.json()).toMatchObject({ authorizationRequired: false });
		expect(existsSync(join(agentsDir, ".secrets", "secrets.enc"))).toBe(false);
	});

	test("request cancellation reaches consent and leaves encrypted credentials untouched", async () => {
		await putSecret("EXISTING", "fixture-existing");
		const file = join(agentsDir, ".secrets", "secrets.enc");
		const before = readFileSync(file, "utf8");
		let entered: () => void = () => {};
		const consent = new Promise<void>((resolve) => {
			entered = resolve;
		});
		setSecretKeyringAdapterForTests({
			platform: "darwin",
			service: "fixture",
			account: "fixture",
			async get(options) {
				if (!options?.allowInteraction) return { state: "locked" };
				entered();
				await new Promise<void>((resolve) =>
					options.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				return { state: "found", value: Buffer.alloc(32, 7).toString("base64") };
			},
			async set() {
				throw new Error("must not replace the master key");
			},
		});
		const controller = new AbortController();
		const settled = Promise.withResolvers<Response>();
		const app = makeApp(makeHost());
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const response = await app.fetch(request);
				settled.resolve(response);
				return response;
			},
		});
		try {
			const response = fetch(new URL("/api/secrets/ZAI_API_KEY", server.url), {
				method: "POST",
				signal: controller.signal,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ value: "fixture-zai", authorizeKeyring: true }),
			}).catch(() => null);
			await consent;
			controller.abort();
			expect(await response).toBeNull();
			const result = await Promise.race([settled.promise, Bun.sleep(1000).then(() => null)]);
			expect(result?.status).toBe(400);
			expect(readFileSync(file, "utf8")).toBe(before);
		} finally {
			server.stop(true);
		}
	});

	test("disabled signet.secrets blocks route access without deleting stored secrets", async () => {
		const host = makeHost();
		const app = makeApp(host);

		const stored = await app.request("/api/secrets/OPENAI_API_KEY", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: "sk-test" }),
		});
		expect(stored.status).toBe(200);
		expect(await stored.json()).toEqual({ success: true, name: "OPENAI_API_KEY" });

		host.setEnabled(SIGNET_SECRETS_PLUGIN_ID, false);
		const blocked = await app.request("/api/secrets");
		const blockedBody = (await blocked.json()) as { status: string };
		expect(blocked.status).toBe(403);
		expect(blockedBody.status).toBe("plugin-inactive");

		host.setEnabled(SIGNET_SECRETS_PLUGIN_ID, true);
		const listed = await app.request("/api/secrets");
		const listedBody = (await listed.json()) as { secrets: string[] };
		expect(listed.status).toBe(200);
		expect(listedBody.secrets).toEqual(["OPENAI_API_KEY"]);
		expect(JSON.stringify(listedBody)).not.toContain("sk-test");
	});

	test("queues secret exec jobs by default and polls status without holding the route open", async () => {
		await putSecret("OPENAI_API_KEY", "sk-route-background");
		const app = makeApp(makeHost());
		const script = join(agentsDir, "route-background.mjs");
		writeFileSync(script, "setTimeout(() => process.stdout.write(process.env.OPENAI_API_KEY), 25);\n");

		const queued = await app.request("/api/secrets/exec", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				command: `bun ${script}`,
				secrets: { OPENAI_API_KEY: "OPENAI_API_KEY" },
				timeoutMs: 1000,
			}),
		});

		expect(queued.status).toBe(202);
		const queuedBody = (await queued.json()) as { id: string; status: string; result?: unknown };
		expect(queuedBody.id.length).toBeGreaterThan(0);
		expect(["queued", "running"]).toContain(queuedBody.status);
		expect(queuedBody.result).toBeUndefined();

		let statusBody: { status: string; result?: { stdout: string; code: number } } | undefined;
		for (let i = 0; i < 20 && statusBody?.status !== "completed"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			const status = await app.request(`/api/secrets/exec/${queuedBody.id}`);
			expect(status.status).toBe(200);
			statusBody = (await status.json()) as { status: string; result?: { stdout: string; code: number } };
		}

		expect(statusBody?.status).toBe("completed");
		expect(statusBody?.result?.code).toBe(0);
		expect(statusBody?.result?.stdout).toBe("[REDACTED]");
		expect(statusBody?.result?.stdout).not.toContain("sk-route-background");
	});

	test("rejects malformed secret exec commands before queueing", async () => {
		const app = makeApp(makeHost());
		for (const [path, body] of [
			["/api/secrets/exec", { command: {}, secrets: { OPENAI_API_KEY: "OPENAI_API_KEY" } }],
			["/api/secrets/OPENAI_API_KEY/exec", { command: "   " }],
		] as const) {
			const res = await app.request(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			expect(res.status).toBe(400);
		}
	});

	test("rejects empty or malformed secret exec maps", async () => {
		const app = makeApp(makeHost());
		for (const secrets of [{}, [], "OPENAI_API_KEY", { OPENAI_API_KEY: "" }]) {
			const res = await app.request("/api/secrets/exec", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ command: "bun --version", secrets }),
			});
			expect(res.status).toBe(400);
		}
	});

	test("legacy single-secret exec rejects empty override maps", async () => {
		const app = makeApp(makeHost());
		const res = await app.request("/api/secrets/OPENAI_API_KEY/exec", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "bun --version", secrets: {} }),
		});

		expect(res.status).toBe(400);
	});

	test("Bitwarden routes connect, activate, write through, migrate, and disconnect without losing local fallback", async () => {
		const items = new Map<string, string>();
		const writeFolders = new Map<string, string | undefined>();
		const folders = [{ id: "folder-1", name: "Signet" }];
		const makeClient = async (_session: string): Promise<BitwardenClient> => ({
			async status() {
				return { status: "unlocked", userEmail: "agent@example.com", serverUrl: "https://vault.bitwarden.com" };
			},
			async listFolders() {
				return folders;
			},
			async listItems() {
				return Array.from(items.keys()).map((name) => ({ id: `item-${name}`, name }));
			},
			async getItem(id: string) {
				const name = id.replace(/^item-/, "");
				return { id, name, login: { password: items.get(name) ?? null } };
			},
			async putSecret(name: string, value: string, options?: { readonly folderId?: string }) {
				items.set(name, value);
				writeFolders.set(name, options?.folderId);
				return { id: `item-${name}`, name, folderId: options?.folderId, login: { password: value } };
			},
			async deleteSecret(name: string) {
				return items.delete(name);
			},
			async resolveSecret(ref: string) {
				const name = decodeURIComponent(ref.replace("bw://name/", ""));
				const value = items.get(name);
				if (!value) throw new Error(`Bitwarden item '${name}' not found`);
				return value;
			},
		});
		setBitwardenClientFactoryForTests(makeClient);
		const app = makeApp(makeHost());

		const local = await app.request("/api/secrets/LOCAL_ONLY", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: "local-value" }),
		});
		expect(local.status).toBe(200);

		const connected = await app.request("/api/secrets/bitwarden/connect", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ session: "bw-session", activate: true, folderId: "folder-1" }),
		});
		expect(connected.status).toBe(200);
		expect(await connected.json()).toMatchObject({
			success: true,
			configured: true,
			connected: true,
			activeProvider: true,
		});

		const storedInBitwarden = await app.request("/api/secrets/BW_ONLY", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: "bw-value" }),
		});
		expect(storedInBitwarden.status).toBe(200);
		expect(items.get("BW_ONLY")).toBe("bw-value");
		expect(writeFolders.get("BW_ONLY")).toBe("folder-1");

		const listed = await app.request("/api/secrets");
		expect(listed.status).toBe(200);
		expect(await listed.json()).toMatchObject({ provider: "bitwarden", secrets: ["BW_ONLY", "LOCAL_ONLY"] });

		const dryRun = await app.request("/api/secrets/bitwarden/migrate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dryRun: true }),
		});
		expect(dryRun.status).toBe(200);
		expect(await dryRun.json()).toMatchObject({ success: true, dryRun: true, migratedCount: 0, skippedCount: 1 });

		const migrated = await app.request("/api/secrets/bitwarden/migrate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dryRun: false, overwrite: true }),
		});
		expect(migrated.status).toBe(200);
		expect(await migrated.json()).toMatchObject({ success: true, dryRun: false, migratedCount: 1 });
		expect(items.get("LOCAL_ONLY")).toBe("local-value");

		const deletedMigrated = await app.request("/api/secrets/LOCAL_ONLY", { method: "DELETE" });
		expect(deletedMigrated.status).toBe(200);
		expect(items.has("LOCAL_ONLY")).toBe(false);
		expect(await getLocalSecretValue("LOCAL_ONLY")).toBe("local-value");
		await expect(getSecret("LOCAL_ONLY")).rejects.toThrow();
		const listedAfterDelete = await app.request("/api/secrets");
		expect(listedAfterDelete.status).toBe(200);
		expect(await listedAfterDelete.json()).toMatchObject({ provider: "bitwarden", secrets: ["BW_ONLY"] });

		const reconnected = await app.request("/api/secrets/bitwarden/connect", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ session: "bw-session-2", activate: true }),
		});
		expect(reconnected.status).toBe(200);
		const storedAfterReconnect = await app.request("/api/secrets/BW_NO_FOLDER", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: "bw-no-folder" }),
		});
		expect(storedAfterReconnect.status).toBe(200);
		expect(writeFolders.get("BW_NO_FOLDER")).toBeUndefined();

		const foldersRes = await app.request("/api/secrets/bitwarden/folders");
		expect(foldersRes.status).toBe(200);
		expect(await foldersRes.json()).toEqual({ folders: [{ id: "folder-1", name: "Signet" }], count: 1 });

		const disconnected = await app.request("/api/secrets/bitwarden/connect", { method: "DELETE" });
		expect(disconnected.status).toBe(200);
		expect(await disconnected.json()).toMatchObject({ success: true, disconnected: true, activeProvider: false });
	});

	test("Bitwarden connect validates session before persisting or activating", async () => {
		setBitwardenClientFactoryForTests(
			async (session: string): Promise<BitwardenClient> => ({
				async status() {
					if (session === "good") return { status: "unlocked" };
					if (session === "unknown") return {};
					return { status: "locked" };
				},
				async listFolders() {
					return [];
				},
				async listItems() {
					return [];
				},
				async getItem(id: string) {
					return { id, name: id, login: { password: null } };
				},
				async putSecret(name: string, value: string) {
					return { id: name, name, login: { password: value } };
				},
				async deleteSecret() {
					return false;
				},
				async resolveSecret() {
					throw new Error("not found");
				},
			}),
		);
		const app = makeApp(makeHost());

		const rejected = await app.request("/api/secrets/bitwarden/connect", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ session: "bad", activate: true }),
		});
		expect(rejected.status).toBe(400);
		expect(await rejected.json()).toMatchObject({ success: false, connected: false, activeProvider: false });

		const rejectedUnknown = await app.request("/api/secrets/bitwarden/connect", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ session: "unknown", activate: true }),
		});
		expect(rejectedUnknown.status).toBe(400);
		expect(await rejectedUnknown.json()).toMatchObject({ success: false, connected: false, activeProvider: false });

		const status = await app.request("/api/secrets/bitwarden/status");
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ configured: false, connected: false, activeProvider: false });

		const useBitwarden = await app.request("/api/secrets/bitwarden/provider", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ provider: "bitwarden" }),
		});
		expect(useBitwarden.status).toBe(400);

		const accepted = await app.request("/api/secrets/bitwarden/connect", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ session: "good", activate: false }),
		});
		expect(accepted.status).toBe(200);
		expect(await accepted.json()).toMatchObject({ success: true, connected: true, activeProvider: false });
	});

	test("1Password compatibility status route does not require configured token", async () => {
		const res = await makeApp(makeHost()).request("/api/secrets/1password/status");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			configured: false,
			connected: false,
			vaults: [],
		});
	});

	test("1Password disconnect returns the resolved deletion result", async () => {
		await putSecret(ONEPASSWORD_SERVICE_ACCOUNT_SECRET, "op-test-token");

		const res = await makeApp(makeHost()).request("/api/secrets/1password/connect", { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, disconnected: true, existed: true });
	});
});
