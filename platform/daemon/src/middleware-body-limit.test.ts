import { expect, test } from "bun:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { registerGlobalMiddleware } from "./middleware";

// Exercise the same Node HTTP adapter as daemon.ts: an early data listener can
// drain this request before Hono reads it, while Content-Length alone misses
// chunked overflow.
test("HTTP bodies are bounded without draining streamed transcript uploads", async () => {
	const app = new Hono();
	registerGlobalMiddleware(app);
	app.all("*", async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
	const listening = Promise.withResolvers<number>();
	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => listening.resolve(info.port));
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
	} finally {
		const closing = new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		server.closeAllConnections();
		await closing;
	}
}, 30_000);
