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
			const options = { configDir: root, keyring: disposableKeyring() };
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
