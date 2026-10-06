import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installDashboardDomGlobals } from "@/test/dom-globals";

type Reply = { readonly status: number; readonly body: unknown; readonly headers?: Record<string, string> };
type Handler = (path: string, init: RequestInit | undefined) => Reply;

if (!process.env.SIGNET_SESSION_TEST_CHILD) {
	test("dashboard session fixture", () => {
		const result = spawnSync(process.execPath, ["test", import.meta.filename], {
			env: { ...process.env, SIGNET_SESSION_TEST_CHILD: "1" },
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
	}, 25_000);
} else {
	let restore = () => {};
	const originalFetch = globalThis.fetch;
	const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
	let handler: Handler = () => ({ status: 500, body: null });
	let session: typeof import("./session");

	const whoami = (body: Record<string, unknown>): Reply => ({
		status: 200,
		body: {
			mode: "team",
			providers: [{ id: "password", type: "password", enabled: true, username: "owner" }],
			...body,
		},
	});
	const signedIn = whoami({
		authenticated: true,
		effectiveAccess: true,
		permissions: ["remember", "recall"],
		claims: {
			sub: "api-key:k1",
			name: "alice-laptop",
			role: "agent",
			scope: {},
			iat: 1,
			exp: Math.floor(Date.now() / 1000) + 600,
		},
	});
	const header = (init: RequestInit | undefined, name: string): string | null => new Headers(init?.headers).get(name);

	beforeAll(async () => {
		restore = installDashboardDomGlobals(
			new Window({ url: "http://127.0.0.1:3860/#signet-handoff=code-1&view=graph" }),
		);
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = String(input);
			calls.push({ path, init });
			const reply = handler(path, init);
			return new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
		}) as typeof fetch;
		session = await import("./session");
	});
	afterAll(() => {
		globalThis.fetch = originalFetch;
		restore();
	});

	describe("dashboard session", () => {
		test("redeems a CLI handoff code and removes it from the URL", async () => {
			handler = (path) =>
				path === "/api/auth/handoff/redeem" ? { status: 200, body: { token: "session-1" } } : signedIn;
			await session.startSession();
			expect(location.hash).toBe("#view=graph");
			expect(localStorage.getItem(session.TOKEN_KEY)).toBe("session-1");
			const redeem = calls.find((call) => call.path === "/api/auth/handoff/redeem");
			expect(JSON.parse(String(redeem?.init?.body))).toEqual({ code: "code-1" });
			expect(session.currentSession().kind).toBe("signed-in");
		});

		test("redeems a handoff opened in a tab that already shows the dashboard", async () => {
			handler = (path) =>
				path === "/api/auth/handoff/redeem" ? { status: 200, body: { token: "session-3" } } : signedIn;
			location.hash = "#signet-handoff=code-2";
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(location.hash).toBe("");
			expect(localStorage.getItem(session.TOKEN_KEY)).toBe("session-3");
		});

		test("a 401 mid-session ends the session in place and drops the dead token", async () => {
			handler = () => whoami({ authenticated: false, effectiveAccess: false, error: "token expired" });
			session.noteUnauthorized();
			await session.refreshSession();
			const state = session.currentSession();
			expect(state.kind).toBe("signed-out");
			if (state.kind !== "signed-out") return;
			expect(state.expired).toBe(true);
			expect(state.reason).toBe("Your session expired. Sign in again.");
			expect(localStorage.getItem(session.TOKEN_KEY)).toBeNull();
		});

		test("signing out returns to the first-run sign-in screen", async () => {
			handler = () => whoami({ authenticated: false, effectiveAccess: false, error: null });
			await session.signOut();
			const state = session.currentSession();
			expect(state.kind === "signed-out" && !state.expired && state.reason === null).toBe(true);
		});

		test("an API key is exchanged for a session token; the key is never stored", async () => {
			calls.length = 0;
			handler = (path) => (path === "/api/auth/session" ? { status: 200, body: { token: "session-2" } } : signedIn);
			const result = await session.signInWithKey("  sig_sk_k1_secret  ");
			expect(result.ok).toBe(true);
			const exchange = calls.find((call) => call.path === "/api/auth/session");
			expect(header(exchange?.init, "Authorization")).toBe("Bearer sig_sk_k1_secret");
			expect(localStorage.getItem(session.TOKEN_KEY)).toBe("session-2");
			expect(session.authHeaders()).toEqual({ Authorization: "Bearer session-2" });
		});

		test("password failures are distinguishable", async () => {
			handler = () => ({ status: 401, body: { error: "invalid username or password" } });
			expect(await session.signInWithPassword("owner", "nope")).toEqual({
				ok: false,
				error: "Wrong username or password.",
			});
			handler = () => ({ status: 429, body: { error: "rate limit exceeded" }, headers: { "Retry-After": "42" } });
			expect(await session.signInWithPassword("owner", "nope")).toEqual({
				ok: false,
				error: "Too many attempts. Try again in 42s.",
				retryAfter: 42,
			});
			handler = () => ({ status: 503, body: { error: "password login is not configured" } });
			expect(await session.signInWithPassword("owner", "nope")).toEqual({
				ok: false,
				error: "Password sign-in is not configured on this daemon.",
			});
		});

		test("a revoked key reports why", async () => {
			handler = () => ({ status: 401, body: { error: "api key revoked" } });
			expect(await session.signInWithKey("sig_sk_k1_secret")).toEqual({
				ok: false,
				error: "This API key was revoked.",
			});
		});

		test("exposes the daemon's effective permissions and the credential's name", async () => {
			localStorage.setItem(session.TOKEN_KEY, "session-perms");
			handler = () => signedIn;
			await session.refreshSession();
			const state = session.currentSession();
			expect(state.kind === "signed-in" && state.identity.name).toBe("alice-laptop");
			expect(session.can(state, "recall")).toBe(true);
			expect(session.can(state, "admin")).toBe(false);
		});

		test("a daemon that does not report permissions is not gated", async () => {
			handler = () =>
				whoami({
					authenticated: true,
					effectiveAccess: true,
					claims: { sub: "token:old", role: "agent", scope: {}, iat: 1, exp: Math.floor(Date.now() / 1000) + 600 },
				});
			await session.refreshSession();
			expect(session.can(session.currentSession(), "admin")).toBe(true);
		});

		test("flags a session that ends within five minutes", async () => {
			handler = () =>
				whoami({
					authenticated: true,
					effectiveAccess: true,
					permissions: ["recall"],
					claims: { sub: "api-key:k1", role: "agent", scope: {}, iat: 1, exp: Math.floor(Date.now() / 1000) + 120 },
				});
			await session.refreshSession();
			const state = session.currentSession();
			expect(state.kind === "signed-in" && state.expiresSoon).toBe(true);
		});

		test("renewal opens sign-in without dropping the session, and can be cancelled", async () => {
			handler = (path) =>
				path === "/api/auth/methods"
					? { status: 200, body: { mode: "team", providers: [{ id: "password", type: "password", enabled: true }] } }
					: signedIn;
			await session.refreshSession();
			session.requestRenewal();
			await new Promise((resolve) => setTimeout(resolve, 20));
			const state = session.currentSession();
			expect(state.kind === "signed-out" && state.renewal && state.expired).toBe(true);
			expect(localStorage.getItem(session.TOKEN_KEY)).toBe("session-perms");
			await session.cancelRenewal();
			expect(session.currentSession().kind).toBe("signed-in");
		});

		test("reports the rate-limit wait so the form can count down", async () => {
			handler = () => ({ status: 429, body: { error: "rate limit exceeded" }, headers: { "Retry-After": "7" } });
			const result = await session.signInWithPassword("owner", "nope");
			expect(result.ok === false && result.retryAfter).toBe(7);
		});

		test("local mode needs no sign-in", async () => {
			handler = () => ({ status: 200, body: { mode: "local", authenticated: false, effectiveAccess: true } });
			await session.refreshSession();
			expect(session.currentSession()).toEqual({ kind: "open", mode: "local", permissions: null });
		});

		test("a browser clock ahead of the daemon does not spin the expiry timer", async () => {
			localStorage.setItem(session.TOKEN_KEY, "session-skewed");
			const past = whoami({
				authenticated: true,
				effectiveAccess: true,
				claims: { sub: "api-key:k1", role: "agent", scope: {}, iat: 1, exp: Math.floor(Date.now() / 1000) - 30 },
			});
			handler = () => past;
			calls.length = 0;
			await session.refreshSession();
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(calls.filter((call) => call.path === "/api/auth/whoami").length).toBeLessThanOrEqual(2);
			handler = () => whoami({ authenticated: false, effectiveAccess: false, error: null });
			await session.signOut();
		});

		test("follows a sign-in from another tab", async () => {
			handler = () => signedIn;
			localStorage.setItem(session.TOKEN_KEY, "session-other-tab");
			expect(session.currentSession().kind).toBe("signed-out");
			window.dispatchEvent(new window.StorageEvent("storage", { key: session.TOKEN_KEY }));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(session.currentSession().kind).toBe("signed-in");
		});

		test("a token written during a check is checked instead of being discarded", async () => {
			localStorage.setItem(session.TOKEN_KEY, "session-old");
			handler = (_path, init) => {
				if (header(init, "Authorization") === "Bearer session-new") return signedIn;
				localStorage.setItem(session.TOKEN_KEY, "session-new");
				return whoami({ authenticated: false, effectiveAccess: false, error: "token expired" });
			};
			await session.refreshSession();
			expect(localStorage.getItem(session.TOKEN_KEY)).toBe("session-new");
			expect(session.currentSession().kind).toBe("signed-in");
		});

		test("an unreachable daemon is not mistaken for signed out", async () => {
			globalThis.fetch = (async () => {
				throw new TypeError("connection refused");
			}) as unknown as typeof fetch;
			await session.refreshSession();
			expect(session.currentSession().kind).toBe("unreachable");
			expect(session.can(session.currentSession(), "admin")).toBe(true);
		});
	});
}
