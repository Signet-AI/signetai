import { test } from "bun:test";
test("outbox refresh subprocess contract", async () => {
	if (!process.env.FIXTURE_ORIGIN) throw new Error("Missing fixture data");
	const { NodeTransport, resolveTarget } = await import("../src/node.ts");
	const keyring = { get: async () => ({ state: "unavailable" }), set: async () => ({ state: "unavailable" }) };
	await new NodeTransport(await resolveTarget({ flagUrl: process.env.FIXTURE_ORIGIN, keyring })).get("/protected");
});
