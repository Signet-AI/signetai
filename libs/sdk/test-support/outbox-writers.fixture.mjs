import { test } from "bun:test";
test("outbox writers subprocess contract", async () => {
	const { DurableOutbox } = await import("../src/node.ts");
	const box = new DurableOutbox("https://org.example");
	for (let i = 0; i < 8; i++)
		await box.enqueue({ method: "POST", path: "/api/hooks/session-end", body: { pid: process.pid, i } });
});
