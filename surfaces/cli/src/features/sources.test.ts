import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addObsidianSource, loadSourcesConfig } from "@signet/core";
import {
	addDiscordSourceFromCli,
	addGitHubSourceFromCli,
	addObsidianVaultSource,
	exportConfiguredSourceSnapshot,
	importConfiguredSourceSnapshot,
	removeConfiguredSource,
} from "./sources";

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

	it("adds a Discord Desktop cache source without requiring bot options", async () => {
		const cachePath = join(dir, "discord");

		await addDiscordSourceFromCli(
			{ name: "CLI Discord Cache", mode: "desktop-cache", desktopCachePath: cachePath, fullCache: true },
			{ agentsDir: dir },
		);

		const [source] = loadSourcesConfig(dir).sources;
		expect(source?.id.startsWith("discord-cache:")).toBe(true);
		expect(source?.root).toBe(cachePath);
		expect(source?.providerSettings?.syncMode).toBe("desktop-cache");
		expect(source?.providerSettings?.desktopCacheFullScan).toBe(true);
		expect(logs.join("\n")).toContain("Added Discord source: CLI Discord Cache");
		expect(logs.join("\n")).toContain("mode: desktop-cache");
		expect(logs.join("\n")).not.toContain("tokenRef:");
		expect(process.exitCode).not.toBe(1);
	});

	it("adds a GitHub source from CLI options", async () => {
		await addGitHubSourceFromCli(
			{
				repo: ["Signet-AI/signetai"],
				resourceType: ["issues", "docs"],
				label: ["sources"],
				docPath: ["docs/API.md"],
				maxItems: "25",
				name: "GitHub CLI",
			},
			{ agentsDir: dir },
		);

		const [source] = loadSourcesConfig(dir).sources;
		expect(source?.kind).toBe("github");
		expect(source?.providerSettings?.repos).toEqual(["Signet-AI/signetai"]);
		expect(source?.providerSettings?.resourceTypes).toEqual(["issues", "docs"]);
		expect(logs.join("\n")).toContain("Added GitHub source: GitHub CLI");
		expect(process.exitCode).not.toBe(1);
	});

	it("rejects malformed GitHub max-items values", async () => {
		await addGitHubSourceFromCli(
			{
				repo: ["Signet-AI/signetai"],
				resourceType: ["issues"],
				maxItems: "25oops",
			},
			{ agentsDir: dir },
		);

		expect(errors.join("\n")).toContain("GitHub max-items must be an integer");
		expect(loadSourcesConfig(dir).sources).toHaveLength(0);
		expect(process.exitCode).toBe(1);
	});

	it("sets a non-zero exit code when removing an unknown source", async () => {
		await removeConfiguredSource("obsidian:missing", { agentsDir: dir });

		expect(errors.join("\n")).toContain("Source not found");
		expect(process.exitCode).toBe(1);
	});

	it("exports a source snapshot from the daemon to a file", async () => {
		const out = join(dir, "snapshot.json");
		await exportConfiguredSourceSnapshot(
			"discord:source",
			{ out },
			{
				agentsDir: dir,
				exportSourceSnapshotFromDaemon: async (sourceId, options) => ({
					ok: true,
					snapshot: { version: 1, source: { id: sourceId }, artifacts: [{ id: "a1" }] },
					artifactCount: 1,
					skippedLocalDiscordArtifacts: options.includeLocalDiscord ? 0 : 2,
				}),
			},
		);

		expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ version: 1, source: { id: "discord:source" } });
		expect(logs.join("\n")).toContain("Exported source snapshot: discord:source");
		expect(errors.join("\n")).toContain("Exported 1 source artifacts");
		expect(errors.join("\n")).toContain("Skipped 2 local Discord @me artifacts");
		expect(process.exitCode).not.toBe(1);
	});

	it("imports a source snapshot through the daemon", async () => {
		const file = join(dir, "snapshot.json");
		await exportConfiguredSourceSnapshot(
			"discord:source",
			{ out: file, includeLocalDiscord: true },
			{
				agentsDir: dir,
				exportSourceSnapshotFromDaemon: async () => ({
					ok: true,
					snapshot: { version: 1, source: { id: "discord:source" }, artifacts: [] },
					artifactCount: 0,
					skippedLocalDiscordArtifacts: 0,
				}),
			},
		);
		logs = [];
		errors = [];

		await importConfiguredSourceSnapshot(
			"discord:source",
			{ file, includeLocalDiscord: true },
			{
				agentsDir: dir,
				importSourceSnapshotToDaemon: async (sourceId, snapshot, options) => ({
					ok: true,
					imported: sourceId === "discord:source" && options.includeLocalDiscord && !!snapshot ? 3 : 0,
					skippedLocalDiscordArtifacts: 0,
				}),
			},
		);

		expect(logs.join("\n")).toContain("Imported source snapshot: discord:source");
		expect(logs.join("\n")).toContain("Imported 3 source artifacts");
		expect(process.exitCode).not.toBe(1);
	});
});
