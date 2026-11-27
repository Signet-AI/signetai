import { expect, test } from "bun:test";
import { lstat, readFile, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { OrgDaemon } from "./daemon";
import { browser, request, success } from "./http";

test.each(["symlink", "concurrency"])(
	"pause configuration protects %s",
	async (scenario) => {
		const daemon = await OrgDaemon.create();
		try {
			const claim = await request(daemon.origin, "/api/org/claim", {}, "POST", {
				setupToken: await daemon.setupToken(),
				organizationName: "Operator proof",
				admin: { username: "admin", displayName: "Admin", password: "isolated fixture password" },
			});
			success(claim, "claim");
			const admin = browser(claim);
			const file = join(daemon.workspace, "agent.yaml");
			const original = await readFile(file, "utf8");
			if (scenario === "symlink") {
				const outside = join(daemon.root, "external.yaml");
				await rename(file, outside);
				await symlink(outside, file);
				const result = await request(daemon.origin, "/api/pipeline/pause", admin, "POST", {});
				expect(result.status).toBe(409);
				expect(result.body).toMatchObject({ reason: "config_symlink" });
				expect((await lstat(file)).isSymbolicLink()).toBe(true);
				expect(await readFile(outside, "utf8")).toBe(original);
			} else {
				const results = await Promise.all([
					request(daemon.origin, "/api/pipeline/pause", admin, "POST", {}),
					request(daemon.origin, "/api/pipeline/resume", admin, "POST", {}),
				]);
				for (const result of results) expect(result.status).toBe(200);
				expect(await readFile(file, "utf8")).toContain("paused:");
			}
		} finally {
			await daemon.dispose();
		}
	},
	60_000,
);
