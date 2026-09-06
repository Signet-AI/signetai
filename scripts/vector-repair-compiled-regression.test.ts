import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("compiled vector repair large-corpus regression", () => {
	test("keeps owner pages bounded without blocking the compiled event loop", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-compiled-vector-repair-"));
		tempDirectories.push(directory);
		const binary = join(directory, process.platform === "win32" ? "vector-repair.exe" : "vector-repair");
		const fixture = join(root, "scripts", "vector-repair-compiled-fixture.ts");
		const build = spawnSync(process.execPath, ["build", "--compile", "--target=bun", "--outfile", binary, fixture], {
			cwd: root,
			encoding: "utf8",
			timeout: 120_000,
		});
		expect(build.status, `${build.stdout ?? ""}${build.stderr ?? ""}`).toBe(0);
		if (build.status !== 0) return;
		if (process.platform !== "win32") chmodSync(binary, 0o755);

		const run = spawnSync(binary, ["5000"], { encoding: "utf8", timeout: 120_000 });
		const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
		expect(run.status, output).toBe(0);
		const line = (run.stdout ?? "").trim().split("\n").at(-1) ?? "";
		const result = JSON.parse(line) as {
			status: string;
			processed: number;
			remaining: number;
			maxBatchRows: number;
			maxBatchBytes: number;
			rssDeltaMb: number;
			maxEventLoopLatencyMs: number;
		};
		expect(result.status).toBe("complete");
		expect(result.processed).toBe(5000);
		expect(result.remaining).toBe(0);
		expect(result.maxBatchRows).toBeLessThanOrEqual(50);
		expect(result.maxBatchBytes).toBeLessThanOrEqual(256 * 1024);
		expect(result.rssDeltaMb).toBeLessThan(128);
		expect(result.maxEventLoopLatencyMs).toBeLessThan(500);
	});
});
