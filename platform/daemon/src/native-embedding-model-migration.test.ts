import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NATIVE_EMBEDDING_DIMENSIONS, DEFAULT_NATIVE_EMBEDDING_MODEL } from "@signet/core";
import { migrateNativeEmbeddingModel } from "./config-migration";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function migrate(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-embedding-migration-"));
	dirs.push(dir);
	writeFileSync(join(dir, "agent.yaml"), contents);
	migrateNativeEmbeddingModel(dir);
	return readFileSync(join(dir, "agent.yaml"), "utf8");
}

describe("native embedding model migration", () => {
	it("moves only the exact legacy native default to MiniLM", () => {
		const result = migrate(`configVersion: 4
embedding:
  provider: native
  model: nomic-embed-text-v1.5
  dimensions: 768
`);
		expect(result).toContain(`model: ${DEFAULT_NATIVE_EMBEDDING_MODEL}`);
		expect(result).toContain(`dimensions: ${DEFAULT_NATIVE_EMBEDDING_DIMENSIONS}`);
		expect(result).toMatch(/^configVersion: 5/m);
	});

	it("preserves custom native models and dimensions", () => {
		const result = migrate(`configVersion: 4
embedding:
  provider: native
  model: owner/custom-model
  dimensions: 512
`);
		expect(result).toContain("model: owner/custom-model");
		expect(result).toContain("dimensions: 512");
	});

	it("is idempotent", () => {
		const first = migrate(`configVersion: 4
embedding:
  provider: native
  model: nomic-ai/nomic-embed-text-v1.5
  dimensions: 768
`);
		const dir = mkdtempSync(join(tmpdir(), "signet-embedding-migration-idempotent-"));
		dirs.push(dir);
		writeFileSync(join(dir, "agent.yaml"), first);
		migrateNativeEmbeddingModel(dir);
		expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(first);
	});
});
