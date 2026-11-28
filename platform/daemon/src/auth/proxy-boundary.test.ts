import { expect, test } from "bun:test";
import { Hono } from "hono";
import { parseAuthConfig } from "./config";
import { createIdentityMiddleware } from "./identity-middleware";
import { AuthRateLimiter } from "./rate-limiter";

function app(raw: unknown) {
	const app = new Hono();
	app.use("*", createIdentityMiddleware(parseAuthConfig(raw, "/unused"), null));
	app.post("/api/auth/login", (c) => c.json({ ok: true }));
	app.post("/api/auth/device/start", (c) => c.json({ ok: true }));
	return app;
}
function request(
	app: Hono,
	path: string,
	peer: string,
	forwarded: string,
	extra: Record<string, string> = {},
	username = "alice",
) {
	return app.fetch(
		new Request(`http://daemon.invalid${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-forwarded-for": forwarded, ...extra },
			body: JSON.stringify({ username, password: "fixture" }),
		}),
		{ incoming: { socket: { remoteAddress: peer } } },
	);
}
test("trusted proxy networks are validated and normalized at config load", () => {
	expect(Reflect.get(parseAuthConfig(undefined, "/unused"), "trustedProxies")).toEqual([]);
	for (const value of ["not-an-ip", "10.0.0.0/33", "::/129", "127.0.0.1/nope"])
		expect(() => parseAuthConfig({ trustedProxies: [value] }, "/unused")).toThrow();
});
test("only a trusted socket peer can supply the browser origin", async () => {
	const trusted = app({ mode: "local", trustedProxies: ["127.0.0.0/8"] });
	const headers = {
		origin: "https://public.example",
		"x-forwarded-host": "public.example",
		"x-forwarded-proto": "https",
	};
	expect((await request(trusted, "/api/auth/login", "127.0.0.1", "198.51.100.1", headers)).status).toBe(200);
	expect((await request(trusted, "/api/auth/login", "203.0.113.2", "198.51.100.1", headers)).status).toBe(403);
});
test("trusted proxy rate keys use the rightmost untrusted hop rather than a forged leftmost hop", async () => {
	const server = app({ mode: "local", trustedProxies: ["127.0.0.1", "10.0.0.0/8"] });
	for (let i = 0; i < 20; i++)
		expect(
			(await request(server, "/api/auth/device/start", "127.0.0.1", `192.0.2.${i}, 198.51.100.7, 10.2.3.4`)).status,
		).toBe(200);
	expect(
		(await request(server, "/api/auth/device/start", "127.0.0.1", "192.0.2.22,198.51.100.7,10.2.3.4")).status,
	).toBe(429);
	expect((await request(server, "/api/auth/device/start", "127.0.0.1", "198.51.100.8,10.2.3.4")).status).toBe(200);
});
test("development dashboard origins work in local and hybrid modes", async () => {
	for (const mode of ["local", "hybrid"]) {
		const server = app({ mode });
		expect(
			(await request(server, "/api/auth/login", "127.0.0.1", "", { origin: "http://localhost:5173" })).status,
		).toBe(200);
	}
});
test("login has a five-attempt username and client limit without a global five-attempt lockout", async () => {
	const server = app({ mode: "local", trustedProxies: ["127.0.0.1"] });
	for (let i = 0; i < 5; i++)
		expect((await request(server, "/api/auth/login", "127.0.0.1", "198.51.100.1")).status).toBe(200);
	expect((await request(server, "/api/auth/login", "127.0.0.1", "198.51.100.1")).status).toBe(429);
	expect((await request(server, "/api/auth/login", "127.0.0.1", "198.51.100.2")).status).toBe(200);
});
test("login lockout cannot follow an account to another client IP", async () => {
	const server = app({ mode: "local", trustedProxies: ["127.0.0.1"] });
	for (let i = 0; i < 30; i++)
		expect((await request(server, "/api/auth/login", "127.0.0.1", `198.51.100.${Math.floor(i / 5) + 1}`)).status).toBe(
			200,
		);
	expect((await request(server, "/api/auth/login", "127.0.0.1", "198.51.100.99")).status).toBe(200);
	expect((await request(server, "/api/auth/login", "127.0.0.1", "198.51.100.1")).status).toBe(429);
});
test("full rate limiter evicts the oldest-expiring entry without rejecting a new client", () => {
	const limiter = new AuthRateLimiter(60000, 1);
	for (let i = 0; i < 10000; i++) limiter.record(`peer:${i}`);
	expect(limiter.check("new-client").allowed).toBe(true);
	limiter.record("new-client");
	expect(limiter.check("peer:0").allowed).toBe(true);
	expect(limiter.check("new-client").allowed).toBe(false);
});

test.each([
	{ origin: "https://daemon.invalid", "x-forwarded-proto": "https" },
	{ origin: "http://public.example", "x-forwarded-host": "public.example" },
])("trusted proxy protocol and host can be supplied independently (%j)", async (headers: Record<string, string>) => {
	const server = app({ mode: "local", trustedProxies: ["127.0.0.1"] });
	expect((await request(server, "/api/auth/login", "127.0.0.1", "198.51.100.1", headers)).status).toBe(200);
});
test("IPv6 proxy CIDRs are canonicalized once and bounded", async () => {
	const config = parseAuthConfig(
		{ mode: "local", trustedProxies: [" 2001:0DB8:0001::/48 ", "2001:db8:1::/48"] },
		"/unused",
	);
	expect(config.trustedProxies).toEqual(["2001:db8:1::/48"]);
	expect(() => parseAuthConfig({ trustedProxies: Array(257).fill("127.0.0.1") }, "/unused")).toThrow();
	const server = app({ mode: "local", trustedProxies: config.trustedProxies });
	expect(
		(
			await request(server, "/api/auth/login", "2001:db8:1::2", "198.51.100.1", {
				origin: "https://public.example",
				"x-forwarded-host": "public.example",
				"x-forwarded-proto": "https",
			})
		).status,
	).toBe(200);
});

test("mapped IPv4 and IPv6 /64 addresses share rate limit buckets", async () => {
	const server = app({ mode: "local", trustedProxies: ["127.0.0.1"] });
	for (let i = 0; i < 20; i++)
		expect((await request(server, "/api/auth/device/start", "127.0.0.1", "198.51.100.7")).status).toBe(200);
	expect((await request(server, "/api/auth/device/start", "127.0.0.1", "::ffff:198.51.100.7")).status).toBe(429);
	for (let i = 0; i < 20; i++)
		expect((await request(server, "/api/auth/device/start", "127.0.0.1", `2001:db8:1:2::${i + 1}`)).status).toBe(200);
	expect((await request(server, "/api/auth/device/start", "127.0.0.1", "2001:db8:1:2:abcd::1")).status).toBe(429);
	expect((await request(server, "/api/auth/device/start", "127.0.0.1", "2001:db8:1:3::1")).status).toBe(200);
});
