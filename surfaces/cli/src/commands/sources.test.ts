import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSourcesConfig } from "@signetai/core";
import { Command } from "commander";
import { registerSourcesCommands } from "./sources";

describe("sources CLI commands", () => {
	let dir = "";
	let originalLog: typeof console.log;
	let originalError: typeof console.error;
	let originalWarn: typeof console.warn;
	let previousExitCode: string | number | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-cli-sources-command-"));
		previousExitCode = process.exitCode;
		Reflect.deleteProperty(process, "exitCode");
		originalLog = console.log;
		originalError = console.error;
		originalWarn = console.warn;
		console.log = () => {};
		console.error = () => {};
		console.warn = () => {};
	});

	afterEach(() => {
		console.log = originalLog;
		console.error = originalError;
		console.warn = originalWarn;
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

	it("wires GitHub source adds through the daemon so the initial index job is queued", async () => {
		const calls: Array<{ method: string; path: string; body: unknown; timeoutMs?: number }> = [];
		const program = new Command();
		program.exitOverride();
		registerSourcesCommands(program, {
			agentsDir: dir,
			secretApiCall: async (method, path, body, timeoutMs) => {
				calls.push({ method, path, body, timeoutMs });
				return {
					ok: true,
					data: {
						created: true,
						queued: true,
						source: {
							id: "github:signet-ai-signetai",
							kind: "github",
							name: "GitHub CLI",
							root: "github://repos/Signet-AI/signetai",
							enabled: true,
							mode: "read-only",
							createdAt: "2026-05-24T00:00:00.000Z",
							updatedAt: "2026-05-24T00:00:00.000Z",
							providerSettings: {
								repos: ["Signet-AI/signetai"],
								tokenRef: "gh_token",
								resourceTypes: ["issues"],
							},
						},
						job: { id: "source-index:github:signet-ai-signetai:1" },
					},
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"sources",
			"add",
			"github",
			"--repo",
			"Signet-AI/signetai",
			"--token-ref",
			"gh_token",
			"--resource-type",
			"issues",
			"--max-items",
			"50",
			"--name",
			"GitHub CLI",
		]);

		expect(calls).toEqual([
			{
				method: "POST",
				path: "/api/sources/github",
				timeoutMs: 30_000,
				body: {
					repos: ["Signet-AI/signetai"],
					tokenRef: "gh_token",
					name: "GitHub CLI",
					resourceTypes: ["issues"],
					state: "all",
					includeComments: true,
					labels: [],
					docPaths: [],
					maxItemsPerRepo: 50,
				},
			},
		]);
		expect(loadSourcesConfig(dir).sources).toHaveLength(0);
		expect(process.exitCode).not.toBe(1);
	});

	it("falls back to local GitHub source config when the daemon is unreachable", async () => {
		const calls: Array<{ method: string; path: string }> = [];
		const program = new Command();
		program.exitOverride();
		registerSourcesCommands(program, {
			agentsDir: dir,
			secretApiCall: async (method, path) => {
				calls.push({ method, path });
				return { ok: false, data: { error: "Could not reach Signet daemon" } };
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"sources",
			"add",
			"github",
			"--repo",
			"Signet-AI/signetai",
			"--resource-type",
			"issues",
			"--name",
			"GitHub CLI",
		]);

		const [source] = loadSourcesConfig(dir).sources;
		expect(calls).toEqual([{ method: "POST", path: "/api/sources/github" }]);
		expect(source?.kind).toBe("github");
		expect(source?.providerSettings?.repos).toEqual(["Signet-AI/signetai"]);
		expect(process.exitCode).not.toBe(1);
	});

	it("wires Discord source adds through the daemon so the initial index job is queued", async () => {
		const calls: Array<{ method: string; path: string; body: unknown; timeoutMs?: number }> = [];
		const program = new Command();
		program.exitOverride();
		registerSourcesCommands(program, {
			agentsDir: dir,
			secretApiCall: async (method, path, body, timeoutMs) => {
				calls.push({ method, path, body, timeoutMs });
				return {
					ok: true,
					data: {
						created: true,
						queued: true,
						source: {
							id: "discord:source",
							kind: "discord",
							name: "Discord CLI",
							root: "discord://guilds/123456789012345678",
							enabled: true,
							mode: "read-only",
							createdAt: "2026-05-24T00:00:00.000Z",
							updatedAt: "2026-05-24T00:00:00.000Z",
							providerSettings: { guildIds: ["123456789012345678"], tokenRef: "discord_token" },
						},
						job: { id: "source-index:discord:source:1" },
					},
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"sources",
			"add",
			"discord",
			"--guild",
			"123456789012345678",
			"--token-ref",
			"discord_token",
			"--name",
			"Discord CLI",
			"--attachment-text",
			"--max-attachment-text-bytes",
			"2048",
		]);

		expect(calls).toEqual([
			{
				method: "POST",
				path: "/api/sources/discord",
				timeoutMs: 30_000,
				body: {
					guildIds: ["123456789012345678"],
					tokenRef: "discord_token",
					name: "Discord CLI",
					desktopCachePath: undefined,
					desktopCacheFullScan: undefined,
					channelFilter: [],
					maxMessagesPerChannel: undefined,
					includeThreads: true,
					includeArchivedThreads: true,
					includePrivateArchivedThreads: undefined,
					includeMembers: true,
					includeAttachments: true,
					includeAttachmentText: true,
					maxAttachmentTextBytes: 2048,
					includeEmbeds: true,
					includePolls: true,
					includeThreadMembers: true,
					since: undefined,
					syncMode: "rest",
				},
			},
		]);
		expect(loadSourcesConfig(dir).sources).toHaveLength(0);
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
