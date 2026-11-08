import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeReleaseVersion } from "./release-prepare";

describe("release preparation version", () => {
	test("the CLI prepares versions, notes, and the lockfile without tagging or committing", () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-release-prepare-"));
		const git = (...args: string[]) => {
			const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
			expect(result.status, result.stderr).toBe(0);
			return result.stdout.trim();
		};
		try {
			mkdirSync(join(dir, "scripts"));
			mkdirSync(join(dir, "libs/fixture"), { recursive: true });
			for (const file of ["release-prepare.ts", "version-sync.ts", "changelog.ts", "bump-level.ts"])
				copyFileSync(join(import.meta.dir, file), join(dir, "scripts", file));
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "release-fixture", private: true, version: "1.2.3", workspaces: ["libs/*"] }),
			);
			writeFileSync(
				join(dir, "libs/fixture/package.json"),
				JSON.stringify({ name: "fixture", private: true, version: "1.2.3" }),
			);
			git("init");
			git("add", ".");
			git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "chore: bootstrap");
			git("tag", "v1.2.3");
			git(
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"commit",
				"--allow-empty",
				"-m",
				"feat: add release fixture",
			);
			git("tag", "v1.3.0-next.4");
			const head = git("rev-parse", "HEAD");
			const result = spawnSync(process.execPath, ["scripts/release-prepare.ts"], { cwd: dir, encoding: "utf8" });
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("1.3.0");
			expect(JSON.parse(readFileSync(join(dir, "libs/fixture/package.json"), "utf8")).version).toBe("1.3.0");
			expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain("Tag range: `v1.2.3..v1.3.0`");
			expect(readFileSync(join(dir, "bun.lock"), "utf8")).toContain('"version": "1.3.0"');
			expect(existsSync(join(dir, ".bump-level"))).toBe(false);
			expect(result.stdout).toContain("chore: release 1.3.0");
			expect(result.stdout).toContain("channel=check, then channel=stable");
			expect(git("rev-parse", "HEAD")).toBe(head);
			expect(git("tag", "--list", "v1.3.0")).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("uses the highest conventional bump over stable-range subjects", () => {
		expect(computeReleaseVersion("1.2.3", ["fix: repair"])).toBe("1.2.4");
		expect(computeReleaseVersion("1.2.3", ["feat(ui): add panel", "fix: repair"])).toBe("1.3.0");
		expect(computeReleaseVersion("1.2.3", ["feat: add", "fix(api)!: replace"])).toBe("2.0.0");
		expect(computeReleaseVersion("0.240.2", [], "1.0.0")).toBe("1.0.0");
	});

	test("rejects nonplain, equal, or decreasing explicit versions", () => {
		for (const version of ["1.2.3", "1.2.2", "1.3.0-next.1", "v2.0.0", "01.3.0", "2.0.0+meta"])
			expect(() => computeReleaseVersion("1.2.3", [], version)).toThrow();
		expect(computeReleaseVersion("1.9.0", [], "1.10.0")).toBe("1.10.0");
	});
});
