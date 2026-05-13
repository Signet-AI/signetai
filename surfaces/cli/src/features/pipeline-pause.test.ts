import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readOllamaReleaseTargets,
	readPipelinePauseState,
	releaseOllamaModels,
	setPipelinePaused,
} from "./pipeline-pause.js";

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (!dir) continue;
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

describe("pipeline pause config", () => {
	it("writes paused state into agent.yaml", () => {
		const dir = makeTempDir("signet-pipeline-pause-");
		writeFileSync(join(dir, "agent.yaml"), "memory:\n  pipelineV2:\n    enabled: true\n");

		const next = setPipelinePaused(dir, true);
		const raw = readFileSync(join(dir, "agent.yaml"), "utf-8");

		expect(next.exists).toBe(true);
		expect(next.enabled).toBe(true);
		expect(next.paused).toBe(true);
		expect(raw).toContain("paused: true");
	});

	it("preserves explicit disabled state while clearing pause", () => {
		const dir = makeTempDir("signet-pipeline-resume-");
		writeFileSync(join(dir, "agent.yaml"), "memory:\n  pipelineV2:\n    enabled: false\n    paused: true\n");

		const next = setPipelinePaused(dir, false);

		expect(next.enabled).toBe(false);
		expect(next.paused).toBe(false);
	});

	it("reads fallback config files", () => {
		const dir = makeTempDir("signet-pipeline-pause-fallback-");
		writeFileSync(join(dir, "AGENT.yaml"), "memory:\n  pipelineV2:\n    paused: true\n");

		const state = readPipelinePauseState(dir);

		expect(state.exists).toBe(true);
		expect(state.enabled).toBe(true);
		expect(state.paused).toBe(true);
		expect(state.file?.endsWith("AGENT.yaml")).toBe(true);
	});

	it("collects unique local ollama release targets", () => {
		const dir = makeTempDir("signet-pipeline-pause-targets-");
		writeFileSync(
			join(dir, "agent.yaml"),
			[
				"embedding:",
				"  provider: ollama",
				"  model: nomic-embed-text",
				"memory:",
				"  pipelineV2:",
				"    extraction:",
				"      provider: ollama",
				"      model: qwen3:4b",
				"      endpoint: http://127.0.0.1:11434",
				"    synthesis:",
				"      provider: ollama",
				"      model: qwen3:4b",
				"      endpoint: http://127.0.0.1:11434/",
				"",
			].join("\n"),
		);

		const targets = readOllamaReleaseTargets(dir);

		expect(targets).toEqual([
			{
				label: "extraction",
				model: "qwen3:4b",
				baseUrl: "http://127.0.0.1:11434",
			},
			{
				label: "embedding",
				model: "nomic-embed-text",
				baseUrl: "http://127.0.0.1:11434",
			},
		]);
	});

	it("falls back to a valid ollama synthesis model", () => {
		const dir = makeTempDir("signet-pipeline-pause-synthesis-");
		writeFileSync(
			join(dir, "agent.yaml"),
			[
				"memory:",
				"  pipelineV2:",
				"    synthesis:",
				"      provider: ollama",
				"      endpoint: http://127.0.0.1:11434",
				"",
			].join("\n"),
		);

		const targets = readOllamaReleaseTargets(dir);

		expect(targets).toEqual([
			{
				label: "synthesis",
				model: "qwen3:4b",
				baseUrl: "http://127.0.0.1:11434",
			},
		]);
	});

	it("normalizes wildcard ollama endpoints to loopback", () => {
		const dir = makeTempDir("signet-pipeline-pause-wildcard-");
		writeFileSync(
			join(dir, "agent.yaml"),
			[
				"memory:",
				"  pipelineV2:",
				"    extraction:",
				"      provider: ollama",
				"      model: qwen3:4b",
				"      endpoint: http://0.0.0.0:11434",
				"",
			].join("\n"),
		);

		const targets = readOllamaReleaseTargets(dir);

		expect(targets).toEqual([
			{
				label: "extraction",
				model: "qwen3:4b",
				baseUrl: "http://127.0.0.1:11434",
			},
		]);
	});

	it("releases local ollama models through the generate API", async () => {
		const dir = makeTempDir("signet-pipeline-pause-release-");
		writeFileSync(
			join(dir, "agent.yaml"),
			["memory:", "  pipelineV2:", "    extraction:", "      provider: ollama", "      model: qwen3:4b", ""].join(
				"\n",
			),
		);

		const seen: Array<{ readonly body: string; readonly url: string }> = [];
		const results = await releaseOllamaModels(dir, async (input, init) => {
			seen.push({
				url: String(input),
				body: String(init?.body ?? ""),
			});
			return new Response("{}", { status: 200 });
		});

		expect(results).toEqual([
			{
				label: "extraction",
				model: "qwen3:4b",
				baseUrl: "http://127.0.0.1:11434",
				ok: true,
			},
		]);
		expect(seen).toEqual([
			{
				url: "http://127.0.0.1:11434/api/generate",
				body: JSON.stringify({
					model: "qwen3:4b",
					keep_alive: 0,
				}),
			},
		]);
	});
});
