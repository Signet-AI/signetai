import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousSignetPath = process.env.SIGNET_PATH;
const agentsDir = mkdtempSync(join(tmpdir(), "signet-foreign-origin-"));
mkdirSync(join(agentsDir, "memory"), { recursive: true });
mkdirSync(join(agentsDir, ".daemon"), { recursive: true });
writeFileSync(join(agentsDir, ".daemon", "auth-secret"), "test-secret-key-32-bytes-min!!!!");
process.env.SIGNET_PATH = agentsDir;

let server: ReturnType<typeof import("./http-server").createSignetHttpServer>;
let port = 0;
let handled = 0;
let state: typeof import("./routes/state.js");

function writeAuthMode(mode: "local" | "hybrid" | "team"): void {
	writeFileSync(
		join(agentsDir, "agent.yaml"),
		`auth:\n  mode: ${mode}\n  rateLimits:\n    forget:\n      windowMs: 60000\n      max: 30\n    modify:\n      windowMs: 60000\n      max: 60\n    batchForget:\n      windowMs: 60000\n      max: 5\n    admin:\n      windowMs: 60000\n      max: 10\n    recallLlm:\n      windowMs: 60000\n      max: 60\n`,
	);
	state.reloadAuthState(agentsDir);
}

function send(method: string, headers: Record<string, string>, path = "/api/secrets/exec"): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode ?? 0));
		});
		req.on("error", reject);
		req.end(method === "GET" ? undefined : '{"command":"id"}');
	});
}

beforeAll(async () => {
	state = await import("./routes/state.js");
	const { Hono } = await import("hono");
	const { createSignetHttpServer } = await import("./http-server");
	const { registerGlobalMiddleware } = await import("./middleware");
	writeAuthMode("local");
	const app = new Hono();
	registerGlobalMiddleware(app);
	app.all("*", (c) => {
		handled++;
		return c.json({ ok: true });
	});
	server = createSignetHttpServer({ fetch: app.fetch });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	port = typeof address === "object" && address !== null ? address.port : 0;
});

afterAll(async () => {
	writeAuthMode("local");
	const closing = new Promise<void>((resolve) => server.close(() => resolve()));
	if ("closeAllConnections" in server) server.closeAllConnections();
	await closing;
	if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousSignetPath;
	rmSync(agentsDir, { recursive: true, force: true });
});

describe("browser writes without credentials", () => {
	it("rejects cross-site simple requests in local mode before any route runs", async () => {
		writeAuthMode("local");
		const before = handled;
		const textPlain = { "content-type": "text/plain" };
		expect(await send("POST", { ...textPlain, origin: "http://evil.example" })).toBe(403);
		expect(await send("POST", { ...textPlain, origin: "null" })).toBe(403);
		expect(await send("POST", { ...textPlain, "sec-fetch-site": "cross-site" })).toBe(403);
		expect(await send("DELETE", { origin: "http://evil.example" })).toBe(403);
		expect(handled).toBe(before);
	});

	it("rejects same-origin writes through a rebound host name", async () => {
		writeAuthMode("local");
		const host = `rebind.example:${port}`;
		expect(await send("POST", { host, origin: `http://${host}` })).toBe(403);
	});

	it("keeps non-browser clients, the dashboard, and reads working in local mode", async () => {
		writeAuthMode("local");
		expect(await send("POST", { "content-type": "application/json" })).toBe(200);
		expect(await send("POST", { origin: "http://127.0.0.1:3850" })).toBe(200);
		expect(await send("POST", { origin: `http://127.0.0.1:${port}` })).toBe(200);
		expect(await send("POST", { host: `localhost:${port}`, origin: `http://localhost:${port}` })).toBe(200);
		expect(await send("POST", { "sec-fetch-site": "same-origin" })).toBe(200);
		expect(await send("POST", { origin: "chrome-extension://abcdefghijklmnop" })).toBe(200);
		expect(await send("POST", { origin: "moz-extension://4b1f1c1e-0000-4000-8000-000000000000" })).toBe(200);
		expect(await send("GET", { origin: "http://evil.example" })).toBe(200);
	});

	it("applies to unauthenticated loopback trust in hybrid mode only", async () => {
		writeAuthMode("hybrid");
		expect(await send("POST", { origin: "http://evil.example" })).toBe(403);
		expect(await send("POST", { origin: "http://evil.example", authorization: "Bearer not-a-token" })).toBe(200);
		expect(await send("POST", { origin: "https://signet.example" }, "/api/auth/login")).toBe(200);

		writeAuthMode("team");
		expect(await send("POST", { origin: "http://evil.example" })).toBe(401);
	});
});
