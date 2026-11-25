import "../../../../tests/support/connector-safety.js";
import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, readFile, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	ConnectorRegistry,
	LoginStore,
	readKeyFile,
	writeKeyFile,
	DurableOutbox,
} from "../../../../libs/sdk/src/node.js";
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
			if (request.method === "GET" && request.headers.get("authorization") === `Bearer ${secret}`)
				return Response.json({ mode: "team", credential: { kind: "api_key" } });
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
	registerConnectorCommands(program, { agentsDir: home, env, keyring });
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

async function lifecycleFixture(mode: "local" | "team" = "team") {
	const home = await mkdtemp(join(tmpdir(), "signet-connector-lifecycle-"));
	homes.push(home);
	const env = { HOME: home };
	const secret = `sig_sk_${crypto.randomUUID()}`;
	const previousSecret = `sig_sk_${crypto.randomUUID()}`;
	let revoked = false;
	const metadata = {
		id: "previous",
		last_used_at: "2026-11-25T12:00:00.000Z",
		expires_at: new Date(Date.now() + 86400000).toISOString(),
	};
	const keyring = {
		get: async () => ({ state: "unsupported" as const }),
		set: async () => ({ state: "unsupported" as const }),
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/api/auth/connector-keys/previous" && request.method === "DELETE") {
				revoked = true;
				return Response.json({ reason: "not_found" }, { status: 404 });
			}
			if (path === "/api/auth/connector-keys" && request.method === "GET")
				return Response.json({ keys: [{ ...metadata, revoked_at: revoked ? "2026-11-25T12:01:00.000Z" : null }] });
			if (path === "/api/org/keys") return Response.json({ keys: [{ userId: null }] });
			if (path === "/api/auth/connector-keys" && request.method === "POST")
				return Response.json(
					{ key: { id: "replacement", agentId: "alice", deviceId: "device", expiresAt: "2030-01-01" }, secret },
					{ status: 201 },
				);
			if (path === "/api/auth/whoami")
				return Response.json({
					mode,
					credential:
						request.headers.get("authorization") === `Bearer ${secret}`
							? { kind: "api_key" }
							: { kind: "session", deviceId: "device" },
				});
			return Response.json({});
		},
	});
	if (mode === "team")
		await new LoginStore(server.url.origin, { env, keyring }).save({
			accessToken: "user-session",
			refreshToken: "refresh",
			accessExpiresAt: new Date(Date.now() + 60000).toISOString(),
			refreshExpiresAt: new Date(Date.now() + 120000).toISOString(),
		});
	const registry = new ConnectorRegistry({ env });
	const keyFile = await writeKeyFile(server.url.origin, "codex", previousSecret, { env });
	await registry.set("codex", { url: server.url.origin, keyFile, keyId: "previous", agentId: "alice" });
	const codexHome = join(home, "codex");
	const priorHome = process.env.CODEX_HOME;
	process.env.CODEX_HOME = codexHome;
	await mkdir(codexHome);
	await writeFile(
		join(codexHome, "config.toml"),
		`[mcp_servers.signet]\nurl = '${server.url.origin}/mcp'\n[mcp_servers.signet.http_headers]\nAuthorization = 'Bearer ${previousSecret}'\n`,
	);
	return {
		home,
		env,
		secret,
		previousSecret,
		registry,
		keyFile,
		codexHome,
		server,
		metadata,
		async run(args: string[]) {
			process.exitCode = 0;
			const program = new Command();
			registerConnectorCommands(program, { agentsDir: home, env, keyring, flagUrl: server.url.origin });
			await program.parseAsync(args, { from: "user" });
			const code = process.exitCode ?? 0;
			process.exitCode = 0;
			return code;
		},
		cleanup() {
			server.stop(true);
			if (priorHome === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = priorHome;
			process.exitCode = 0;
		},
	};
}

test.each(["rotate", "disconnect"])("%s succeeds when the previous key is already revoked", async (operation) => {
	const fixture = await lifecycleFixture();
	try {
		const args = operation === "rotate" ? ["connector", "rotate", "codex"] : ["disconnect", "codex"];
		expect(await fixture.run(args)).toBe(0);
		const entry = (await fixture.registry.read()).codex;
		if (operation === "rotate") {
			expect(entry?.keyId).toBe("replacement");
			expect(await readKeyFile(entry?.keyFile ?? "missing")).toBe(fixture.secret);
			const config = await readFile(join(fixture.codexHome, "config.toml"), "utf8");
			expect(config).not.toContain(fixture.previousSecret);
			expect(config).not.toContain(fixture.secret);
			expect(config).not.toContain("http_headers");
		} else {
			expect(entry).toBeUndefined();
			expect(await Bun.file(fixture.keyFile).exists()).toBe(false);
		}
	} finally {
		fixture.cleanup();
	}
});

test.each(["rotate", "disconnect"])(
	"%s preserves recoverable local state when the server is unreachable",
	async (operation) => {
		const fixture = await lifecycleFixture();
		try {
			const before = await fixture.registry.read();
			const config = await readFile(join(fixture.codexHome, "config.toml"), "utf8");
			fixture.server.stop(true);
			const args = operation === "rotate" ? ["connector", "rotate", "codex"] : ["disconnect", "codex"];
			expect(await fixture.run(args)).toBe(1);
			expect(await fixture.registry.read()).toEqual(before);
			expect(await readKeyFile(fixture.keyFile)).toBe(fixture.previousSecret);
			expect(await readFile(join(fixture.codexHome, "config.toml"), "utf8")).toBe(config);
		} finally {
			fixture.cleanup();
		}
	},
);

test("local connect requires no login and removes legacy inline credentials", async () => {
	const fixture = await lifecycleFixture("local");
	try {
		await fixture.registry.remove("codex");
		expect(await fixture.run(["connect", "codex", "--url", fixture.server.url.origin])).toBe(0);
		const entry = (await fixture.registry.read()).codex;
		expect(entry?.keyId).toBeUndefined();
		expect(entry?.keyFile).toBeUndefined();
		expect(await readFile(join(fixture.codexHome, "config.toml"), "utf8")).not.toContain(fixture.previousSecret);
	} finally {
		fixture.cleanup();
	}
});

test("connector list reports server last-use metadata without exposing credentials", async () => {
	const fixture = await lifecycleFixture();
	const lines: string[] = [];
	const log = console.log;
	console.log = (...values: unknown[]) => {
		lines.push(values.map(String).join(" "));
	};
	try {
		expect(await fixture.run(["connector", "list", "--json"])).toBe(0);
		expect(JSON.parse(lines.join(""))).toEqual([
			expect.objectContaining({
				harness: "codex",
				url: fixture.server.url.origin,
				agentId: "alice",
				keyId: "previous",
				status: "expiring",
				lastUsedAt: fixture.metadata.last_used_at,
				expiresAt: fixture.metadata.expires_at,
				metadataStatus: "available",
			}),
		]);
		expect(lines.join("")).not.toContain(fixture.previousSecret);
	} finally {
		console.log = log;
		fixture.cleanup();
	}
});

test("connector doctor reports unsafe key files, retained evidence and unassigned legacy keys", async () => {
	const fixture = await lifecycleFixture();
	const lines: string[] = [];
	const log = console.log;
	console.log = (...values: unknown[]) => {
		lines.push(values.map(String).join(" "));
	};
	try {
		await new DurableOutbox(fixture.server.url.origin, { env: fixture.env, harness: "codex" }).enqueue({
			method: "POST",
			path: "/api/hooks/session-end",
			body: { sessionKey: "retained", transcript: "evidence" },
		});
		await chmod(fixture.keyFile, 0o644);
		expect(await fixture.run(["connector", "doctor", "--json"])).toBe(1);
		const report = JSON.parse(lines.join(""));
		expect(report.connectors).toEqual([
			expect.objectContaining({ harness: "codex", healthy: false, outbox: expect.objectContaining({ pending: 1 }) }),
		]);
		expect(report.inlineKeys).toContainEqual(
			expect.objectContaining({ harness: "codex", inlineKeyFiles: [join(fixture.codexHome, "config.toml")] }),
		);
		expect(report.legacyKeys).toEqual({ status: "checked", unassigned: 1 });
		expect(lines.join("")).not.toContain(fixture.previousSecret);
	} finally {
		console.log = log;
		fixture.cleanup();
	}
});
