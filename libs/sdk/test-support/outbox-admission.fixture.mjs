import { test, afterAll, mock } from "bun:test";
const realFs = { ...(await import("node:fs/promises")) };
afterAll(() => {
	mock.module("node:fs/promises", () => realFs);
});
test("outbox admission subprocess contract", async () => {
	const fs = await import("node:fs/promises");
	const { mock } = await import("bun:test");
	const { basename, dirname } = await import("node:path");
	const original = { ...fs };
	let fail = false;
	let crash = false;
	let directory = "";
	mock.module("node:fs/promises", () => ({
		...original,
		rename: async (from, to) => {
			if (fail && dirname(String(to)) === directory && /^[a-f0-9-]{36}\.json$/.test(basename(String(to))))
				throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
			const result = await original.rename(from, to);
			if (
				crash &&
				basename(String(to)) === ".status.json" &&
				JSON.parse(await original.readFile(to, "utf8")).evicted > 0
			)
				process.exit(0);
			return result;
		},
	}));
	const { DurableOutbox } = await import("../src/node.ts");
	const box = new DurableOutbox("https://admission.example");
	directory = box.directory;
	for (let i = 0; i < 200; i++) await box.enqueue({ method: "POST", path: "/api/hooks/session-end", body: { i } });
	fail = true;
	try {
		await box.enqueue({ method: "POST", path: "/api/hooks/session-end", body: { replacement: true } });
		throw new Error("expected admission failure");
	} catch (error) {
		if (error.code !== "ENOSPC") throw error;
	}
	fail = false;
	if (!process.env.FIXTURE_REPORT) throw new Error("Missing fixture report path");
	await original.writeFile(
		process.env.FIXTURE_REPORT,
		JSON.stringify({ status: await box.status(), bodies: (await box.entries()).map((e) => e.body) }),
		{ mode: 0o600 },
	);
	crash = true;
	await box.enqueue({ method: "POST", path: "/api/hooks/session-end", body: { replacement: true } });
	throw new Error("expected simulated exit");
}, 60000);
