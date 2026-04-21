import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { queryPluginAuditEvents } from "../plugins/audit.js";
import { SIGNET_SECRETS_PLUGIN_ID, signetSecretsManifest } from "../plugins/bundled/secrets.js";
import { PluginHostV1 } from "../plugins/host.js";
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
	});

	afterEach(() => {
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
			body: JSON.stringify({ value: "sk-test" }),
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

	test("1Password compatibility status route does not require configured token", async () => {
		const res = await makeApp(makeHost()).request("/api/secrets/1password/status");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			configured: false,
			connected: false,
			vaults: [],
		});
	});
});
