import { expect, test } from "bun:test";
import { Hono } from "hono";
import { registerPublicReadResponse } from "./public-read-response";

test("local-mode public response mapping preserves base numeric ids and internal-field shapes", async () => {
	const app = new Hono();
	registerPublicReadResponse(app, "/local");
	const payload = {
		id: 7,
		rowid: 7,
		normalized_content: "local evidence",
		nested: [{ id: 8, content_hash: "local hash" }],
	};
	app.get("/local", (c) => c.json(payload));
	expect(await (await app.request("/local")).json()).toEqual(payload);
});
