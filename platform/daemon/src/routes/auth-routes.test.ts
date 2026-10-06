import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { checkPermission, createAuthMiddleware, verifyToken } from "../auth";
import type { AuthResult, TokenClaims } from "../auth";

const KEY = "sig_sk_narrow_secretvalue";
const KEY_EXP = Math.floor(Date.now() / 1000) + 120;
const KEY_CLAIMS: TokenClaims = {
	sub: "api-key:k1",
	name: "alice-laptop",
	role: "agent",
	scope: { agent: "alice" },
	permissions: ["recall"],
	iat: Math.floor(Date.now() / 1000) - 10,
	exp: KEY_EXP,
};

function verifyKey(token: string): AuthResult {
	if (token === KEY) return { authenticated: true, claims: KEY_CLAIMS };
	return { authenticated: false, claims: null, error: "invalid api key" };
}

let dir = "";
let state: typeof import("./state.js");
let app: Hono;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "signet-auth-routes-test-"));
	mkdirSync(join(dir, ".daemon"), { recursive: true });
	writeFileSync(join(dir, "agent.yaml"), "auth:\n  mode: team\n  sessionTokenTtlSeconds: 3600\n");
	state = await import("./state.js");
	state.reloadAuthState(dir);
	if (!state.authSecret) throw new Error("expected auth secret");
	const { registerAuthRoutes } = await import("./auth-routes.js");
	app = new Hono();
	app.use("*", createAuthMiddleware(state.authConfig, state.authSecret, verifyKey));
	registerAuthRoutes(app);
});

afterEach(() => {
	state.reloadAuthState(state.AGENTS_DIR);
	rmSync(dir, { recursive: true, force: true });
});

function bearer(token: string): { authorization: string } {
	return { authorization: `Bearer ${token}` };
}

async function mint(): Promise<{ token: string; expiresAt: string }> {
	const res = await app.request("/api/auth/session", { method: "POST", headers: bearer(KEY) });
	expect(res.status).toBe(200);
	return (await res.json()) as { token: string; expiresAt: string };
}

describe("whoami", () => {
	test("reports an API key as authenticated with its claims", async () => {
		const res = await app.request("/api/auth/whoami", { headers: bearer(KEY) });
		const body = (await res.json()) as { authenticated: boolean; claims: TokenClaims | null };
		expect(body.authenticated).toBe(true);
		expect(body.claims?.sub).toBe("api-key:k1");
	});

	test("reports why a presented credential was rejected", async () => {
		const res = await app.request("/api/auth/whoami", { headers: bearer("sig_sk_bad_value") });
		const body = (await res.json()) as { authenticated: boolean; error: string | null };
		expect(body.authenticated).toBe(false);
		expect(body.error).toBe("invalid api key");
	});

	test("reports no error when no credential was presented", async () => {
		const res = await app.request("/api/auth/whoami");
		const body = (await res.json()) as { authenticated: boolean; error: string | null };
		expect(body.authenticated).toBe(false);
		expect(body.error).toBeNull();
	});
});

describe("session exchange", () => {
	test("mints a session with the presenting credential's claims and no later expiry", async () => {
		const { token } = await mint();
		if (!state.authSecret) throw new Error("expected auth secret");
		const verified = verifyToken(state.authSecret, token);
		expect(verified.authenticated).toBe(true);
		expect(verified.claims?.sub).toBe("api-key:k1");
		expect(verified.claims?.role).toBe("agent");
		expect(verified.claims?.scope).toEqual({ agent: "alice" });
		expect(verified.claims?.permissions).toEqual(["recall"]);
		expect(verified.claims?.exp).toBeLessThanOrEqual(KEY_EXP);
	});

	test("does not widen permissions beyond the presenting credential", async () => {
		const { token } = await mint();
		if (!state.authSecret) throw new Error("expected auth secret");
		const claims = verifyToken(state.authSecret, token).claims;
		expect(checkPermission(claims, "recall", "team").allowed).toBe(true);
		expect(checkPermission(claims, "remember", "team").allowed).toBe(false);
	});

	test("requires a credential", async () => {
		const res = await app.request("/api/auth/session", { method: "POST" });
		expect(res.status).toBe(401);
	});
});

describe("dashboard handoff", () => {
	async function handoff(): Promise<string> {
		const res = await app.request("/api/auth/handoff", { method: "POST", headers: bearer(KEY) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { code: string };
		return body.code;
	}

	function redeem(code: unknown): Promise<Response> {
		return Promise.resolve(
			app.request("/api/auth/handoff/redeem", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ code }),
			}),
		);
	}

	test("redeems once for a session carrying the issuer's claims", async () => {
		const code = await handoff();
		const first = await redeem(code);
		expect(first.status).toBe(200);
		const body = (await first.json()) as { token: string };
		const whoami = await app.request("/api/auth/whoami", { headers: bearer(body.token) });
		const identity = (await whoami.json()) as { claims: TokenClaims | null };
		expect(identity.claims?.sub).toBe("api-key:k1");
		expect(identity.claims?.permissions).toEqual(["recall"]);

		const second = await redeem(code);
		expect(second.status).toBe(401);
	});

	test("rejects unknown and malformed codes", async () => {
		expect((await redeem("not-a-real-code")).status).toBe(401);
		expect((await redeem(42)).status).toBe(400);
	});

	test("requires a credential to issue a code", async () => {
		const res = await app.request("/api/auth/handoff", { method: "POST" });
		expect(res.status).toBe(401);
	});
});

describe("effective permissions and display name", () => {
	test("whoami lists the permissions the daemon will grant this credential", async () => {
		const res = await app.request("/api/auth/whoami", { headers: bearer(KEY) });
		const body = (await res.json()) as { permissions: string[]; claims: TokenClaims | null };
		expect(body.permissions).toEqual(["recall"]);
		expect(body.claims?.name).toBe("alice-laptop");
	});

	test("whoami lists no permissions without a credential in team mode", async () => {
		const body = (await (await app.request("/api/auth/whoami")).json()) as { permissions: string[] };
		expect(body.permissions).toEqual([]);
	});

	test("an admin session from password sign-in carries every permission and the username", async () => {
		const prevUsername = process.env.SIGNET_ADMIN_USERNAME;
		const prevPassword = process.env.SIGNET_ADMIN_PASSWORD;
		process.env.SIGNET_ADMIN_USERNAME = "owner";
		process.env.SIGNET_ADMIN_PASSWORD = "secret-password";
		try {
			const login = await app.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "owner", password: "secret-password" }),
			});
			const { token } = (await login.json()) as { token: string };
			const body = (await (await app.request("/api/auth/whoami", { headers: bearer(token) })).json()) as {
				permissions: string[];
				claims: TokenClaims | null;
			};
			expect(body.claims?.name).toBe("owner");
			expect(body.permissions).toContain("admin");
			expect(body.permissions).toContain("diagnostics");
		} finally {
			if (prevUsername === undefined) Reflect.deleteProperty(process.env, "SIGNET_ADMIN_USERNAME");
			else process.env.SIGNET_ADMIN_USERNAME = prevUsername;
			if (prevPassword === undefined) Reflect.deleteProperty(process.env, "SIGNET_ADMIN_PASSWORD");
			else process.env.SIGNET_ADMIN_PASSWORD = prevPassword;
		}
	});

	test("a session keeps the credential's display name", async () => {
		const { token } = await mint();
		if (!state.authSecret) throw new Error("expected auth secret");
		expect(verifyToken(state.authSecret, token).claims?.name).toBe("alice-laptop");
	});
});

describe("open paths", () => {
	test("only whoami verifies API keys, and a verifier failure is not a 500", async () => {
		if (!state.authSecret) throw new Error("expected auth secret");
		let calls = 0;
		const { registerAuthRoutes } = await import("./auth-routes.js");
		const failing = new Hono();
		failing.use(
			"*",
			createAuthMiddleware(state.authConfig, state.authSecret, () => {
				calls += 1;
				throw new Error("database unavailable");
			}),
		);
		failing.get("/health", (c) => c.json({ ok: true }));
		failing.get("/api/mode", (c) => c.json({ mode: "team" }));
		registerAuthRoutes(failing);

		expect((await failing.request("/health", { headers: bearer(KEY) })).status).toBe(200);
		expect((await failing.request("/api/mode", { headers: bearer(KEY) })).status).toBe(200);
		expect(calls).toBe(0);

		const whoami = await failing.request("/api/auth/whoami", { headers: bearer(KEY) });
		expect(whoami.status).toBe(200);
		const body = (await whoami.json()) as { authenticated: boolean; error: string | null };
		expect(body.authenticated).toBe(false);
		expect(body.error).toBe("credential could not be verified");
		expect(calls).toBe(1);
	});
});

describe("handoff limits", () => {
	test("one credential cannot hold every pending handoff slot", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < 6; i += 1) {
			const res = await app.request("/api/auth/handoff", { method: "POST", headers: bearer(KEY) });
			statuses.push(res.status);
		}
		expect(statuses.filter((status) => status === 200).length).toBe(4);
		expect(statuses.slice(4)).toEqual([429, 429]);
	});
});

describe("admin routes", () => {
	test("each key-management request spends the admin rate limit once", async () => {
		if (!state.authSecret) throw new Error("expected auth secret");
		const { createToken } = await import("../auth");
		const admin = createToken(state.authSecret, { sub: "double-count-probe", scope: {}, role: "admin" }, 60);
		const statuses: number[] = [];
		for (let i = 0; i < 10; i += 1) {
			statuses.push((await app.request("/api/auth/api-keys", { headers: bearer(admin) })).status);
		}
		expect(statuses).not.toContain(429);
		expect((await app.request("/api/auth/api-keys", { headers: bearer(admin) })).status).toBe(429);
	});

	test("rejects an API key name that would bloat every session token", async () => {
		if (!state.authSecret) throw new Error("expected auth secret");
		const { createToken } = await import("../auth");
		const admin = createToken(state.authSecret, { sub: "name-limit-probe", scope: {}, role: "admin" }, 60);
		const res = await app.request("/api/auth/api-keys", {
			method: "POST",
			headers: { ...bearer(admin), "content-type": "application/json" },
			body: JSON.stringify({ name: "x".repeat(129) }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("name must be at most 128 characters");
	});

	test("a non-admin credential gets 403 from key management, not a server error", async () => {
		const res = await app.request("/api/auth/api-keys", { headers: bearer(KEY) });
		expect(res.status).toBe(403);
	});

	test("a tripped admin rate limit answers 429, not a server error", async () => {
		if (!state.authSecret) throw new Error("expected auth secret");
		const { createToken } = await import("../auth");
		const admin = createToken(state.authSecret, { sub: "rate-limit-probe", scope: {}, role: "admin" }, 60);
		const statuses: number[] = [];
		for (let i = 0; i < 12; i += 1) {
			const res = await app.request("/api/auth/token", {
				method: "POST",
				headers: { ...bearer(admin), "content-type": "application/json" },
				body: JSON.stringify({ role: "readonly", ttlSeconds: 60 }),
			});
			statuses.push(res.status);
		}
		expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
		expect(statuses.slice(10)).toEqual([429, 429]);
	});
});
