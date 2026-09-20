import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

const repo = process.cwd();

describe("shared corpus runner CLI exit contract", () => {
	test("fails nonzero when a Rust adapter reports a failed lane", () => {
		const temp = mkdtempSync(join(repo, ".shared-corpus-runner-cli-"));
		const adapter = join(temp, "failing-adapter.sh");
		const artifact = join(temp, "artifact");
		const report = join(temp, "report.xml");
		try {
			writeFileSync(
				adapter,
				`#!/bin/sh\nprintf '%s' '<testsuite tests="1" failures="1"><testcase classname="fixture" name="failure"><failure /></testcase></testsuite>' > "$8"\n`,
			);
			chmodSync(adapter, 0o755);
			writeFileSync(artifact, "placeholder");
			const result = spawnSync(
				process.execPath,
				[
					"scripts/shared-corpus-runner.ts",
					"--backend",
					"rust",
					"--artifact",
					artifact,
					"--adapter",
					adapter,
					"--report",
					report,
				],
				{ cwd: repo, encoding: "utf8" },
			);
			expect(result.status).not.toBe(0);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
});
