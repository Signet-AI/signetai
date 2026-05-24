import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSourcesConfig } from "@signet/core";
import { Command } from "commander";
import { registerSourcesCommands } from "./sources";

describe("sources CLI commands", () => {
	let dir = "";
	let originalLog: typeof console.log;
	let originalError: typeof console.error;
	let previousExitCode: string | number | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-cli-sources-command-"));
		previousExitCode = process.exitCode;
		Reflect.deleteProperty(process, "exitCode");
		originalLog = console.log;
		originalError = console.error;
		console.log = () => {};
		console.error = () => {};
	});

	afterEach(() => {
		console.log = originalLog;
		console.error = originalError;
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

	it("wires source snapshot export through the daemon command path", async () => {
		const out = join(dir, "snapshot.json");
		const calls: Array<{ method: string; path: string }> = [];
		const program = new Command();
		program.exitOverride();
		registerSourcesCommands(program, {
			agentsDir: dir,
			secretApiCall: async (method, path) => {
				calls.push({ method, path });
				return {
					ok: true,
					data: { version: 1, source: { id: "discord:source" }, artifacts: [], skipped: { localDiscordArtifacts: 0 } },
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"sources",
			"snapshot",
			"export",
			"discord:source",
			"--include-local-discord",
			"--out",
			out,
		]);

		expect(calls).toEqual([{ method: "GET", path: "/api/sources/discord%3Asource/snapshot?includeLocalDiscord=true" }]);
		expect(existsSync(out)).toBe(true);
		expect(process.exitCode).not.toBe(1);
	});
});
