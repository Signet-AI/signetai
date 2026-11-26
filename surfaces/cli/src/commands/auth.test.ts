import "../../../../tests/support/connector-safety.js";
import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LoginStore } from "../../../../libs/sdk/src/node.js";
import { registerAuthCommands } from "./auth.js";

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

for (const all of [false, true]) {
	test(`offline logout clears local credentials and reports unconfirmed revocation; all=${all}`, async () => {
		const home = await mkdtemp(join(tmpdir(), "signet-logout-offline-"));
		homes.push(home);
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
		const url = server.url.origin;
		server.stop(true);
		const env = { HOME: home };
		const keyring = {
			get: async () => ({ state: "unsupported" as const }),
			set: async () => ({ state: "unsupported" as const }),
		};
		const store = new LoginStore(url, { env, keyring });
		await store.save({
			accessToken: "fixture-access",
			refreshToken: "fixture-refresh",
			accessExpiresAt: new Date(Date.now() + 60000).toISOString(),
			refreshExpiresAt: new Date(Date.now() + 120000).toISOString(),
		});
		const output: string[] = [];
		const program = new Command();
		registerAuthCommands(program, { env, keyring, flagUrl: url, print: (value) => output.push(value) });
		process.exitCode = 0;
		try {
			await program.parseAsync(["logout", "--json", ...(all ? ["--all"] : [])], { from: "user" });
			expect(await store.load()).toBeNull();
			expect(JSON.parse(output[0] ?? "null")).toMatchObject({ authenticated: false, revocationConfirmed: false });
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = 0;
		}
	});
}

for (const fixture of [
	{ name: "foreign approval origin", code: "ABCD-EFGH", foreign: true },
	{ name: "lowercase code", code: "abcd-efgh", foreign: false },
	{ name: "terminal controls", code: "ABCD\u001b[31m", foreign: false },
	{ name: "unbounded code", code: "A".repeat(65), foreign: false },
	{ name: "non-string code", code: 42, foreign: false },
]) {
	test(`device flow refuses ${fixture.name} before printing, opening or polling`, async () => {
		const home = await mkdtemp(join(tmpdir(), "signet-device-response-"));
		homes.push(home);
		let polls = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname.endsWith("/start"))
					return Response.json({
						deviceCode: "fixture-device",
						userCode: fixture.code,
						verificationUriComplete: fixture.foreign
							? "https://other.example/approve"
							: new URL("/approve", request.url).href,
						interval: 0,
						expiresIn: 1,
					});
				polls++;
				return Response.json({ reason: "invalid_credential" }, { status: 401 });
			},
		});
		const printed: string[] = [];
		const opened: string[] = [];
		const program = new Command();
		registerAuthCommands(program, {
			env: { HOME: home },
			flagUrl: server.url.origin,
			print: (value) => printed.push(value),
			openBrowser: async (url) => {
				opened.push(url);
			},
		});
		process.exitCode = 0;
		try {
			await program.parseAsync(["login"], { from: "user" });
			expect(opened).toEqual([]);
			expect(printed).toEqual([]);
			expect(polls).toBe(0);
			expect(process.exitCode).toBe(1);
		} finally {
			server.stop(true);
			process.exitCode = 0;
		}
	});
}

test("device login stores credentials and logout revokes before clearing", async () => {
	const home = await mkdtemp(join(tmpdir(), "signet-auth-"));
	homes.push(home);
	const calls: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			calls.push(path);
			if (path.endsWith("/start"))
				return Response.json({
					deviceCode: "private-device-code",
					userCode: "ABCD-EFGH",
					verificationUriComplete: new URL("/approve", request.url).href,
					interval: 0,
					expiresIn: 10,
				});
			if (path.endsWith("/token"))
				return Response.json({
					accessToken: "private-access",
					refreshToken: "private-refresh",
					accessExpiresAt: new Date(Date.now() + 60000).toISOString(),
					refreshExpiresAt: new Date(Date.now() + 120000).toISOString(),
				});
			if (path.endsWith("/logout")) {
				expect(request.headers.get("authorization")).toBe("Bearer private-access");
				return Response.json({ ok: true });
			}
			return Response.json({ error: "unexpected" }, { status: 404 });
		},
	});
	const env = { HOME: home };
	const keyring = {
		get: async () => ({ state: "unsupported" as const }),
		set: async () => ({ state: "unsupported" as const }),
	};
	const output: string[] = [];
	let opened = "";
	const program = new Command();
	registerAuthCommands(program, {
		env,
		keyring,
		configUrl: server.url.origin,
		print: (value) => output.push(value),
		openBrowser: async (url) => {
			opened = url;
		},
	});
	try {
		await program.parseAsync(["login"], { from: "user" });
		const store = new LoginStore(server.url.origin, { env, keyring });
		expect((await store.load())?.credential.refreshToken).toBe("private-refresh");
		expect(opened).toBe(`${server.url.origin}/approve`);
		expect(output.join("\n")).toContain("ABCD-EFGH");
		expect(output.join("\n")).not.toContain("private-");
		await writeFile(`${store.path}.state`, JSON.stringify({ state: "dead", reason: "revoked" }), { mode: 0o600 });
		await program.parseAsync(["login"], { from: "user" });
		expect((await store.load())?.credential.refreshToken).toBe("private-refresh");
		await program.parseAsync(["logout"], { from: "user" });
		expect(await store.load()).toBeNull();
		expect(calls).toContain("/api/auth/logout");
	} finally {
		server.stop(true);
	}
});

for (const savedSession of [false, true]) {
	for (const all of [false, true]) {
		test(`logout is clean when the session is absent or expired; saved=${savedSession}; all=${all}`, async () => {
			const home = await mkdtemp(join(tmpdir(), "logout-expired-"));
			homes.push(home);
			let requests = 0;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch() {
					requests++;
					return Response.json({ reason: "revoked" }, { status: 401 });
				},
			});
			const keyring = {
				get: async () => ({ state: "unsupported" as const }),
				set: async () => ({ state: "unsupported" as const }),
			};
			const env = { HOME: home };
			const store = new LoginStore(server.url.origin, { env, keyring });
			if (savedSession)
				await store.save({
					accessToken: "expired-access",
					refreshToken: "expired-refresh",
					accessExpiresAt: new Date(Date.now() + 60000).toISOString(),
					refreshExpiresAt: new Date(Date.now() + 120000).toISOString(),
				});
			const printed: string[] = [];
			const program = new Command();
			registerAuthCommands(program, {
				env,
				keyring,
				flagUrl: server.url.origin,
				print: (value) => printed.push(value),
			});
			process.exitCode = 0;
			try {
				await program.parseAsync(["logout", "--json", ...(all ? ["--all"] : [])], { from: "user" });
				expect(process.exitCode).toBe(0);
				expect(await store.load()).toBeNull();
				expect(JSON.parse(printed[0] ?? "null")).toMatchObject({ authenticated: false, revocationConfirmed: false });
				expect(requests).toBe(savedSession ? 1 : 0);
			} finally {
				server.stop(true);
				process.exitCode = 0;
			}
		});
	}
}
