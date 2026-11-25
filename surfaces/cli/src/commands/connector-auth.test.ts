import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConnectorRegistry, LoginStore, readKeyFile } from "../../../../libs/sdk/src/node.js";
import { registerConnectorCommands } from "./connector.js";

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
test("connect provisions a session-bound key without putting it in installer environment", async () => {
	const home = await mkdtemp(join(tmpdir(), "signet-connect-"));
	homes.push(home);
	const secret = `sig_sk_${crypto.randomUUID()}`;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (!new URL(request.url).pathname.startsWith("/api/auth/")) return Response.json({});
			expect(request.headers.get("authorization")).toBe("Bearer user-session");
			if (request.method === "GET")
				return Response.json({ mode: "team", credential: { kind: "session", deviceId: "device" } });
			const body = await request.json();
			expect(body).toEqual({ harness: "codex", deviceId: "device", agentId: "alice" });
			return Response.json(
				{ key: { id: "key-id", agentId: "alice", deviceId: "device", expiresAt: "2030-01-01" }, secret },
				{ status: 201 },
			);
		},
	});
	const env = { HOME: home };
	const keyring = {
		get: async () => ({ state: "unsupported" as const }),
		set: async () => ({ state: "unsupported" as const }),
	};
	await new LoginStore(server.url.origin, { env, keyring }).save({
		accessToken: "user-session",
		refreshToken: "refresh",
		accessExpiresAt: new Date(Date.now() + 60000).toISOString(),
		refreshExpiresAt: new Date(Date.now() + 120000).toISOString(),
	});
	const program = new Command();
	let installed = false;
	registerConnectorCommands(program, {
		agentsDir: home,
		env,
		keyring,
		configureHarnessHooks: async () => {
			expect(process.env.SIGNET_API_KEY).not.toBe(secret);
			installed = true;
		},
	});
	try {
		await program.parseAsync(["connect", "codex", "--url", server.url.origin, "--agent", "alice"], { from: "user" });
		expect(process.env.SIGNET_API_KEY).not.toBe(secret);
		const entries = await new ConnectorRegistry({ env }).read();
		const entry = entries.codex;
		expect(entry?.url).toBe(server.url.origin);
		expect(entry?.keyId).toBe("key-id");
		expect(await readKeyFile(entry?.keyFile ?? "missing")).toBe(secret);
		expect(await readFile(new ConnectorRegistry({ env }).path, "utf8")).not.toContain(secret);
	} finally {
		server.stop(true);
	}
});
