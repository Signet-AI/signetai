import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_OBSIDIAN_EXCLUDE_GLOBS,
	addGitHubSource,
	addObsidianSource,
	getSourcesConfigPath,
	loadSourcesConfig,
	markSourceIndexed,
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

	describe("GitHub source", () => {
		it("adds a GitHub source with repos and token ref", () => {
			const agentsDir = tmp();
			const result = addGitHubSource(
				{
					repos: ["Signet-AI/signetai", "Signet-AI/sqmd"],
					name: "Signet Repos",
					tokenRef: "github-pat",
					now: "2026-01-01T00:00:00.000Z",
				},
				agentsDir,
			);
			expect(result.ok).toBe(true);
			if (result.ok === false) throw new Error(result.error);
			expect(result.created).toBe(true);
			expect(result.source.kind).toBe("github");
			expect(result.source.mode).toBe("read-only");
			expect(result.source.enabled).toBe(true);
			expect(result.source.name).toBe("Signet Repos");

			const config = loadSourcesConfig(agentsDir);
			expect(config.sources).toHaveLength(1);
			const settings = parseGitHubSettings(config.sources[0]?.settings);
			expect(settings.repos).toEqual(["Signet-AI/signetai", "Signet-AI/sqmd"]);
			expect(settings.tokenRef).toBe("github-pat");
		});

		it("updates an existing GitHub source instead of duplicating", () => {
			const agentsDir = tmp();
			const first = addGitHubSource(
				{ repos: ["owner/repo"], name: "Repo A", now: "2026-01-01T00:00:00.000Z" },
				agentsDir,
			);
			const second = addGitHubSource(
				{ repos: ["owner/repo"], name: "Repo B", now: "2026-01-02T00:00:00.000Z" },
				agentsDir,
			);
			expect(first.ok).toBe(true);
			expect(second.ok).toBe(true);
			if (second.ok === false) throw new Error(second.error);
			expect(second.created).toBe(false);
			expect(second.source.name).toBe("Repo B");
			expect(loadSourcesConfig(agentsDir).sources).toHaveLength(1);
		});

		it("preserves existing GitHub settings during partial updates", () => {
			const agentsDir = tmp();
			const first = addGitHubSource(
				{
					repos: ["owner/repo"],
					name: "Repo A",
					tokenRef: "GITHUB_TOKEN",
					resourceTypes: ["issues", "discussions"],
					state: "closed",
					includeComments: false,
					labels: ["bug", "needs triage"],
					docPaths: ["docs/setup.md"],
					maxItemsPerRepo: 42,
					now: "2026-01-01T00:00:00.000Z",
				},
				agentsDir,
			);
			expect(first.ok).toBe(true);
			if (first.ok === false) throw new Error(first.error);

			const second = addGitHubSource(
				{ repos: ["owner/repo"], name: "Repo B", now: "2026-01-02T00:00:00.000Z" },
				agentsDir,
			);
			expect(second.ok).toBe(true);
			if (second.ok === false) throw new Error(second.error);

			expect(second.created).toBe(false);
			expect(second.source.name).toBe("Repo B");
			const settings = parseGitHubSettings(second.source.settings);
			expect(settings.tokenRef).toBe("GITHUB_TOKEN");
			expect(settings.resourceTypes).toEqual(["issues", "discussions"]);
			expect(settings.state).toBe("closed");
			expect(settings.includeComments).toBe(false);
			expect(settings.labels).toEqual(["bug", "needs triage"]);
			expect(settings.docPaths).toEqual(["docs/setup.md"]);
			expect(settings.maxItemsPerRepo).toBe(42);
		});

		it("keeps identical GitHub repo sets separate per agent", () => {
			const agentsDir = tmp();
			const first = addGitHubSource(
				{ repos: ["owner/repo"], name: "Agent A Repo", agentId: "agent-a", now: "2026-01-01T00:00:00.000Z" },
				agentsDir,
			);
			const second = addGitHubSource(
				{ repos: ["owner/repo"], name: "Agent B Repo", agentId: "agent-b", now: "2026-01-02T00:00:00.000Z" },
				agentsDir,
			);

			expect(first.ok).toBe(true);
			expect(second.ok).toBe(true);
			if (first.ok === false || second.ok === false) throw new Error("expected both sources to be added");
			expect(first.source.id).not.toBe(second.source.id);
			expect(loadSourcesConfig(agentsDir).sources.map((source) => source.agentId)).toEqual(["agent-a", "agent-b"]);
		});

		it("defaults GitHub sources to the current SIGNET_AGENT_ID when caller omits agentId", () => {
			const agentsDir = tmp();
			const previousAgentId = process.env.SIGNET_AGENT_ID;
			process.env.SIGNET_AGENT_ID = "agent-env";
			try {
				const result = addGitHubSource({ repos: ["owner/repo"], now: "2026-01-01T00:00:00.000Z" }, agentsDir);
				expect(result.ok).toBe(true);
				if (result.ok === false) throw new Error(result.error);
				expect(result.source.agentId).toBe("agent-env");
				expect(loadSourcesConfig(agentsDir).sources[0]?.agentId).toBe("agent-env");
			} finally {
				if (previousAgentId === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
				else process.env.SIGNET_AGENT_ID = previousAgentId;
			}
		});

		it("defaults unauthenticated GitHub sources to REST-fetchable resource types", () => {
			const agentsDir = tmp();
			const result = addGitHubSource({ repos: ["owner/repo"] }, agentsDir);
			expect(result.ok).toBe(true);
			if (result.ok === false) throw new Error(result.error);
			expect(result.source.settings?.resourceTypes).toEqual(["issues", "pulls", "docs"]);
		});

		it("keeps discussion resource types in the default set when a tokenRef is provided", () => {
			const agentsDir = tmp();
			const result = addGitHubSource({ repos: ["owner/repo"], tokenRef: "GITHUB_TOKEN" }, agentsDir);
			expect(result.ok).toBe(true);
			if (result.ok === false) throw new Error(result.error);
			expect(result.source.settings?.resourceTypes).toEqual(["issues", "pulls", "discussions", "docs"]);
		});

		it("rejects an explicit empty GitHub resource type list", () => {
			const agentsDir = tmp();
			const result = addGitHubSource({ repos: ["owner/repo"], resourceTypes: [] }, agentsDir);
			expect(result.ok).toBe(false);
			if (result.ok === true) throw new Error("expected failure");
			expect(result.error).toContain("resourceTypes");
		});

		it("rejects a non-integer GitHub max item limit", () => {
			const agentsDir = tmp();
			const result = addGitHubSource({ repos: ["owner/repo"], maxItemsPerRepo: 1.5 }, agentsDir);
			expect(result.ok).toBe(false);
			if (result.ok === true) throw new Error("expected failure");
			expect(result.error).toContain("integer");
		});

		it("rejects invalid GitHub runtime fields before writing config", () => {
			const agentsDir = tmp();
			const state = addGitHubSource({ repos: ["owner/repo"], state: "draft" as never }, agentsDir);
			expect(state.ok).toBe(false);
			if (state.ok === true) throw new Error("expected state failure");
			expect(state.error).toContain("state");

			const labels = addGitHubSource({ repos: ["owner/repo"], labels: ["bug", 123] as never }, agentsDir);
			expect(labels.ok).toBe(false);
			if (labels.ok === true) throw new Error("expected labels failure");
			expect(labels.error).toContain("labels");

			const comments = addGitHubSource({ repos: ["owner/repo"], includeComments: "yes" as never }, agentsDir);
			expect(comments.ok).toBe(false);
			if (comments.ok === true) throw new Error("expected comments failure");
			expect(comments.error).toContain("includeComments");

			expect(loadSourcesConfig(agentsDir).sources).toEqual([]);
		});

		it("rejects unsafe GitHub doc paths before writing config", () => {
			const agentsDir = tmp();
			for (const docPath of [
				"/README.md",
				"../README.md",
				"docs/../README.md",
				"README.md?ref=dev",
				"src/daemon.ts",
				"docs/openapi.yaml",
			]) {
				const result = addGitHubSource({ repos: ["owner/repo"], docPaths: [docPath] }, agentsDir);
				expect(result.ok).toBe(false);
				if (result.ok === true) throw new Error("expected doc path failure");
				expect(result.error).toContain("docPaths");
			}
			expect(loadSourcesConfig(agentsDir).sources).toEqual([]);
		});

		it("accepts markdown doc paths and markdown globs", () => {
			const agentsDir = tmp();
			for (const docPath of ["README.md", "docs/setup.md", "docs/*.md", "docs/**/*.md"]) {
				const result = addGitHubSource({ repos: ["owner/repo"], docPaths: [docPath] }, agentsDir);
				expect(result.ok).toBe(true);
				if (result.ok === false) throw new Error(result.error);
				removeSource(result.source.id, agentsDir);
			}
		});

		it("drops malformed persisted GitHub sources instead of treating them as empty sources", () => {
			const agentsDir = tmp();
			writeFileSync(
				getSourcesConfigPath(agentsDir),
				JSON.stringify({
					version: 1,
					sources: [
						{
							id: "github:bad",
							kind: "github",
							name: "Bad GitHub",
							root: "",
							enabled: true,
							mode: "read-only",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
						},
					],
				}),
				"utf8",
			);

			expect(loadSourcesConfig(agentsDir).sources).toEqual([]);
		});

		it("drops persisted GitHub sources with invalid resource types instead of widening to defaults", () => {
			const agentsDir = tmp();
			writeFileSync(
				getSourcesConfigPath(agentsDir),
				JSON.stringify({
					version: 1,
					sources: [
						{
							id: "github:bad-types",
							kind: "github",
							name: "Bad GitHub Types",
							root: "",
							enabled: true,
							mode: "read-only",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							settings: { repos: ["owner/repo"], resourceTypes: ["issue"] },
						},
					],
				}),
				"utf8",
			);

			expect(loadSourcesConfig(agentsDir).sources).toEqual([]);
		});

		it("drops persisted GitHub sources without an owning agent", () => {
			const agentsDir = tmp();
			writeFileSync(
				getSourcesConfigPath(agentsDir),
				JSON.stringify({
					version: 1,
					sources: [
						{
							id: "github:unscoped",
							kind: "github",
							name: "Unscoped GitHub",
							root: "",
							enabled: true,
							mode: "read-only",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							settings: { repos: ["owner/repo"] },
						},
					],
				}),
				"utf8",
			);

			expect(loadSourcesConfig(agentsDir).sources).toEqual([]);
		});

		it("drops persisted GitHub sources with non-integer max item limits", () => {
			const agentsDir = tmp();
			writeFileSync(
				getSourcesConfigPath(agentsDir),
				JSON.stringify({
					version: 1,
					sources: [
						{
							id: "github:bad-max",
							kind: "github",
							name: "Bad GitHub Max",
							root: "",
							enabled: true,
							mode: "read-only",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							settings: { repos: ["owner/repo"], maxItemsPerRepo: 1.5 },
						},
					],
				}),
				"utf8",
			);

			expect(loadSourcesConfig(agentsDir).sources).toEqual([]);
		});

		it("drops persisted GitHub sources with unsafe doc paths", () => {
			const agentsDir = tmp();
			writeFileSync(
				getSourcesConfigPath(agentsDir),
				JSON.stringify({
					version: 1,
					sources: [
						{
							id: "github:bad-doc-path",
							kind: "github",
							name: "Bad GitHub Docs",
							root: "",
							enabled: true,
							mode: "read-only",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							agentId: "default",
							settings: { repos: ["owner/repo"], docPaths: ["src/daemon.ts"] },
						},
					],
				}),
				"utf8",
			);

			expect(loadSourcesConfig(agentsDir).sources).toEqual([]);
		});

		it("requires at least one repo", () => {
			const agentsDir = tmp();
			const result = addGitHubSource({ repos: [] }, agentsDir);
			expect(result.ok).toBe(false);
			if (result.ok === true) throw new Error("expected failure");
			expect(result.error).toContain("repo");
		});

		it("coexists with Obsidian sources", () => {
			const agentsDir = tmp();
			const vault = join(agentsDir, "vault");
			mkdirSync(vault, { recursive: true });

			addObsidianSource({ root: vault, name: "My Vault" }, agentsDir);
			addGitHubSource({ repos: ["owner/repo"], name: "GitHub" }, agentsDir);

			const config = loadSourcesConfig(agentsDir);
			expect(config.sources).toHaveLength(2);
			expect(config.sources.map((s) => s.kind)).toEqual(["obsidian", "github"]);
		});

		it("defaults unauthenticated resource types to REST-fetchable types", () => {
			const agentsDir = tmp();
			const result = addGitHubSource({ repos: ["owner/repo"] }, agentsDir);
			expect(result.ok).toBe(true);
			if (result.ok === false) throw new Error(result.error);
			const settings = parseGitHubSettings(loadSourcesConfig(agentsDir).sources[0]?.settings);
			expect(settings.resourceTypes).toEqual(["issues", "pulls", "docs"]);
		});
	});
});
