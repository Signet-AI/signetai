import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { Hono } from "hono";
import { registerGlobalMiddleware } from "./middleware";

const originalRequestText = Request.prototype.text;
const originalFetch = globalThis.fetch;

afterEach(() => {
	Request.prototype.text = originalRequestText;
	globalThis.fetch = originalFetch;
});

function makeApp(getShadowProcess: () => ChildProcess | null): Hono {
	const app = new Hono();
	registerGlobalMiddleware(app, { getShadowProcess });
	app.post("/api/test", (c) => c.json({ ok: true }));
	return app;
}

function fakeShadowProcess(): ChildProcess {
	return Object.create(null) as ChildProcess;
}

function trackRequestTextReads(): () => number {
	let reads = 0;
	Request.prototype.text = function text(this: Request): Promise<string> {
		reads += 1;
		return originalRequestText.call(this);
	};
	return () => reads;
}

describe("global middleware shadow body capture", () => {
	test("does not read mutating request bodies when shadowing is inactive", async () => {
		const textReads = trackRequestTextReads();
		const app = makeApp(() => null);

		const res = await app.request("http://localhost/api/test", {
			method: "POST",
			body: "large body",
		});

		expect(res.status).toBe(200);
		expect(textReads()).toBe(0);
	});

	test("captures mutating request bodies only when shadowing is active", async () => {
		const textReads = trackRequestTextReads();
		let shadowBody: BodyInit | null | undefined;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			shadowBody = init?.body;
			return Promise.resolve(new Response(null, { status: 200 }));
		}) as typeof fetch;
		const app = makeApp(() => fakeShadowProcess());

		const res = await app.request("http://localhost/api/test", {
			method: "POST",
			body: "shadow body",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(res.status).toBe(200);
		expect(textReads()).toBe(1);
		expect(shadowBody).toBe("shadow body");
	});
});
