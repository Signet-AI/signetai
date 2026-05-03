import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addObsidianSource, getSourcesConfigPath, loadSourcesConfig, removeSource } from "./sources-config";

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

	it("returns a not-found result when removing an unknown source", () => {
		const agentsDir = tmp();
		const removed = removeSource("obsidian:missing", agentsDir);
		expect(removed.ok).toBe(false);
		if (removed.ok === true) throw new Error("expected removeSource to fail");
		expect(removed.error).toContain("not found");
	});
});
