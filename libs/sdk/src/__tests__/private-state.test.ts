import "../../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicPrivateWrite } from "../node/storage.js";
import { NodeTransport } from "../node.js";
import { SignetCredentialError } from "../errors.js";

for (const nested of [false, true])
	test.skipIf(process.platform === "win32")(
		`private directory ${nested ? "ancestor" : "leaf"} links cannot redirect writes`,
		async () => {
			const home = await mkdtemp(join(tmpdir(), "sdk-private-dir-"));
			try {
				const outside = join(home, "outside");
				await mkdir(outside, { mode: 0o755 });
				const link = join(home, "private");
				await symlink(outside, link);
				await expect(
					atomicPrivateWrite(join(link, ...(nested ? ["nested"] : []), "state.json"), "data"),
				).rejects.toThrow();
				expect(await readdir(outside)).toEqual([]);
				expect((await stat(outside)).mode & 0o777).toBe(0o755);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);

test("untyped explicit refresh provider failures remain terminal credential errors", async () => {
	let calls = 0;
	const server = Bun.serve({ port: 0, fetch: () => Response.json({ reason: "expired" }, { status: 401 }) });
	const url = `http://127.0.0.1:${server.port}`;
	const client = new NodeTransport({
		url,
		origin: url,
		remote: false,
		credential: {
			source: "flag",
			get: async () => "fixture",
			refresh: async () => {
				calls++;
				throw new Error("storage unavailable");
			},
		},
	});
	try {
		await expect(client.get("/protected")).rejects.toBeInstanceOf(SignetCredentialError);
		expect(calls).toBe(1);
	} finally {
		server.stop(true);
	}
});
