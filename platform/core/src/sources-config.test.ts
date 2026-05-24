import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_OBSIDIAN_EXCLUDE_GLOBS,
	addObsidianSource,
	getSourcesConfigPath,
	loadSourcesConfig,
	markSourceIndexed,
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
