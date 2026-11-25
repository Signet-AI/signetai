import { expect, test } from "bun:test";
import { createHookFetch } from "../lib/hook-transport.js";
import { ConnectorRegistry, DurableOutbox, writeKeyFile } from "../../../../libs/sdk/src/node.js";

test("session-end 401 retains evidence in the harness outbox", async () => {
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			expect(request.headers.get("authorization")).toBe("Bearer scoped-credential");
			expect(request.headers.has("x-signet-actor")).toBe(false);
			return Response.json({ error: "expired", reason: "expired" }, { status: 401 });
		},
	});
	const harness = `test-${crypto.randomUUID()}`;
	const keyFile = await writeKeyFile(server.url.origin, harness, "scoped-credential");
	await new ConnectorRegistry().set(harness, { url: server.url.origin, keyFile });
	try {
		const fetch = await createHookFetch(harness);
		const result = await fetch("/api/hooks/session-end", {
			method: "POST",
			body: JSON.stringify({ sessionKey: "conversation", harness, transcript: "durable evidence" }),
		});
		expect(result).toMatchObject({ ok: false, status: 401, body: { reason: "expired" } });
		expect((await new DurableOutbox(server.url.origin, { harness }).status()).pending).toBe(1);
	} finally {
		server.stop(true);
		await new ConnectorRegistry().remove(harness);
	}
});
