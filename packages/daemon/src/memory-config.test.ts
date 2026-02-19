import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemoryConfig } from "./memory-config";

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (!dir) continue;
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempAgentsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-daemon-config-"));
	tmpDirs.push(dir);
	return dir;
}

describe("loadMemoryConfig", () => {
	it("prefers agent.yaml embedding settings over legacy files", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`embedding:
  provider: ollama
  model: all-minilm
  dimensions: 384
`,
		);
		writeFileSync(
			join(agentsDir, "AGENT.yaml"),
			`memory:
  embeddings:
    provider: openai
    model: text-embedding-3-large
    dimensions: 3072
`,
		);

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("ollama");
		expect(cfg.embedding.model).toBe("all-minilm");
		expect(cfg.embedding.dimensions).toBe(384);
	});

	it("falls back to AGENT.yaml memory.embeddings when agent.yaml is missing", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "AGENT.yaml"),
			`memory:
  embeddings:
    provider: openai
    model: text-embedding-3-small
    dimensions: 1536
`,
		);

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("openai");
		expect(cfg.embedding.model).toBe("text-embedding-3-small");
		expect(cfg.embedding.dimensions).toBe(1536);
	});

	it("falls back to config.yaml embeddings for older installs", () => {
		const agentsDir = makeTempAgentsDir();
		writeFileSync(
			join(agentsDir, "config.yaml"),
			`embeddings:
  provider: openai
  model: text-embedding-3-large
  dimensions: 3072
`,
		);

		const cfg = loadMemoryConfig(agentsDir);
		expect(cfg.embedding.provider).toBe("openai");
		expect(cfg.embedding.model).toBe("text-embedding-3-large");
		expect(cfg.embedding.dimensions).toBe(3072);
	});
});
