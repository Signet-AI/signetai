import { fileURLToPath } from "node:url";
import "../../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform !== "linux")("stale lock cleanup cannot unlink a replacement generation", async () => {
	const home = await mkdtemp(join(tmpdir(), "sdk-lock-generation-"));
	try {
		const path = join(home, "mutex");
		const code = fileURLToPath(new URL("../../test-support/lock-generation.fixture.mjs", import.meta.url));
		const child = Bun.spawn([process.execPath, "test", code], {
			env: { ...process.env, HOME: home, FIXTURE_LOCK: path },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited, stderr).toBe(0);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
