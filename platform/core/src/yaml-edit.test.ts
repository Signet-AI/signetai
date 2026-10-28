import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editYamlConfigFile } from "./yaml";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-yaml-edit-"));
	dirs.push(dir);
	const path = join(dir, "agent.yaml");
	writeFileSync(path, text);
	return path;
}

describe("editYamlConfigFile", () => {
	it("edits nested keys while keeping comments, other keys and a backup", () => {
		const original = "# my agent\nname: ant # keep me\nmemory:\n  pipelineV2:\n    reranker:\n      topN: 20\n";
		const path = file(original);
		editYamlConfigFile(path, (config) => {
			expect(config.get(["memory", "pipelineV2", "reranker", "topN"])).toBe(20);
			config.set(["memory", "pipelineV2", "reranker", "device"], "cpu");
			config.set(["embedding", "runtime"], "onnxruntime");
		});
		const next = readFileSync(path, "utf8");
		expect(next).toContain("# my agent");
		expect(next).toContain("name: ant # keep me");
		expect(next).toContain("device: cpu");
		expect(next).toContain("runtime: onnxruntime");
		expect(readFileSync(`${path}.bak`, "utf8")).toBe(original);
	});

	it("refuses a file it cannot parse and leaves it untouched", () => {
		const broken = "name: ant\nmemory:\n  pipelineV2: [unclosed\n";
		const path = file(broken);
		expect(() => editYamlConfigFile(path, (config) => config.set(["embedding", "runtime"], "onnxruntime"))).toThrow(
			/not valid YAML/,
		);
		expect(readFileSync(path, "utf8")).toBe(broken);
		expect(existsSync(`${path}.bak`)).toBe(false);
	});

	it("refuses a document whose top level is not a mapping", () => {
		const path = file("- one\n- two\n");
		expect(() => editYamlConfigFile(path, () => {})).toThrow(/mapping/);
	});
});
