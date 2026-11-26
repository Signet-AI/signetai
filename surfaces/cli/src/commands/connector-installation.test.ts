import "../../../../tests/support/connector-safety.js";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshotInstallation } from "../lib/connector-installation";

test("rollback never publishes a restored private file with public permissions", async () => {
	const root = await fs.mkdtemp(join(tmpdir(), "connector-rollback-"));
	const path = join(root, "settings.json");
	const umask = process.umask(0o022);
	const chmod = fs.chmod;
	await fs.writeFile(path, "private configuration", { mode: 0o600 });
	const restore = await snapshotInstallation([path]);
	await fs.rm(path);
	const observer = spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
		expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
		await chmod(target, mode);
	});
	try {
		await restore();
		expect(await fs.readFile(path, "utf8")).toBe("private configuration");
		expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
	} finally {
		observer.mockRestore();
		process.umask(umask);
		await fs.rm(root, { recursive: true, force: true });
	}
});
