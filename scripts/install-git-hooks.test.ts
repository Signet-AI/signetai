import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const installer = join(root, "scripts", "install-git-hooks.ts");

describe("install-git-hooks", () => {
	test("skips when Git is unavailable", () => {
		const binDir = mkdtempSync(join(tmpdir(), "signet-no-git-"));

		try {
			const result = spawnSync(process.execPath, [installer], {
				encoding: "utf8",
				env: {
					...process.env,
					PATH: binDir,
				},
			});

			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("Git executable not found; skipping hook installation.");
		} finally {
			rmSync(binDir, { recursive: true, force: true });
		}
	});
});
