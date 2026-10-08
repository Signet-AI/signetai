import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "advance-npm-dist-tag.sh");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface Run {
	readonly result: ReturnType<typeof spawnSync>;
	readonly added: string | null;
}

// A fake npm that answers `npm view <pkg> dist-tags.<tag>` from $CURRENT
// (exit 1 when $VIEW_FAILS is set) and records `npm dist-tag add` arguments.
function run(version: string, current: string, viewFails = false): Run {
	const dir = mkdtempSync(join(tmpdir(), "signet-dist-tag-test-"));
	tempDirs.push(dir);
	const log = join(dir, "added");
	writeFileSync(
		join(dir, "npm"),
		[
			"#!/usr/bin/env bash",
			'if [ "$1" = "view" ]; then',
			'  if [ -n "$VIEW_FAILS" ]; then exit 1; fi',
			'  printf "%s" "$CURRENT"',
			"  exit 0",
			"fi",
			'if [ "$1" = "dist-tag" ] && [ "$2" = "add" ]; then',
			'  printf "%s %s" "$3" "$4" > "$LOG"',
			"  exit 0",
			"fi",
			"exit 9",
			"",
		].join("\n"),
	);
	chmodSync(join(dir, "npm"), 0o755);
	const result = spawnSync(script, ["signetai", version, "next"], {
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH ?? ""}`,
			CURRENT: current,
			LOG: log,
			VIEW_FAILS: viewFails ? "1" : "",
		},
	});
	return { result, added: existsSync(log) ? readFileSync(log, "utf8") : null };
}

describe("advance-npm-dist-tag", () => {
	test("moves the tag forward to a newer version", () => {
		const { result, added } = run("0.237.9", "0.237.8");
		expect(result.status).toBe(0);
		expect(added).toBe("signetai@0.237.9 next");
	});

	test("does not move the tag back when an older pipeline publishes last", () => {
		const { result, added } = run("0.237.8", "0.237.9");
		expect(result.status).toBe(0);
		expect(added).toBeNull();
		expect(result.stdout).toContain("leaving it ahead of 0.237.8");
	});

	test("compares versions numerically, not lexically", () => {
		expect(run("0.237.10", "0.237.9").added).toBe("signetai@0.237.10 next");
		expect(run("0.237.9", "0.237.10").added).toBeNull();
	});

	test("sets the tag for a new package or a repeated version", () => {
		expect(run("0.1.0", "").added).toBe("signetai@0.1.0 next");
		expect(run("0.237.9", "0.237.9").added).toBe("signetai@0.237.9 next");
	});

	test("does not order prerelease versions with sort -V", () => {
		const { result, added } = run("0.238.0", "0.238.0-rc.1");
		expect(added).toBe("signetai@0.238.0 next");
		expect(result.stdout).toContain("::warning::Not ordering signetai@next (0.238.0-rc.1) against 0.238.0");
	});

	test("warns and sets the tag when the current tag cannot be read", () => {
		const { result, added } = run("0.237.9", "0.237.10", true);
		expect(result.status).toBe(0);
		expect(added).toBe("signetai@0.237.9 next");
		expect(result.stdout).toContain("::warning::Could not read signetai@next");
	});
});
