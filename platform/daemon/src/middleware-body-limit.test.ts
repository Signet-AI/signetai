import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createSignetHttpServer } from "./http-server";
import { registerGlobalMiddleware } from "./middleware";
test("HTTP bodies are bounded without draining streamed transcript uploads", async () => {
	const NativeResponse = globalThis.Response;
	const app = new Hono();
	registerGlobalMiddleware(app);
	app.all("*", async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
	const listening = Promise.withResolvers<number>();
	const server = createSignetHttpServer({ fetch: app.fetch });
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		listening.resolve(typeof address === "object" && address !== null ? address.port : 0);
	});
	try {
		const origin = `http://127.0.0.1:${await listening.promise}`;
		const chunked = (count: number): ReadableStream<Uint8Array> =>
			new ReadableStream({
				pull(controller) {
					if (count-- > 0) controller.enqueue(new Uint8Array(1_048_576));
					else controller.close();
				},
			});
		const small = await fetch(`${origin}/api/test`, { method: "POST", body: chunked(1), duplex: "half" });
		expect(small.status).toBe(200);
		expect(await small.json()).toEqual({ bytes: 1_048_576 });
		const large = await fetch(`${origin}/api/test`, { method: "POST", body: chunked(11), duplex: "half" });
		expect(large.status).toBe(413);
		expect(await large.json()).toEqual({ error: "payload too large" });
		const transcript = await fetch(`${origin}/api/sources/imports/job/files/file`, {
			method: "PUT",
			body: new Uint8Array(11 * 1_048_576),
		});
		expect(transcript.status).toBe(200);
		expect(await transcript.json()).toEqual({ bytes: 11 * 1_048_576 });
		const wrongMethod = await fetch(`${origin}/api/sources/imports/job/files/file`, {
			method: "POST",
			body: new Uint8Array(11 * 1_048_576),
		});
		expect(wrongMethod.status).toBe(413);
		await wrongMethod.text();
		expect(globalThis.Response).toBe(NativeResponse);
	} finally {
		const closing = new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		server.closeAllConnections();
		await closing;
	}
}, 30_000);
