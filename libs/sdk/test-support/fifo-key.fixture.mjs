import { test } from "bun:test";
test("fifo key subprocess contract", async () => {
	if (!process.env.FIXTURE_FIFO) throw new Error("Missing fixture data");
	const { readKeyFile } = await import("../src/node.ts");
	setTimeout(() => process.exit(2), 350);
	try {
		await readKeyFile(process.env.FIXTURE_FIFO);
		process.exit(3);
	} catch {
		process.exit(0);
	}
});
