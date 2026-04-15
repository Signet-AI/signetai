import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceSourceRepoPath } from "@signet/core";
import { createAgentsWatcherIgnoreMatcher } from "./watcher-ignore";

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (!dir) continue;
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempAgentsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-watcher-ignore-"));
	tmpDirs.push(dir);
	return dir;
}

describe("createAgentsWatcherIgnoreMatcher", () => {
	it("ignores the default predictor checkpoint", () => {
		const agentsDir = makeTempAgentsDir();
		const shouldIgnore = createAgentsWatcherIgnoreMatcher(agentsDir);

		expect(shouldIgnore(join(agentsDir, "memory", "predictor", "model.bin"))).toBe(true);
		expect(shouldIgnore(join(agentsDir, "memory", "notes.md"))).toBe(false);
	});

	it("ignores a configured predictor checkpoint path", () => {
		const agentsDir = makeTempAgentsDir();
		const customCheckpoint = join(agentsDir, "custom", "predictor.bin");
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`memory:
  pipelineV2:
    predictor:
      checkpointPath: ${customCheckpoint}
`,
		);

		const shouldIgnore = createAgentsWatcherIgnoreMatcher(agentsDir);
		expect(shouldIgnore(customCheckpoint)).toBe(true);
		expect(shouldIgnore(join(agentsDir, "memory", "predictor", "model.bin"))).toBe(true);
	});

	it("ignores the daemon memories.db and its journal files", () => {
		const agentsDir = makeTempAgentsDir();
		const shouldIgnore = createAgentsWatcherIgnoreMatcher(agentsDir);

		expect(shouldIgnore(join(agentsDir, "memory", "memories.db"))).toBe(true);
		expect(shouldIgnore(join(agentsDir, "memory", "memories.db-wal"))).toBe(true);
		expect(shouldIgnore(join(agentsDir, "memory", "memories.db-shm"))).toBe(true);
		expect(shouldIgnore(join(agentsDir, "memory", "memories.db-journal"))).toBe(true);

		// User-managed .db files should NOT be ignored
		expect(shouldIgnore(join(agentsDir, "my-project", "data.db"))).toBe(false);
		expect(shouldIgnore(join(agentsDir, "notes.db"))).toBe(false);
	});

	it("ignores generated per-agent workspace AGENTS.md files", () => {
		const agentsDir = makeTempAgentsDir();
		const shouldIgnore = createAgentsWatcherIgnoreMatcher(agentsDir);

		expect(shouldIgnore(join(agentsDir, "agents", "claude-code", "workspace", "AGENTS.md"))).toBe(true);
		expect(shouldIgnore(join(agentsDir, "agents", "claude-code", "workspace", "nested-project", "AGENTS.md"))).toBe(
			false,
		);
		expect(shouldIgnore(join(agentsDir, "agents-backup", "claude-code", "workspace", "AGENTS.md"))).toBe(false);
		expect(shouldIgnore(join(agentsDir, "agents", "claude-code", "SOUL.md"))).toBe(false);
	});

	it("ignores the managed Signet source checkout and everything under it", () => {
		const agentsDir = makeTempAgentsDir();
		const shouldIgnore = createAgentsWatcherIgnoreMatcher(agentsDir);
		const repoRoot = resolveWorkspaceSourceRepoPath(agentsDir);

		expect(shouldIgnore(repoRoot)).toBe(true);
		expect(shouldIgnore(join(repoRoot, "packages", "core", "src", "index.ts"))).toBe(true);
		expect(shouldIgnore(join(agentsDir, "signetai-notes.md"))).toBe(false);
	});

	it("ignores canonical artifact files inside memory/ directory", () => {
		const agentsDir = makeTempAgentsDir();
		const shouldIgnore = createAgentsWatcherIgnoreMatcher(agentsDir);

		expect(
			shouldIgnore(
				join(agentsDir, "memory", "2026-04-10T12-00-00.000Z--abcdefghijklmnop--summary.md"),
			),
		).toBe(true);
		expect(
			shouldIgnore(
				join(agentsDir, "memory", "2026-04-10T12-00-00.000Z--abcdefghijklmnop--transcript.md"),
			),
		).toBe(true);
		expect(
			shouldIgnore(
				join(agentsDir, "memory", "2026-04-10T12-00-00.000Z--abcdefghijklmnop--manifest.md"),
			),
		).toBe(true);
		expect(
			shouldIgnore(
				join(agentsDir, "memory", "2026-04-10T12-00-00.000Z--abcdefghijklmnop--compaction.md"),
			),
		).toBe(true);
	});

	it("does NOT ignore MEMORY.md inside memory/ directory", () => {
		const agentsDir = makeTempAgentsDir();
		const shouldIgnore = createAgentsWatcherIgnoreMatcher(agentsDir);

		expect(shouldIgnore(join(agentsDir, "memory", "MEMORY.md"))).toBe(false);
	});

	it("ignores backup files inside memory/ directory", () => {
		const agentsDir = makeTempAgentsDir();
		const shouldIgnore = createAgentsWatcherIgnoreMatcher(agentsDir);

		expect(shouldIgnore(join(agentsDir, "memory", "MEMORY.backup-2026-04-10.md"))).toBe(true);
		expect(shouldIgnore(join(agentsDir, "memory", "MEMORY.bak-2026-04-10T12-00-00.md"))).toBe(true);
		expect(shouldIgnore(join(agentsDir, "memory", "MEMORY.pre-v1.2.3.md"))).toBe(true);
	});

	it("does NOT ignore artifact-like filenames outside memory/ directory", () => {
		const agentsDir = makeTempAgentsDir();
		const shouldIgnore = createAgentsWatcherIgnoreMatcher(agentsDir);

		expect(shouldIgnore(join(agentsDir, "2026-04-10T12-00-00.000Z--abcdefghijklmnop--summary.md"))).toBe(false);
		expect(
			shouldIgnore(join(agentsDir, "archive", "2026-04-10T12-00-00.000Z--abcdefghijklmnop--transcript.md")),
		).toBe(false);
		expect(shouldIgnore(join(agentsDir, "MEMORY.backup-2026-04-10.md"))).toBe(false);
	});
});
