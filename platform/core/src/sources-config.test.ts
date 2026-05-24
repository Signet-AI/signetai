import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_DISCORD_MAX_MESSAGES_PER_CHANNEL,
	DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN,
	DEFAULT_OBSIDIAN_EXCLUDE_GLOBS,
	addDiscordSource,
	addGitHubSource,
	addObsidianSource,
	getSourcesConfigPath,
	loadSourcesConfig,
	markSourceIndexed,
	parseDiscordSettings,
	parseGitHubSettings,
	removeSource,
} from "./sources-config";

let dir = "";

afterEach(() => {
	dir = "";
});

function tmp(): string {
	dir = mkdtempSync(join(tmpdir(), "signet-sources-"));
	return dir;
}

describe("sources-config", () => {
	it("adds an Obsidian vault source as read-only config", () => {
		const agentsDir = tmp();
		const vault = join(agentsDir, "vault");
		mkdirSync(vault, { recursive: true });

		const result = addObsidianSource(
			{ root: vault, name: "Research Vault", now: "2026-01-01T00:00:00.000Z" },
			agentsDir,
		);

		expect(result.ok).toBe(true);
		if (result.ok === false) throw new Error(result.error);
		expect(result.created).toBe(true);
		expect(result.source.kind).toBe("obsidian");
		expect(result.source.mode).toBe("read-only");
		expect(result.source.enabled).toBe(true);
		expect(result.source.name).toBe("Research Vault");

		const config = loadSourcesConfig(agentsDir);
		expect(config.sources).toHaveLength(1);
		expect(config.sources[0]?.root).toBe(vault);
		expect(JSON.parse(readFileSync(getSourcesConfigPath(agentsDir), "utf8")).sources[0].mode).toBe("read-only");
	});

	it("merges custom Obsidian excludes with default privacy excludes", () => {
		const agentsDir = tmp();
		const vault = join(agentsDir, "vault");
		mkdirSync(vault, { recursive: true });

		const result = addObsidianSource({ root: vault, excludeGlobs: ["private/**", "**/.obsidian/**"] }, agentsDir);

		expect(result.ok).toBe(true);
		if (result.ok === false) throw new Error(result.error);
		expect(result.source.excludeGlobs).toEqual([...DEFAULT_OBSIDIAN_EXCLUDE_GLOBS, "private/**"]);
	});

	it("updates an existing Obsidian source instead of duplicating it", () => {
		const agentsDir = tmp();
		const vault = join(agentsDir, "vault");
		mkdirSync(vault, { recursive: true });

		const first = addObsidianSource({ root: vault, name: "Vault A", now: "2026-01-01T00:00:00.000Z" }, agentsDir);
		const second = addObsidianSource({ root: vault, name: "Vault B", now: "2026-01-02T00:00:00.000Z" }, agentsDir);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (second.ok === false) throw new Error(second.error);
		expect(second.created).toBe(false);
		expect(second.source.name).toBe("Vault B");
		expect(loadSourcesConfig(agentsDir).sources).toHaveLength(1);
	});

	it("adds a Discord source with validated provider settings", () => {
		const agentsDir = tmp();

		const result = addDiscordSource(
			{
				guildIds: ["123456789012345678", "223456789012345678", "123456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				name: "Team Discord",
				channelFilter: ["general", "323456789012345678", "general"],
				maxMessagesPerChannel: 250,
				includePrivateArchivedThreads: true,
				since: "2026-01-01",
				now: "2026-01-02T00:00:00.000Z",
			},
			agentsDir,
		);

		expect(result.ok).toBe(true);
		if (result.ok === false) throw new Error(result.error);
		expect(result.created).toBe(true);
		expect(result.source.kind).toBe("discord");
		expect(result.source.root).toBe("discord://guilds/123456789012345678,223456789012345678");
		expect(result.source.providerSettings).toEqual({
			guildIds: ["123456789012345678", "223456789012345678"],
			tokenRef: "DISCORD_BOT_TOKEN",
			channelFilter: ["general", "323456789012345678"],
			maxMessagesPerChannel: 250,
			includeThreads: true,
			includeArchivedThreads: true,
			includePrivateArchivedThreads: true,
			includeMembers: true,
			includeAttachments: true,
			includeEmbeds: true,
			includePolls: true,
			includeThreadMembers: true,
			since: "2026-01-01T00:00:00.000Z",
			syncMode: "rest",
		});
		expect(loadSourcesConfig(agentsDir).sources).toHaveLength(1);
	});

	it("adds a Discord desktop cache source without a bot token", () => {
		const agentsDir = tmp();
		const desktopCachePath = join(agentsDir, "discord");

		const result = addDiscordSource(
			{
				guildIds: [],
				name: "Local Discord Cache",
				desktopCachePath,
				desktopCacheFullScan: true,
				syncMode: "desktop-cache",
				now: "2026-01-02T00:00:00.000Z",
			},
			agentsDir,
		);

		expect(result.ok).toBe(true);
		if (result.ok === false) throw new Error(result.error);
		expect(result.source.id.startsWith("discord-cache:")).toBe(true);
		expect(result.source.root).toBe(desktopCachePath);
		expect(result.source.providerSettings).toEqual({
			guildIds: [],
			tokenRef: "",
			desktopCachePath,
			desktopCacheFullScan: true,
			maxMessagesPerChannel: DEFAULT_DISCORD_MAX_MESSAGES_PER_CHANNEL,
			includeThreads: true,
			includeArchivedThreads: true,
			includePrivateArchivedThreads: false,
			includeMembers: true,
			includeAttachments: true,
			includeEmbeds: true,
			includePolls: true,
			includeThreadMembers: true,
			syncMode: "desktop-cache",
		});
	});

	it("updates an existing Discord source instead of duplicating it", () => {
		const agentsDir = tmp();
		const first = addDiscordSource(
			{
				guildIds: ["123456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				name: "Discord A",
				now: "2026-01-01T00:00:00.000Z",
			},
			agentsDir,
		);
		const second = addDiscordSource(
			{
				guildIds: ["123456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				name: "Discord B",
				maxMessagesPerChannel: 10,
				now: "2026-01-02T00:00:00.000Z",
			},
			agentsDir,
		);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (second.ok === false) throw new Error(second.error);
		expect(second.created).toBe(false);
		expect(second.source.name).toBe("Discord B");
		expect(parseDiscordSettings(second.source.providerSettings).maxMessagesPerChannel).toBe(10);
		expect(loadSourcesConfig(agentsDir).sources).toHaveLength(1);
	});

	it("rejects Discord desktop cache paths outside known Desktop data roots", () => {
		const result = addDiscordSource(
			{
				name: "Local Discord Cache",
				desktopCachePath: join(tmp(), "documents"),
				syncMode: "desktop-cache",
			},
			tmp(),
		);

		expect(result.ok).toBe(false);
		if (result.ok === true) throw new Error("expected invalid desktop cache path");
		expect(result.error).toContain("Discord desktopCachePath must point at a Discord Desktop data directory");
	});

	it("rejects invalid Discord source boundaries", () => {
		const agentsDir = tmp();

		expect(addDiscordSource({ guildIds: [], tokenRef: "DISCORD_BOT_TOKEN" }, agentsDir)).toEqual({
			ok: false,
			error: "At least one Discord guild ID is required",
		});
		expect(addDiscordSource({ guildIds: ["bad"], tokenRef: "DISCORD_BOT_TOKEN" }, agentsDir)).toEqual({
			ok: false,
			error: "Invalid Discord guild ID: bad",
		});
		expect(
			addDiscordSource(
				{
					guildIds: ["123456789012345678"],
					tokenRef: "MzI0NzY5ODEwMDc4NzQ3NjY4.GbM8rb.fakeFakeFakeFakeFakeFakeFakeFake",
				},
				agentsDir,
			),
		).toEqual({ ok: false, error: "Discord tokenRef must be a secret reference, not a raw token" });
		for (const tokenRef of [
			"Bot MzI0NzY5ODEwMDc4NzQ3NjY4.GbM8rb.fakeFakeFakeFakeFakeFakeFakeFake",
			"Authorization: Bot MzI0NzY5ODEwMDc4NzQ3NjY4.GbM8rb.fakeFakeFakeFakeFakeFakeFakeFake",
			`mfa.${"a".repeat(84)}`,
			`Bearer mfa.${"b".repeat(84)}`,
		]) {
			expect(addDiscordSource({ guildIds: ["123456789012345678"], tokenRef }, agentsDir)).toEqual({
				ok: false,
				error: "Discord tokenRef must be a secret reference, not a raw token",
			});
		}
		expect(
			addDiscordSource(
				{
					guildIds: ["123456789012345678"],
					tokenRef: "DISCORD_BOT_TOKEN",
					maxMessagesPerChannel: 0,
				},
				agentsDir,
			),
		).toEqual({
			ok: false,
			error: "Discord maxMessagesPerChannel must be an integer between 1 and 10000",
		});
		expect(
			addDiscordSource({ guildIds: ["123456789012345678"], tokenRef: "DISCORD_BOT_TOKEN", since: "nope" }, agentsDir),
		).toEqual({ ok: false, error: "Discord since must be a valid ISO date" });
	});

	it("parses persisted Discord settings with safe defaults", () => {
		expect(
			parseDiscordSettings({
				guildIds: ["123456789012345678"],
				tokenRef: "DISCORD_BOT_TOKEN",
				maxMessagesPerChannel: -1,
				includeThreads: false,
				syncMode: "gateway-tail",
			}),
		).toEqual({
			guildIds: ["123456789012345678"],
			tokenRef: "DISCORD_BOT_TOKEN",
			desktopCacheFullScan: false,
			maxMessagesPerChannel: DEFAULT_DISCORD_MAX_MESSAGES_PER_CHANNEL,
			includeThreads: false,
			includeArchivedThreads: true,
			includePrivateArchivedThreads: false,
			includeMembers: true,
			includeAttachments: true,
			includeEmbeds: true,
			includePolls: true,
			includeThreadMembers: true,
			syncMode: "gateway-tail",
		});
	});

	it("adds a GitHub source with validated provider settings", () => {
		const agentsDir = tmp();

		const result = addGitHubSource(
			{
				repos: ["Signet-AI/signetai", "Signet-AI/signetai"],
				tokenRef: "GITHUB_TOKEN",
				name: "Signet GitHub",
				resourceTypes: ["issues", "pulls", "discussions", "docs"],
				state: "open",
				labels: ["bug", "needs review", "bug"],
				docPaths: ["README.md", "docs/**/*.md"],
				maxItemsPerRepo: 25,
				now: "2026-01-02T00:00:00.000Z",
			},
			agentsDir,
		);

		expect(result.ok).toBe(true);
		if (result.ok === false) throw new Error(result.error);
		expect(result.source.kind).toBe("github");
		expect(result.source.root).toBe("github://repos/Signet-AI/signetai");
		expect(result.source.providerSettings).toEqual({
			repos: ["Signet-AI/signetai"],
			tokenRef: "GITHUB_TOKEN",
			resourceTypes: ["issues", "pulls", "discussions", "docs"],
			state: "open",
			includeComments: true,
			labels: ["bug", "needs review"],
			docPaths: ["README.md", "docs/**/*.md"],
			maxItemsPerRepo: 25,
		});
	});

	it("defaults GitHub sources without tokenRef to REST-fetchable resources", () => {
		const result = addGitHubSource({ repos: ["Signet-AI/signetai"] }, tmp());

		expect(result.ok).toBe(true);
		if (result.ok === false) throw new Error(result.error);
		expect(parseGitHubSettings(result.source.providerSettings).resourceTypes).toEqual([
			...DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN,
		]);
	});

	it("preserves GitHub settings on partial update", () => {
		const agentsDir = tmp();
		const first = addGitHubSource(
			{
				repos: ["Signet-AI/signetai"],
				tokenRef: "GITHUB_TOKEN",
				resourceTypes: ["issues", "discussions"],
				labels: ["reviewed"],
				docPaths: ["docs/API.md"],
				maxItemsPerRepo: 12,
				now: "2026-01-01T00:00:00.000Z",
			},
			agentsDir,
		);
		const second = addGitHubSource(
			{ repos: ["Signet-AI/signetai"], name: "Renamed", now: "2026-01-02T00:00:00.000Z" },
			agentsDir,
		);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (second.ok === false) throw new Error(second.error);
		expect(second.created).toBe(false);
		expect(second.source.name).toBe("Renamed");
		expect(parseGitHubSettings(second.source.providerSettings)).toMatchObject({
			tokenRef: "GITHUB_TOKEN",
			resourceTypes: ["issues", "discussions"],
			labels: ["reviewed"],
			docPaths: ["docs/API.md"],
			maxItemsPerRepo: 12,
		});
		expect(loadSourcesConfig(agentsDir).sources).toHaveLength(1);
	});

	it("rejects invalid GitHub source boundaries", () => {
		const agentsDir = tmp();

		expect(addGitHubSource({ repos: [] }, agentsDir)).toEqual({
			ok: false,
			error: "At least one GitHub repo pattern is required",
		});
		expect(addGitHubSource({ repos: ["not-a-repo"] }, agentsDir)).toEqual({
			ok: false,
			error: "Invalid GitHub repo pattern: not-a-repo. Expected owner/repo or owner/*",
		});
		expect(addGitHubSource({ repos: ["Signet-AI/signetai"], resourceTypes: ["discussions"] }, agentsDir)).toEqual({
			ok: false,
			error: "GitHub discussions require tokenRef because they use the GitHub GraphQL API",
		});
		for (const tokenRef of [
			`ghp_${"a".repeat(36)}`,
			`github_pat_${"b".repeat(60)}`,
			`Bearer ghp_${"c".repeat(36)}`,
			`Authorization: token ghp_${"d".repeat(36)}`,
		]) {
			expect(addGitHubSource({ repos: ["Signet-AI/signetai"], tokenRef }, agentsDir)).toEqual({
				ok: false,
				error: "GitHub tokenRef must be a secret reference, not a raw token",
			});
		}
		expect(addGitHubSource({ repos: ["Signet-AI/signetai"], docPaths: ["src/daemon.ts"] }, agentsDir)).toEqual({
			ok: false,
			error: "Invalid GitHub docPaths: src/daemon.ts",
		});
		expect(addGitHubSource({ repos: ["Signet-AI/signetai"], maxItemsPerRepo: 0 }, agentsDir)).toEqual({
			ok: false,
			error: "GitHub maxItemsPerRepo must be an integer between 1 and 10000",
		});
	});

	it("round-trips provider-neutral source settings for future adapters", () => {
		const agentsDir = tmp();
		const source = {
			id: "discord:test",
			kind: "discord",
			name: "Discord",
			root: "discord://workspace",
			enabled: true,
			mode: "read-only" as const,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			providerSettings: {
				guildIds: ["123", "456"],
				includeThreads: true,
			},
		};
		writeFileSync(getSourcesConfigPath(agentsDir), `${JSON.stringify({ version: 1, sources: [source] })}\n`);

		expect(loadSourcesConfig(agentsDir).sources).toEqual([source]);
	});

	it("removes a source by id from the config", () => {
		const agentsDir = tmp();
		const vault = join(agentsDir, "vault");
		mkdirSync(vault, { recursive: true });
		const added = addObsidianSource({ root: vault, name: "Vault A", now: "2026-01-01T00:00:00.000Z" }, agentsDir);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		const removed = removeSource(added.source.id, agentsDir);

		expect(removed.ok).toBe(true);
		if (removed.ok === false) throw new Error(removed.error);
		expect(removed.source.id).toBe(added.source.id);
		expect(loadSourcesConfig(agentsDir).sources).toEqual([]);
	});

	it("uses unique temp files and leaves no stale lock or tmp files after sequential mutations", () => {
		const agentsDir = tmp();
		const vaultA = join(agentsDir, "vault-a");
		const vaultB = join(agentsDir, "vault-b");
		mkdirSync(vaultA, { recursive: true });
		mkdirSync(vaultB, { recursive: true });

		const first = addObsidianSource({ root: vaultA, name: "Vault A" }, agentsDir);
		const second = addObsidianSource({ root: vaultB, name: "Vault B" }, agentsDir);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (first.ok === false || second.ok === false) throw new Error("expected sources to be added");

		markSourceIndexed(first.source.id, "2026-01-03T00:00:00.000Z", agentsDir);
		const removed = removeSource(second.source.id, agentsDir);
		expect(removed.ok).toBe(true);

		const cfg = loadSourcesConfig(agentsDir);
		expect(cfg.sources.map((source) => source.id)).toEqual([first.source.id]);
		expect(cfg.sources[0]?.lastIndexedAt).toBe("2026-01-03T00:00:00.000Z");
		expect(
			readdirSync(agentsDir).some((name) => name.includes("sources.json.tmp") || name === "sources.json.lock"),
		).toBe(false);
	});

	it("refuses to overwrite a corrupt sources config during mutating operations", () => {
		const agentsDir = tmp();
		const vault = join(agentsDir, "vault");
		mkdirSync(vault, { recursive: true });
		const configPath = getSourcesConfigPath(agentsDir);
		writeFileSync(configPath, "{ not valid json", "utf8");

		expect(loadSourcesConfig(agentsDir).sources).toEqual([]);
		const result = addObsidianSource({ root: vault, name: "Vault A" }, agentsDir);

		expect(result.ok).toBe(false);
		if (result.ok === true) throw new Error("expected addObsidianSource to fail");
		expect(result.error).toContain("refusing to overwrite");
		expect(readFileSync(configPath, "utf8")).toBe("{ not valid json");
	});

	it("refuses to remove sources when the config is corrupt", () => {
		const agentsDir = tmp();
		const configPath = getSourcesConfigPath(agentsDir);
		writeFileSync(configPath, "{ not valid json", "utf8");

		const removed = removeSource("obsidian:any", agentsDir);

		expect(removed.ok).toBe(false);
		if (removed.ok === true) throw new Error("expected removeSource to fail");
		expect(removed.error).toContain("refusing to overwrite");
		expect(readFileSync(configPath, "utf8")).toBe("{ not valid json");
	});

	it("returns a not-found result when removing an unknown source", () => {
		const agentsDir = tmp();
		const removed = removeSource("obsidian:missing", agentsDir);
		expect(removed.ok).toBe(false);
		if (removed.ok === true) throw new Error("expected removeSource to fail");
		expect(removed.error).toContain("not found");
	});
});
