import { test, afterAll, mock } from "bun:test";
const realFs = { ...(await import("node:fs")) };
afterAll(() => {
	mock.module("node:fs", () => realFs);
});
test("windows links subprocess contract", async () => {
	const { mock } = await import("bun:test");
	const fs = await import("node:fs");
	mock.module("node:fs", () => ({ ...fs, constants: { ...fs.constants, O_NOFOLLOW: 0 } }));
	const { symlink } = await import("node:fs/promises");
	const { readPrivate } = await import("../src/node/storage.ts");
	Object.defineProperty(process, "platform", { value: "win32" });
	const link = process.env.KEY_FILE + ".link";
	await symlink(process.env.KEY_FILE, link);
	if ((await readPrivate(link, 4096, true)) !== "fixture") throw new Error("secure key link refused");
	let refused = false;
	try {
		await readPrivate(link);
	} catch (e) {
		refused = e.constructor.name === "PrivateFileError";
	}
	if (!refused) throw new Error("private state link followed");
});
