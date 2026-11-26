import { test } from "bun:test";
test("windows directory subprocess contract", async () => {
	const { mkdir, chmod } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { windowsAcl, rememberDirectoryMutation } = await import("../src/node/windows-acl.ts");
	Object.defineProperty(process, "platform", { value: "win32" });
	const dir = join(process.env.HOME, "private");
	await mkdir(dir, { mode: 0o700 });
	await windowsAcl(dir, true, false);
	await chmod(dir, 0o755);
	await rememberDirectoryMutation(dir);
	let refused = false;
	try {
		await windowsAcl(dir, true, false);
	} catch (e) {
		refused = e.name === "Error" || e.constructor.name === "UnsafeAclError";
	}
	if (!refused) throw new Error("directory mutation blessed unsafe ACL");
});
