import "../../../../tests/support/connector-safety.js";
import { afterEach, expect, test } from "bun:test";
import { SignetTransport, type RequestControl } from "../transport.js";
import { SignetForbiddenError, SignetTimeoutError, SignetUnauthorizedError } from "../errors.js";

const servers: ReturnType<typeof Bun.serve>[] = [];
function server(fetch: (req: Request) => Response | Promise<Response>) {
	const instance = Bun.serve({ port: 0, fetch });
	servers.push(instance);
	return instance.url.origin;
}
afterEach(() => {
	for (const s of servers) s.stop(true);
});

test.each([
	{ deadline: Number.POSITIVE_INFINITY },
	{ deadline: Number.NEGATIVE_INFINITY },
	{ deadline: Number.NaN },
	{ timeoutMs: Number.POSITIVE_INFINITY, deadline: Date.now() + 10000 },
	{ timeoutMs: Number.NaN, deadline: Date.now() + 10000 },
])("invalid individual request bounds fail before credential lookup: %j", async (control: RequestControl) => {
	let lookups = 0;
	const client = new SignetTransport({
		baseUrl: "https://unused.example",
		retries: 0,
		credentialProvider: async () => {
			lookups++;
			throw new Error("Unexpected credential lookup");
		},
	});
	await expect(client.get("/health", undefined, control)).rejects.toBeInstanceOf(RangeError);
	expect(lookups).toBe(0);
});

test("auth rejection retains status, reason and required permission", async () => {
	const baseUrl = server((req) =>
		Response.json(
			req.url.endsWith("denied")
				? { error: "Denied", reason: "permission", required: "audit" }
				: { error: "Expired", reason: "expired" },
			{ status: req.url.endsWith("denied") ? 403 : 401 },
		),
	);
	const transport = new SignetTransport({ baseUrl });
	try {
		await transport.get("/expired");
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(SignetUnauthorizedError);
		if (!(error instanceof SignetUnauthorizedError)) throw error;
		expect(error.status).toBe(401);
		expect(error.reason).toBe("expired");
	}
	try {
		await transport.get("/denied");
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(SignetForbiddenError);
		if (!(error instanceof SignetForbiddenError)) throw error;
		expect(error.status).toBe(403);
		expect(error.reason).toBe("permission");
		expect(error.required).toBe("audit");
	}
});

test("credential callback is fresh and actor headers are stripped case insensitively", async () => {
	const received: Headers[] = [];
	const baseUrl = server((req) => {
		received.push(req.headers);
		return Response.json({ ok: true });
	});
	let credential = "first";
	const transport = new SignetTransport({
		baseUrl,
		credentialProvider: async () => credential,
		headers: { "X-Signet-Actor": "spoof", "x-signet-actor-type": "spoof", "x-signet-runtime-path": "sdk" },
	});
	await transport.get("/one");
	credential = "second";
	await transport.post("/two", {}, { headers: { "X-SIGNET-ACTOR": "spoof" } });
	expect(received.map((h) => h.get("authorization"))).toEqual(["Bearer first", "Bearer second"]);
	for (const h of received) {
		expect(h.has("x-signet-actor")).toBe(false);
		expect(h.has("x-signet-actor-type")).toBe(false);
		expect(h.get("x-signet-runtime-path")).toBe("sdk");
	}
});

test("retries transient responses only for idempotent requests, at most twice", async () => {
	const calls = new Map<string, number>();
	const baseUrl = server((req) => {
		const path = new URL(req.url).pathname;
		calls.set(path, (calls.get(path) ?? 0) + 1);
		return Response.json({ error: "busy" }, { status: 503 });
	});
	const transport = new SignetTransport({ baseUrl, retryDelayMs: 1 });
	for (const [method, path, headers] of [
		["GET", "/get", {}],
		["POST", "/post", {}],
		["POST", "/keyed", { "Idempotency-Key": "stable" }],
		["DELETE", "/delete", {}],
	] as const) {
		await expect(transport.request(method, path, { headers })).rejects.toThrow();
	}
	expect(Object.fromEntries(calls)).toEqual({ "/get": 3, "/post": 1, "/keyed": 3, "/delete": 3 });
});

test("convenience calls honor whole-call deadline including retry waits", async () => {
	let calls = 0;
	const baseUrl = server(() => {
		calls++;
		return Response.json({}, { status: 503 });
	});
	const transport = new SignetTransport({ baseUrl, retryDelayMs: 1000 });
	const start = Date.now();
	await expect(transport.get("/slow", undefined, { deadline: Date.now() + 30 })).rejects.toBeInstanceOf(
		SignetTimeoutError,
	);
	expect(Date.now() - start).toBeLessThan(300);
	expect(calls).toBe(1);
	const controller = new AbortController();
	controller.abort();
	await expect(transport.post("/abort", {}, { signal: controller.signal })).rejects.toThrow();
	expect(calls).toBe(1);
});

test("cookie mode includes credentials and reads current CSRF cookie", async () => {
	const original = globalThis.fetch;
	const received: RequestInit[] = [];
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: { cookie: "other=1; signet_csrf=csrf%20value" },
	});
	globalThis.fetch = Object.assign(
		async (_url: unknown, init?: RequestInit) => {
			received.push(init ?? {});
			return Response.json({});
		},
		{ preconnect: original.preconnect },
	);
	try {
		await new SignetTransport({ baseUrl: "https://signet.example", cookieAuth: true }).post("/mutate", {});
		expect(received[0]?.credentials).toBe("include");
		expect(new Headers(received[0]?.headers).get("x-signet-csrf")).toBe("csrf value");
	} finally {
		globalThis.fetch = original;
		Reflect.deleteProperty(globalThis, "document");
	}
});
