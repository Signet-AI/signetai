import { fileURLToPath } from "node:url";
import "../../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const operation of ["save", "clear"])
	test(`login ${operation} does not acknowledge an unconfirmed marker deletion`, async () => {
		const home = await mkdtemp(join(tmpdir(), "sdk-login-state-"));

		const code = fileURLToPath(new URL("../../test-support/login-durability.fixture.mjs", import.meta.url));
		try {
			const child = Bun.spawn([process.execPath, "test", code], {
				env: { ...process.env, HOME: home, FIXTURE_OPERATION: operation },
				stdout: "pipe",
				stderr: "pipe",
			});
			const error = await new Response(child.stderr).text();
			expect(await child.exited, error).toBe(0);
		} finally {
			await rm(home, { force: true, recursive: true });
		}
	});
