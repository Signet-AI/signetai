import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { spawnTask } from "./spawn";

describe("spawnTask", () => {
	const originalPath = process.env.PATH;
	const originalWhich = Bun.which;
	const tempDirs: string[] = [];

	afterEach(() => {
		process.env.PATH = originalPath;
		Bun.which = originalWhich;
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("passes the configured model to codex scheduled tasks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-spawn-test-"));
		tempDirs.push(dir);

		const outPath = join(dir, "args.txt");
		const binPath = join(dir, "codex");
		writeFileSync(
			binPath,
			`#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(outPath)}
printf 'ok'
`,
		);
		chmodSync(binPath, 0o755);
		process.env.PATH = `${dir}:${originalPath ?? ""}`;
		Bun.which = ((bin: string) => (bin === "codex" ? binPath : originalWhich(bin))) as typeof Bun.which;

		const result = await spawnTask("codex", "summarize this", dir, 5000, undefined, "gpt-5.3-codex");

		expect(result.exitCode).toBe(0);
		expect(readFileSync(outPath, "utf8").trim().split("\n")).toEqual([
			"exec",
			"--skip-git-repo-check",
			"--json",
			"--model",
			"gpt-5.3-codex",
			"summarize this",
		]);
	});

	it("passes the configured model to claude-code scheduled tasks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-spawn-test-"));
		tempDirs.push(dir);

		const outPath = join(dir, "args.txt");
		const binPath = join(dir, "claude");
		writeFileSync(
			binPath,
			`#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(outPath)}
printf 'ok'
`,
		);
		chmodSync(binPath, 0o755);
		process.env.PATH = `${dir}:${originalPath ?? ""}`;
		Bun.which = ((bin: string) => (bin === "claude" ? binPath : originalWhich(bin))) as typeof Bun.which;

		const result = await spawnTask("claude-code", "summarize this", dir, 5000, undefined, "haiku");

		expect(result.exitCode).toBe(0);
		expect(readFileSync(outPath, "utf8").trim().split("\n")).toEqual([
			"--dangerously-skip-permissions",
			"--model",
			"haiku",
			"-p",
			"summarize this",
		]);
	});
});
