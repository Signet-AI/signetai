import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
