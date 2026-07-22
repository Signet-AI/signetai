import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnTask } from "./spawn";

describe("spawnTask", () => {
	const originalPath = process.env.PATH;
	const originalWhich = Bun.which;
	const originalKimiShareDir = process.env.KIMI_SHARE_DIR;
	const originalKimiCodeHome = process.env.KIMI_CODE_HOME;
	const tempDirs: string[] = [];

	afterEach(() => {
		process.env.PATH = originalPath;
		Bun.which = originalWhich;
		if (originalKimiShareDir === undefined) Reflect.deleteProperty(process.env, "KIMI_SHARE_DIR");
		else process.env.KIMI_SHARE_DIR = originalKimiShareDir;
		if (originalKimiCodeHome === undefined) Reflect.deleteProperty(process.env, "KIMI_CODE_HOME");
		else process.env.KIMI_CODE_HOME = originalKimiCodeHome;
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

	it("passes the configured model to kimi scheduled tasks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-spawn-test-"));
		tempDirs.push(dir);

		const outPath = join(dir, "args.txt");
		const binPath = join(dir, "kimi");
		writeFileSync(
			binPath,
			`#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(outPath)}
printf 'ok'
`,
		);
		chmodSync(binPath, 0o755);
		process.env.PATH = `${dir}:${originalPath ?? ""}`;
		Bun.which = ((bin: string) => (bin === "kimi" ? binPath : originalWhich(bin))) as typeof Bun.which;
		process.env.KIMI_CODE_HOME = dir;
		Reflect.deleteProperty(process.env, "KIMI_SHARE_DIR");

		const result = await spawnTask("kimi", "summarize this", dir, 5000, undefined, "kimi-code/kimi-for-coding");

		expect(result.exitCode).toBe(0);
		expect(readFileSync(outPath, "utf8").trim().split("\n")).toEqual([
			"-p",
			"summarize this",
			"--output-format",
			"stream-json",
			"-m",
			"kimi-code/kimi-for-coding",
		]);
	});

	it("uses current Kimi print mode when KIMI_SHARE_DIR is configured", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-spawn-test-"));
		tempDirs.push(dir);

		const outPath = join(dir, "args.txt");
		const binPath = join(dir, "kimi");
		writeFileSync(
			binPath,
			`#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(outPath)}
printf 'ok'
`,
		);
		chmodSync(binPath, 0o755);
		process.env.PATH = `${dir}:${originalPath ?? ""}`;
		Bun.which = ((bin: string) => (bin === "kimi" ? binPath : originalWhich(bin))) as typeof Bun.which;
		process.env.KIMI_SHARE_DIR = dir;
		Reflect.deleteProperty(process.env, "KIMI_CODE_HOME");

		const result = await spawnTask("kimi", "summarize this", dir, 5000);

		expect(result.exitCode).toBe(0);
		expect(readFileSync(outPath, "utf8").trim().split("\n")).toEqual([
			"--print",
			"--final-message-only",
			"-p",
			"summarize this",
			"--output-format",
			"stream-json",
		]);
	});

	it("omits the model flag for legacy kimi scheduled tasks when no model is configured", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-spawn-test-"));
		tempDirs.push(dir);

		const outPath = join(dir, "args.txt");
		const binPath = join(dir, "kimi");
		writeFileSync(
			binPath,
			`#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(outPath)}
printf 'ok'
`,
		);
		chmodSync(binPath, 0o755);
		process.env.PATH = `${dir}:${originalPath ?? ""}`;
		Bun.which = ((bin: string) => (bin === "kimi" ? binPath : originalWhich(bin))) as typeof Bun.which;
		process.env.KIMI_CODE_HOME = dir;
		Reflect.deleteProperty(process.env, "KIMI_SHARE_DIR");

		const result = await spawnTask("kimi", "summarize this", dir, 5000);

		expect(result.exitCode).toBe(0);
		expect(readFileSync(outPath, "utf8").trim().split("\n")).toEqual([
			"-p",
			"summarize this",
			"--output-format",
			"stream-json",
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
