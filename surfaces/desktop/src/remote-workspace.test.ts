import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginStore, type LoginKeyring } from "@signet/sdk/node";
import { DesktopWorkspace, RemoteWorkspace, parseWorkspaceSelection } from "./remote-workspace.js";
import { parseDesktopDeepLink } from "./deep-link.js";

export function disposableKeyring(): LoginKeyring {
	let value: string | null = null;
	return {
		async get() {
			return value === null ? { state: "missing" } : { state: "found", value };
		},
		async set(next) {
			value = next;
			return { state: "found" };
		},
	};
}

const credential = {
	accessToken: "disposable-access",
	refreshToken: "disposable-refresh",
	accessExpiresAt: "2099-01-01T00:00:00Z",
	refreshExpiresAt: "2099-02-01T00:00:00Z",
};

describe("desktop remote workspace", () => {
	test("auth completion only focuses and rejects query and fragment secrets", () => {
		expect(parseDesktopDeepLink("signet://auth/complete")).toBe("auth-complete");
		for (const link of [
			"signet://auth/complete?token=secret",
			"signet://auth/complete?code=secret",
			"signet://auth/complete#secret",
			"signet://user@auth/complete",
			"signet://auth/complete/extra",
		])
			expect(parseDesktopDeepLink(link)).toBeNull();
	});

	test("accepts only secret-free HTTPS origins or loopback HTTP", () => {
		expect(parseWorkspaceSelection({ mode: "local" })).toEqual({ mode: "local" });
		expect(parseWorkspaceSelection({ mode: "organization", origin: "https://org.example/" })).toEqual({
			mode: "organization",
			origin: "https://org.example",
		});
		for (const origin of [
			"http://org.example",
			"https://user:secret@org.example",
			"https://org.example?token=secret",
			"https://org.example/path",
			"file:///secret",
		])
			expect(() => parseWorkspaceSelection({ mode: "organization", origin })).toThrow();
	});

	test("remote preparation and local commands cannot start a local daemon", async () => {
		let started = 0;
		const local = {
			async ensureStarted() {
				started++;
			},
		};
		const remote = new DesktopWorkspace({ mode: "organization", origin: "https://org.example" }, local);
		await remote.prepare();
		expect(() => remote.assertLocal()).toThrow("Local daemon controls are unavailable");
		expect(started).toBe(0);
		const personal = new DesktopWorkspace({ mode: "local" }, local);
		await personal.prepare();
		personal.assertLocal();
		expect(started).toBe(1);
	});

	test("proxy rejects encoded credential endpoints and preserves forbidden requirements", async () => {
		const root = await mkdtemp(join(tmpdir(), "desktop-status-"));
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname.includes("%")) return Response.json({ accessToken: "must-not-escape" });
				return Response.json(
					{ error: "Forbidden", reason: "permission", required: "Requires the operator role" },
					{ status: 403 },
				);
			},
		});
		try {
			const login = new LoginStore(server.url.origin, {
				env: { HOME: root, APPDATA: root },
				keyring: disposableKeyring(),
			});
			await login.save(credential);
			const desktop = new RemoteWorkspace(server.url.origin, { login, openExternal: async () => {} });
			expect((await desktop.proxy(new Request("app://signet/api/auth/%72efresh", { method: "POST" }))).status).toBe(
				403,
			);
			const forbidden = await desktop.proxy(new Request("app://signet/api/memories"));
			expect(forbidden.status).toBe(403);
			expect(await forbidden.json()).toMatchObject({ required: "Requires the operator role" });
			expect(await desktop.sessionStatus()).toMatchObject({
				state: "forbidden",
				message: "Requires the operator role",
			});
			server.stop(true);
			expect(await desktop.sessionStatus()).toMatchObject({ state: "unreachable" });
		} finally {
			server.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	});

	test("device polling preserves a pending authorization across instance outages", async () => {
		const root = await mkdtemp(join(tmpdir(), "desktop-device-outage-"));
		let tokenStatus = 503;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/api/auth/device/start")
					return Response.json({
						deviceCode: "disposable-device",
						userCode: "ABCD-EFGH",
						verificationUriComplete: `${new URL(request.url).origin}/auth/device?user_code=ABCD-EFGH`,
					});
				return Response.json(
					{ reason: tokenStatus === 503 ? "unavailable" : "authorization_pending" },
					{ status: tokenStatus },
				);
			},
		});
		try {
			const login = new LoginStore(server.url.origin, {
				env: { HOME: root, APPDATA: root },
				keyring: disposableKeyring(),
			});
			const desktop = new RemoteWorkspace(server.url.origin, { login, openExternal: async () => {} });
			await desktop.signIn();
			await Bun.sleep(2050);
			expect(await desktop.pollSignIn()).toMatchObject({ state: "unreachable" });
			tokenStatus = 428;
			await Bun.sleep(2050);
			expect(await desktop.pollSignIn()).toMatchObject({ state: "pending" });
		} finally {
			server.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	}, 10_000);

	test("HTTP failures stay honest and offline logout retains retryable shared credentials", async () => {
		const root = await mkdtemp(join(tmpdir(), "desktop-failures-"));
		let status = 503;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return new Response("Instance proxy failure", { status });
			},
		});
		try {
			const login = new LoginStore(server.url.origin, {
				env: { HOME: root, APPDATA: root },
				keyring: disposableKeyring(),
			});
			await login.save(credential);
			const desktop = new RemoteWorkspace(server.url.origin, { login, openExternal: async () => {} });
			expect(await desktop.sessionStatus()).toMatchObject({ state: "unreachable" });
			status = 403;
			expect(await desktop.sessionStatus()).toMatchObject({ state: "forbidden" });
			status = 401;
			expect(await desktop.sessionStatus()).toMatchObject({ state: "expired" });
			server.stop(true);
			await expect(desktop.signOut()).rejects.toThrow();
			expect((await login.load())?.credential).toEqual(credential);
		} finally {
			server.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	});

	test("organization account metadata routes remain main-authenticated", async () => {
		const root = await mkdtemp(join(tmpdir(), "desktop-account-proxy-"));
		let authenticated = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (request.headers.get("authorization") === `Bearer ${credential.accessToken}`) authenticated++;
				return Response.json({ ok: true });
			},
		});
		try {
			const login = new LoginStore(server.url.origin, {
				env: { HOME: root, APPDATA: root },
				keyring: disposableKeyring(),
			});
			await login.save(credential);
			const desktop = new RemoteWorkspace(server.url.origin, { login, openExternal: async () => {} });
			for (const [method, path] of [
				["GET", "/api/auth/profile"],
				["PATCH", "/api/auth/profile"],
				["PATCH", "/api/auth/preferences"],
				["GET", "/api/auth/connector-keys/test-key/errors"],
			]) {
				expect((await desktop.proxy(new Request(`app://signet${path}`, { method }))).status).toBe(200);
			}
			expect(authenticated).toBe(4);
		} finally {
			server.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	});

	test("expired or revoked sessions remain distinguishable and can be signed out", async () => {
		const root = await mkdtemp(join(tmpdir(), "desktop-expired-"));
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return Response.json({ authenticated: false, mode: "team" });
			},
		});
		try {
			const login = new LoginStore(server.url.origin, {
				env: { HOME: root, APPDATA: root },
				keyring: disposableKeyring(),
			});
			await login.save(credential);
			const desktop = new RemoteWorkspace(server.url.origin, { login, openExternal: async () => {} });
			expect(await desktop.sessionStatus()).toMatchObject({ state: "expired" });
			await login.save({
				...credential,
				accessExpiresAt: "2000-01-01T00:00:00Z",
				refreshExpiresAt: "2000-02-01T00:00:00Z",
			});
			expect(await desktop.signOut()).toMatchObject({ state: "signed-out" });
			expect(await login.load()).toBeNull();
		} finally {
			server.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	});

	test("dashboard logout revokes through the owner and clears the CLI login", async () => {
		const root = await mkdtemp(join(tmpdir(), "desktop-logout-"));
		let revoked = false;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname !== "/api/auth/logout") return new Response(null, { status: 404 });
				revoked =
					request.headers.get("authorization") === `Bearer ${credential.accessToken}` &&
					(await request.text()) === JSON.stringify({ all: true });
				return Response.json({ ok: true });
			},
		});
		try {
			const options = { env: { HOME: root, APPDATA: root }, keyring: disposableKeyring() };
			const cli = new LoginStore(server.url.origin, options);
			await cli.save(credential);
			const desktop = new RemoteWorkspace(server.url.origin, {
				login: new LoginStore(server.url.origin, options),
				openExternal: async () => {},
			});
			expect(
				(
					await desktop.proxy(
						new Request("app://signet/api/auth/logout", { method: "POST", body: JSON.stringify({ all: true }) }),
					)
				).status,
			).toBe(200);
			expect(revoked).toBe(true);
			expect(await cli.load()).toBeNull();
		} finally {
			server.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	});

	test("CLI and desktop share the same credential and proxy hides tokens", async () => {
		const root = await mkdtemp(join(tmpdir(), "desktop-login-"));
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				return Response.json(
					{
						authorization: request.headers.get("authorization"),
						cookie: request.headers.get("cookie"),
						actor: request.headers.get("x-signet-actor"),
					},
					{ headers: { "set-cookie": "signet_session=secret" } },
				);
			},
		});
		try {
			const origin = server.url.origin;
			const options = { env: { HOME: root, APPDATA: root }, keyring: disposableKeyring() };
			const cli = new LoginStore(origin, options);
			const desktop = new RemoteWorkspace(origin, {
				login: new LoginStore(origin, options),
				openExternal: async () => {},
			});
			await cli.save(credential);
			const proxied = await desktop.proxy(
				new Request("app://signet/api/memories", {
					headers: { authorization: "forged", cookie: "forged", "x-signet-actor": "forged" },
				}),
			);
			expect(await proxied.json()).toEqual({
				authorization: `Bearer ${credential.accessToken}`,
				cookie: null,
				actor: null,
			});
			expect(proxied.headers.has("set-cookie")).toBe(false);
			for (const path of [
				"/api/auth/device/token",
				"/api/auth/refresh",
				"/api/auth/login",
				"/api/org/claim",
				"/api/auth/invites/accept",
			])
				expect((await desktop.proxy(new Request(`app://signet${path}`, { method: "POST" }))).status).toBe(403);
			await cli.clear();
			expect((await desktop.proxy(new Request("app://signet/api/memories"))).status).toBe(401);
			await desktop.login.save(credential);
			expect((await cli.load())?.credential).toEqual(credential);
		} finally {
			server.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	});
});
