import "../../../../tests/support/connector-safety.js";
import { afterEach, expect, test, spyOn } from "bun:test";
import { CodexConnector } from "@signet/connector-codex";
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
	const revocations: {
		fail: boolean;
		hide: boolean;
		observations: {
			keyId: string;
			activeKeyId?: string;
			keyFileExists: boolean;
			replacement: boolean;
			proxy: boolean;
		}[];
	} = { fail: false, hide: false, observations: [] };
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
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path.startsWith("/api/auth/connector-keys/") && request.method === "DELETE") {
				const active = (await registry.read()).codex;
				const config = await readFile(join(codexHome, "config.toml"), "utf8").catch(() => "");
				revocations.observations.push({
					keyId: path.split("/").at(-1) ?? "",
					activeKeyId: active?.keyId,
					keyFileExists: await Bun.file(keyFile).exists(),
					replacement: active?.keyFile ? (await readKeyFile(active.keyFile)) === secret : false,
					proxy: config.includes("connector"),
				});
				if (revocations.fail) return Response.json({ error: "fixture revoke failure" }, { status: 500 });
				if (path.endsWith("/previous")) revoked = true;
				return Response.json({ reason: "not_found" }, { status: 404 });
			}
			if (path === "/api/auth/connector-keys" && request.method === "GET")
				return Response.json({
					keys: revocations.hide ? [] : [{ ...metadata, revoked_at: revoked ? "2026-11-25T12:01:00.000Z" : null }],
				});
			if (path === "/api/org/keys") return Response.json({ keys: [{ user_id: null }] });
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
		revocations,
		async run(args: string[]) {
			process.exitCode = 0;
			const program = new Command().exitOverride();
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
	"%s retains honest recovery metadata when the server is unreachable",
	async (operation) => {
		const fixture = await lifecycleFixture();
		try {
			const before = await fixture.registry.read();
			const config = await readFile(join(fixture.codexHome, "config.toml"), "utf8");
			fixture.server.stop(true);
			const args = operation === "rotate" ? ["connector", "rotate", "codex"] : ["disconnect", "codex"];
			expect(await fixture.run(args)).toBe(1);
			if (operation === "rotate") {
				expect(await fixture.registry.read()).toEqual(before);
				expect(await readKeyFile(fixture.keyFile)).toBe(fixture.previousSecret);
				expect(await readFile(join(fixture.codexHome, "config.toml"), "utf8")).toBe(config);
			} else {
				expect((await fixture.registry.read()).codex).toBeUndefined();
				expect(await Bun.file(fixture.keyFile).exists()).toBe(false);
				expect(
					JSON.parse(await readFile(join(fixture.home, ".config", "signet", "pending-revokes.json"), "utf8")),
				).toEqual([{ harness: "codex", url: fixture.server.url.origin, keyId: "previous" }]);
			}
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

test.each([undefined, "alice"])(
	"Hermes profile selection does not infer an agent identity; explicit=%s",
	async (agent) => {
		const fixture = await lifecycleFixture("local");
		try {
			expect(
				await fixture.run(["connect", "hermes-agent", "--profile", "work", ...(agent ? ["--agent", agent] : [])]),
			).toBe(0);
			const entry = Object.entries(await fixture.registry.read()).find(([name]) =>
				name.startsWith("hermes-agent."),
			)?.[1];
			expect(entry).toBeDefined();
			expect(entry?.agentId).toBe(agent);
		} finally {
			fixture.cleanup();
		}
	},
);

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

test("rotation revokes only after the replacement integration and credential are live", async () => {
	const f = await lifecycleFixture();
	try {
		expect(await f.run(["connector", "rotate", "codex"])).toBe(0);
		expect(f.revocations.observations).toEqual([
			{ keyId: "previous", activeKeyId: "replacement", keyFileExists: true, replacement: true, proxy: true },
		]);
	} finally {
		f.cleanup();
	}
});

test("disconnect removes integration and local credentials before revoking", async () => {
	const f = await lifecycleFixture();
	try {
		expect(await f.run(["disconnect", "codex"])).toBe(0);
		expect(f.revocations.observations).toEqual([
			{ keyId: "previous", activeKeyId: undefined, keyFileExists: false, replacement: false, proxy: false },
		]);
	} finally {
		f.cleanup();
	}
});

test("failed install restores the previous config, registry, and key", async () => {
	const f = await lifecycleFixture();
	const configPath = join(f.codexHome, "config.toml");
	const before = await readFile(configPath, "utf8");
	const install = spyOn(CodexConnector.prototype, "install").mockImplementation(async () => {
		await writeFile(configPath, "failed installation");
		return { success: false, message: "fixture install failure", filesWritten: [configPath] };
	});
	try {
		expect(await f.run(["connector", "rotate", "codex"])).toBe(1);
		expect((await f.registry.read()).codex?.keyId).toBe("previous");
		expect(await readKeyFile(f.keyFile)).toBe(f.previousSecret);
		expect(await readFile(configPath, "utf8")).toBe(before);
		expect(f.revocations.observations.map((item) => item.keyId)).toEqual(["replacement"]);
	} finally {
		install.mockRestore();
		f.cleanup();
	}
});

test.each(["rotate", "disconnect"])("%s persists failed revocation for doctor retry", async (operation) => {
	const f = await lifecycleFixture();
	const log = console.log;
	const lines: string[] = [];
	console.log = (...values: unknown[]) => {
		lines.push(values.map(String).join(" "));
	};
	try {
		f.revocations.fail = true;
		expect(await f.run(operation === "rotate" ? ["connector", "rotate", "codex"] : ["disconnect", "codex"])).toBe(1);
		expect((await f.registry.read()).codex?.keyId).toBe(operation === "rotate" ? "replacement" : undefined);
		const path = join(f.home, ".config", "signet", "pending-revokes.json");
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual([
			{ harness: "codex", url: f.server.url.origin, keyId: "previous" },
		]);
		await f.run(["connector", "doctor", "--json"]);
		expect(lines.join("\n")).toContain("pendingRevokes");
		f.revocations.fail = false;
		await f.run(["connector", "doctor", "--json"]);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual([]);
		expect(lines.join("\n")).not.toContain(f.secret);
	} finally {
		console.log = log;
		f.cleanup();
	}
});

test("disconnect preserves a real Codex skills directory", async () => {
	const f = await lifecycleFixture();
	try {
		const path = join(f.codexHome, "skills", "user-skill");
		await mkdir(path, { recursive: true });
		await writeFile(join(path, "SKILL.md"), "user-owned skill");
		expect(await f.run(["disconnect", "codex"])).toBe(0);
		expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("user-owned skill");
	} finally {
		f.cleanup();
	}
});

test.each([false, true])("disconnect explicitly retains or purges only its outbox: purge=%s", async (purge) => {
	const f = await lifecycleFixture();
	const outbox = new DurableOutbox(f.server.url.origin, { env: f.env, harness: "codex" });
	const other = new DurableOutbox(f.server.url.origin, { env: f.env, harness: "pi" });
	const lines: string[] = [];
	const log = console.log;
	console.log = (...values: unknown[]) => {
		lines.push(values.map(String).join(" "));
	};
	try {
		const poison = await outbox.enqueue({
			method: "POST",
			path: "/api/hooks/session-end",
			body: { transcript: "quarantined evidence" },
		});
		await writeFile(join(outbox.directory, `${poison.id}.json`), JSON.stringify({ ...poison, attempts: 20 }));
		for (const box of [outbox, other])
			await box.enqueue({ method: "POST", path: "/api/hooks/session-end", body: { transcript: "retained evidence" } });
		await outbox.flush(
			async () => {
				throw Object.assign(new Error("fixture"), { status: 401 });
			},
			{ force: true },
		);
		expect((await outbox.status()).pending).toBe(1);
		expect((await outbox.status()).quarantined).toBe(1);
		expect(await f.run(["disconnect", "codex", ...(purge ? ["--purge-outbox"] : []), "--json"])).toBe(0);
		expect((await outbox.status()).pending).toBe(purge ? 0 : 1);
		expect((await outbox.status()).quarantined).toBe(purge ? 0 : 1);
		expect((await other.status()).pending).toBe(1);
		expect(JSON.parse(lines.at(-1) ?? "{}").outbox).toBe(purge ? "purged" : "retained");
		if (!purge) expect(JSON.parse(lines.at(-1) ?? "{}").message).toContain("kept");
	} finally {
		console.log = log;
		f.cleanup();
	}
});

test("a retained outbox can be purged after disconnect using its explicit origin", async () => {
	const f = await lifecycleFixture();
	try {
		const outbox = new DurableOutbox(f.server.url.origin, { env: f.env, harness: "codex" });
		await outbox.enqueue({ method: "POST", path: "/api/hooks/session-end", body: { transcript: "evidence" } });
		expect(await f.run(["disconnect", "codex"])).toBe(0);
		expect((await outbox.status()).pending).toBe(1);
		expect(await f.run(["disconnect", "codex", "--url", f.server.url.origin, "--purge-outbox"])).toBe(0);
		expect((await outbox.status()).pending).toBe(0);
	} finally {
		f.cleanup();
	}
});

test("failed installation restores evidence behind a home-relative workspace path", async () => {
	const f = await lifecycleFixture();
	const home = process.env.HOME;
	if (!home || home === "/home/nicholai") throw new Error("A disposable HOME is required");
	const workspace = join(home, "rollback-home-workspace");
	await mkdir(workspace, { recursive: true });
	const source = join(workspace, "AGENTS.md");
	await writeFile(source, "original evidence");
	const install = spyOn(CodexConnector.prototype, "install").mockImplementation(async () => {
		await writeFile(source, "partial install");
		return { success: false, message: "fixture failure", filesWritten: [source] };
	});
	try {
		expect(await f.run(["connector", "rotate", "codex", "--path", "~/rollback-home-workspace"])).toBe(1);
		expect(await readFile(source, "utf8")).toBe("original evidence");
	} finally {
		install.mockRestore();
		await rm(workspace, { recursive: true, force: true });
		f.cleanup();
	}
});

test("an ambiguous missing key is pending rather than falsely confirmed revoked", async () => {
	const f = await lifecycleFixture();
	try {
		f.revocations.hide = true;
		expect(await f.run(["disconnect", "codex"])).toBe(1);
		expect((await f.registry.read()).codex).toBeUndefined();
		const pending = join(f.home, ".config", "signet", "pending-revokes.json");
		expect(JSON.parse(await readFile(pending, "utf8"))).toEqual([
			{ harness: "codex", url: f.server.url.origin, keyId: "previous" },
		]);
		f.revocations.hide = false;
		await f.run(["connector", "doctor", "--json"]);
		expect(JSON.parse(await readFile(pending, "utf8"))).toEqual([]);
	} finally {
		f.cleanup();
	}
});
