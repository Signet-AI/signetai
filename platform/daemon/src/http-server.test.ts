import { describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { request } from "node:http";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { closeSignetHttpServer, createSignetHttpServer } from "./http-server";

test("shutdown closes idle TCP preconnections without aborting an active response", async () => {
	let complete: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		complete = resolve;
	});
	let entered: () => void = () => {};
	const active = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const server = createSignetHttpServer({
		fetch: async () => {
			entered();
			await held;
			return new Response("finished");
		},
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No port");
	const idle = createConnection({ host: "127.0.0.1", port: address.port });
	await new Promise<void>((resolve) => idle.once("connect", resolve));
	const request = fetch(`http://127.0.0.1:${address.port}`);
	await active;
	let closed = false;
	const closing = closeSignetHttpServer(server).then((forced) => {
		expect(forced).toBe(false);
		closed = true;
	});
	await Bun.sleep(10);
	expect(closed).toBe(false);
	complete();
	expect(await (await request).text()).toBe("finished");
	await Promise.race([
		closing,
		Bun.sleep(1000).then(() => {
			throw new Error("Idle TCP socket blocked shutdown");
		}),
	]);
	idle.destroy();
	expect(closed).toBe(true);
});

for (const method of ["POST", "PUT", "PATCH", "DELETE"])
	test(`chunked ${method} preserves method and body through the middleware stack`, async () => {
		const app = new Hono();
		app.use("*", bodyLimit({ maxSize: 1024 }));
		app.all("*", async (c) =>
			c.json({ method: c.req.method, value: await c.req.text(), forged: c.req.header("x-signet-local") ?? null }),
		);
		const server = createSignetHttpServer({ fetch: app.fetch });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No port");
		try {
			const result = await new Promise<string>((resolve, reject) => {
				const outgoing = request(
					{
						host: "127.0.0.1",
						port: address.port,
						method,
						headers: { "x-signet-local": "true", "transfer-encoding": "chunked" },
					},
					(incoming) => {
						let response = "";
						incoming.setEncoding("utf8");
						incoming.on("data", (chunk: string) => {
							response += chunk;
						});
						incoming.once("end", () => resolve(response));
						incoming.once("error", reject);
					},
				);
				outgoing.once("error", reject);
				outgoing.write("first ");
				outgoing.end("second");
			});
			expect(JSON.parse(result)).toEqual({ method, value: "first second", forged: null });
		} finally {
			await closeSignetHttpServer(server);
		}
	});

describe("createSignetHttpServer", () => {
	test("keeps native Request and Response globals intact", () => {
		const request = globalThis.Request;
		const response = globalThis.Response;

		const server = createSignetHttpServer({
			fetch: () => new response("ok"),
			hostname: "127.0.0.1",
		});
		server.close();

		expect(globalThis.Request).toBe(request);
		expect(globalThis.Response).toBe(response);
	});
});
