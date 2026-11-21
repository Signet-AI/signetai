import { describe, expect, test } from "bun:test";
import { createSignetHttpServer } from "./server";

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
