import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_DISCORD_MAX_ATTACHMENT_TEXT_BYTES,
	DEFAULT_DISCORD_MAX_MESSAGES_PER_CHANNEL,
	DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN,
	DEFAULT_OBSIDIAN_EXCLUDE_GLOBS,
	addDiscordSource,
	addGitHubSource,
	addImportedSource,
	addObsidianSource,
	addWebSource,
	getSourcesConfigPath,
	loadSourcesConfig,
	markSourceIndexed,
	normalizePublicWebUrl,
	parseDiscordSettings,
	parseGitHubSettings,
	parseWebSettings,
	removeSource,
	removeSourceIfGeneration,
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
	it("adds and upserts a validated public web source", () => {
		const agentsDir = tmp();
		const first = addWebSource(
			{ url: "https://example.com/article#tracking", now: "2026-01-01T00:00:00.000Z" },
			agentsDir,
		);
		expect(first.ok).toBe(true);
		if (first.ok === false) throw new Error(first.error);
		expect(first.source.kind).toBe("web");
		expect(first.source.root).toBe("https://example.com/article");
		expect(parseWebSettings(first.source.providerSettings).url).toBe(first.source.root);
		const second = addWebSource(
			{ url: "https://example.com/article", name: "Example", now: "2026-01-02T00:00:00.000Z" },
			agentsDir,
		);
		expect(second.ok).toBe(true);
		if (second.ok === false) throw new Error(second.error);
		expect(second.created).toBe(false);
		expect(second.source.generation).toBe(first.source.generation);
		expect(second.source.name).toBe("Example");
		expect(loadSourcesConfig(agentsDir).sources).toHaveLength(1);
	});

	it("rejects unsafe web source targets", () => {
		const agentsDir = tmp();
		for (const url of [
			"javascript:alert(1)",
			"file:///tmp/a",
			"http://127.0.0.1/a",
			"http://localhost/a",
			"http://169.254.169.254/latest",
		]) {
			const result = addWebSource({ url }, agentsDir);
			expect(result).toEqual({ ok: false, error: "Web page URL must be a public http(s) URL" });
		}
	});
	it("rejects every non-global IP literal, including mapped special-use addresses", () => {
		const nonGlobalUrls = [
			"http://0.0.0.0/",
			"http://10.0.0.1/",
			"http://100.64.0.1/",
			"http://127.0.0.1/",
			"http://169.254.1.1/",
			"http://172.16.0.1/",
			"http://192.0.0.1/",
			"http://192.0.2.1/",
			"http://192.88.99.1/",
			"http://192.168.0.1/",
			"http://192.31.196.1/",
			"http://192.52.193.1/",
			"http://192.175.48.1/",
			"http://198.18.0.1/",
			"http://198.51.100.1/",
			"http://203.0.113.1/",
			"http://224.0.0.1/",
			"http://240.0.0.1/",
			"http://255.255.255.255/",
			"http://[::]/",
			"http://[::1]/",
			"http://[::ffff:8.8.8.8]/",
			"http://[::ffff:6440:1]/",
			"http://[fc00::1]/",
			"http://[fd00::1]/",
			"http://[fe80::1]/",
			"http://[fec0::1]/",
			"http://[ff02::1]/",
			"http://[100::1]/",
			"http://[2001:100::1]/",
			"http://[2001:db8::1]/",
			"http://[2001:30::1]/",
			"http://[2002:0a00:0001::1]/",
			"http://[3fff::1]/",
			"http://[64:ff9b::1]/",
			"http://[2620:4f:8000::1]/",
		];
		for (const url of nonGlobalUrls) expect(normalizePublicWebUrl(url)).toBeNull();

		expect(normalizePublicWebUrl("http://8.8.8.8/")).toBe("http://8.8.8.8/");
		expect(normalizePublicWebUrl("http://[2001:4860:4860::8888]/")).toBe("http://[2001:4860:4860::8888]/");
	});
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

	it("preserves the generation on an ordinary Obsidian update", () => {
		const agentsDir = tmp();
		const vault = join(agentsDir, "vault");
		mkdirSync(vault, { recursive: true });
		const first = addObsidianSource({ root: vault, now: "2026-01-01T00:00:00.000Z" }, agentsDir);
		expect(first.ok).toBe(true);
		if (first.ok === false) throw new Error(first.error);
		const second = addObsidianSource({ root: vault, name: "Updated", now: "2026-01-02T00:00:00.000Z" }, agentsDir);
		expect(second.ok).toBe(true);
		if (second.ok === false) throw new Error(second.error);
		expect(second.source.generation).toBe(first.source.generation);
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
				includeAttachmentText: true,
				maxAttachmentTextBytes: 4096,
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
			includeAttachmentText: true,
			maxAttachmentTextBytes: 4096,
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
			includeAttachmentText: false,
			maxAttachmentTextBytes: DEFAULT_DISCORD_MAX_ATTACHMENT_TEXT_BYTES,
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
			addDiscordSource(
				{
					guildIds: ["123456789012345678"],
					tokenRef: "DISCORD_BOT_TOKEN",
					maxAttachmentTextBytes: 0,
				},
				agentsDir,
			),
		).toEqual({
			ok: false,
			error: "Discord maxAttachmentTextBytes must be an integer between 1 and 1048576",
		});
		expect(
			addDiscordSource(
				{
					guildIds: ["123456789012345678"],
					tokenRef: "DISCORD_BOT_TOKEN",
					includeAttachments: false,
					includeAttachmentText: true,
				},
				agentsDir,
			),
		).toEqual({
			ok: false,
			error: "Discord includeAttachmentText requires includeAttachments",
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
			includeAttachmentText: false,
			maxAttachmentTextBytes: DEFAULT_DISCORD_MAX_ATTACHMENT_TEXT_BYTES,
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

		const loaded = loadSourcesConfig(agentsDir).sources;
		expect(loaded).toHaveLength(1);
		expect(loaded[0]).toMatchObject(source);
		expect(loaded[0]?.generation).toBe("legacy:discord:test:2026-01-01T00:00:00.000Z:2026-01-01T00:00:00.000Z");
		expect(JSON.parse(readFileSync(getSourcesConfigPath(agentsDir), "utf8")).sources[0].generation).toBeUndefined();
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

	it("does not remove a re-added source when the old generation is stale", () => {
		const agentsDir = tmp();
		const vault = join(agentsDir, "vault");
		mkdirSync(vault, { recursive: true });
		const first = addObsidianSource({ root: vault, name: "Vault A", now: "2026-01-01T00:00:00.000Z" }, agentsDir);
		expect(first.ok).toBe(true);
		if (first.ok === false) throw new Error(first.error);
		const removed = removeSource(first.source.id, agentsDir);
		expect(removed.ok).toBe(true);
		const readded = addObsidianSource({ root: vault, name: "Vault A2", now: "2026-01-02T00:00:00.000Z" }, agentsDir);
		expect(readded.ok).toBe(true);
		if (readded.ok === false) throw new Error(readded.error);

		const stale = removeSourceIfGeneration(first.source.id, first.source.generation, agentsDir);

		expect(stale).toEqual({ ok: true, removed: false, source: readded.source });
		expect(loadSourcesConfig(agentsDir).sources).toEqual([readded.source]);
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

		expect(() => loadSourcesConfig(agentsDir)).toThrow("Sources config is not readable JSON");
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

	it("creates imported sources and applies duplicate modes by content hash", () => {
		const agentsDir = tmp();
		const input = {
			fileName: "export.json",
			contentHash: "a".repeat(64),
			format: "json",
			now: "2026-01-01T00:00:00.000Z",
		};

		const first = addImportedSource(input, agentsDir);
		expect(first.ok).toBe(true);
		if (first.ok === false) throw new Error(first.error);
		expect(first.created).toBe(true);
		expect(first.duplicate).toBe(false);
		expect(first.source.kind).toBe("import");
		expect(first.source.providerSettings).toEqual({
			fileName: "export.json",
			contentHash: input.contentHash,
			format: "json",
		});

		const skipped = addImportedSource({ ...input, duplicateMode: "skip" }, agentsDir);
		expect(skipped).toEqual({ ok: true, source: first.source, created: false, duplicate: true });

		const replaced = addImportedSource(
			{ ...input, duplicateMode: "replace", now: "2026-01-02T00:00:00.000Z" },
			agentsDir,
		);
		expect(replaced.ok).toBe(true);
		if (replaced.ok === false) throw new Error(replaced.error);
		expect(replaced.source.id).toBe(first.source.id);
		expect(replaced.created).toBe(false);
		expect(replaced.duplicate).toBe(true);

		const reimported = addImportedSource({ ...input, duplicateMode: "reimport" }, agentsDir);
		expect(reimported.ok).toBe(true);
		if (reimported.ok === false) throw new Error(reimported.error);
		expect(reimported.created).toBe(true);
		expect(reimported.duplicate).toBe(true);
		expect(reimported.source.id).not.toBe(first.source.id);
		expect(loadSourcesConfig(agentsDir).sources).toHaveLength(2);
	});

	it("rejects malformed imported source metadata", () => {
		const agentsDir = tmp();
		expect(addImportedSource({ fileName: "", contentHash: "a".repeat(64), format: "json" }, agentsDir)).toEqual({
			ok: false,
			error: "Imported file name is required",
		});
		expect(
			addImportedSource({ fileName: "export.json", contentHash: "not-a-hash", format: "json" }, agentsDir),
		).toEqual({ ok: false, error: "Imported content hash is invalid" });
	});

	it("does not replace an imported source owned by another agent", () => {
		const agentsDir = tmp();
		const input = {
			fileName: "export.json",
			contentHash: "b".repeat(64),
			format: "json",
			agentId: "agent-a",
		};
		const first = addImportedSource(input, agentsDir);
		expect(first.ok).toBe(true);
		if (first.ok === false) throw new Error(first.error);

		const replaced = addImportedSource({ ...input, agentId: "agent-b", duplicateMode: "replace" }, agentsDir);
		expect(replaced).toMatchObject({ ok: true, created: true, duplicate: false });
		if (replaced.ok === false) throw new Error(replaced.error);
		expect(replaced.source.id).not.toBe(first.source.id);
		expect(loadSourcesConfig(agentsDir).sources).toHaveLength(2);
	});

	it("returns a not-found result when removing an unknown source", () => {
		const agentsDir = tmp();
		const removed = removeSource("obsidian:missing", agentsDir);
		expect(removed.ok).toBe(false);
		if (removed.ok === true) throw new Error("expected removeSource to fail");
		expect(removed.error).toContain("not found");
	});
});
