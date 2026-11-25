import { describe, expect, test } from "bun:test";
import { createSignetHttpServer, closeSignetHttpServer } from "./http-server";
import { createConnection } from "node:net";

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
