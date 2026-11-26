import { test } from "bun:test";
test("outbox delivery subprocess contract", async () => {
	if (!process.env.FIXTURE_ORIGIN) throw new Error("Missing fixture data");
	const { NodeTransport, resolveTarget } = await import("../src/node.ts");
	const target = await resolveTarget({ flagUrl: process.env.FIXTURE_ORIGIN, flagKey: "valid" });
	await new NodeTransport(target).post("/api/hooks/session-end", { transcript: "durable before dispatch" });
});
