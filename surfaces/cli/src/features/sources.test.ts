import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addObsidianSource, loadSourcesConfig } from "@signet/core";
import { addObsidianVaultSource, removeConfiguredSource } from "./sources";

describe("sources CLI features", () => {
	let dir = "";
	let vault = "";
	let logs: string[] = [];
	let errors: string[] = [];
	let warnings: string[] = [];
	let prevExitCode: string | number | undefined;
	let originalLog: typeof console.log;
	let originalError: typeof console.error;
	let originalWarn: typeof console.warn;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-cli-sources-"));
		vault = join(dir, "vault");
		mkdirSync(vault, { recursive: true });
		logs = [];
		errors = [];
		warnings = [];
		prevExitCode = process.exitCode;
		Reflect.deleteProperty(process, "exitCode");
		originalLog = console.log;
		originalError = console.error;
		originalWarn = console.warn;
		console.log = (...args: unknown[]) => logs.push(args.join(" "));
		console.error = (...args: unknown[]) => errors.push(args.join(" "));
		console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
	});

	afterEach(() => {
		console.log = originalLog;
		console.error = originalError;
		console.warn = originalWarn;
		if (prevExitCode === undefined) process.exitCode = 0;
		else process.exitCode = prevExitCode;
		rmSync(dir, { recursive: true, force: true });
	});

	it("removes a configured source by id from the selected agents directory when daemon purge is unavailable", async () => {
		const added = addObsidianSource({ root: vault, name: "CLI Vault" }, dir);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		await removeConfiguredSource(added.source.id, {
			agentsDir: dir,
			removeSourceFromDaemon: async () => ({ ok: false, error: "Could not reach Signet daemon" }),
		});

		expect(loadSourcesConfig(dir).sources).toHaveLength(0);
		expect(logs.join("\n")).toContain("Removed source config: CLI Vault");
		expect(logs.join("\n")).toContain("Source files were not modified");
		expect(logs.join("\n")).toContain("not purged because the daemon API was unavailable");
		expect(warnings.join("\n")).toContain("Falling back to local config-only removal");
		expect(process.exitCode).not.toBe(1);
	});

	it("uses daemon-first source removal when the daemon purge succeeds", async () => {
		const added = addObsidianSource({ root: vault, name: "CLI Vault" }, dir);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		await removeConfiguredSource(added.source.id, {
			agentsDir: dir,
			removeSourceFromDaemon: async (sourceId) => ({
				ok: true,
				purged: 12,
				source: { name: "CLI Vault", root: vault },
			}),
		});

		expect(loadSourcesConfig(dir).sources).toHaveLength(1);
		expect(logs.join("\n")).toContain("Removed source: CLI Vault");
		expect(logs.join("\n")).toContain("Purged 12 Signet-owned source rows");
		expect(logs.join("\n")).toContain("Source files were not modified");
		expect(warnings).toHaveLength(0);
		expect(process.exitCode).not.toBe(1);
	});

	it("preserves existing custom excludes when re-adding an Obsidian source without --exclude", async () => {
		const added = addObsidianSource({ root: vault, name: "CLI Vault", excludeGlobs: ["private/**"] }, dir);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		await addObsidianVaultSource(vault, { name: "Renamed CLI Vault", exclude: [] }, { agentsDir: dir });

		const [source] = loadSourcesConfig(dir).sources;
		expect(source?.name).toBe("Renamed CLI Vault");
		expect(source?.excludeGlobs).toContain("private/**");
		expect(logs.join("\n")).toContain("Updated Obsidian source: Renamed CLI Vault");
		expect(process.exitCode).not.toBe(1);
	});

	it("sets a non-zero exit code when removing an unknown source", async () => {
		await removeConfiguredSource("obsidian:missing", { agentsDir: dir });

		expect(errors.join("\n")).toContain("Source not found");
		expect(process.exitCode).toBe(1);
	});
});
