import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSourcesConfig } from "@signet/core";
import { Command } from "commander";
import { registerSourcesCommands } from "./sources";

describe("sources CLI commands", () => {
	let dir = "";
	let originalLog: typeof console.log;
	let previousExitCode: string | number | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-cli-sources-command-"));
		previousExitCode = process.exitCode;
		Reflect.deleteProperty(process, "exitCode");
		originalLog = console.log;
		console.log = () => {};
	});

	afterEach(() => {
		console.log = originalLog;
		if (previousExitCode === undefined) process.exitCode = 0;
		else process.exitCode = previousExitCode;
		rmSync(dir, { recursive: true, force: true });
	});

	it("wires desktop-cache mode through the Discord add command", async () => {
		const cachePath = join(dir, "discord");
		const program = new Command();
		program.exitOverride();
		registerSourcesCommands(program, { agentsDir: dir });

		await program.parseAsync([
			"node",
			"test",
			"sources",
			"add",
			"discord",
			"--mode",
			"desktop-cache",
			"--desktop-cache-path",
			cachePath,
			"--full-cache",
			"--name",
			"CLI Discord Cache",
		]);

		const [source] = loadSourcesConfig(dir).sources;
		expect(source?.id.startsWith("discord-cache:")).toBe(true);
		expect(source?.root).toBe(cachePath);
		expect(source?.providerSettings?.syncMode).toBe("desktop-cache");
		expect(source?.providerSettings?.desktopCacheFullScan).toBe(true);
		expect(process.exitCode).not.toBe(1);
	});
});
