import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DREAMING, DEFAULT_PIPELINE_V2, loadMemoryConfig } from "../platform/daemon/src/memory-config";
import { writeIsolatedWorkspace } from "./bench-memory";

const workspaces: string[] = [];

afterEach(async () => {
	await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

describe("MemoryBench dreaming profiles", () => {
	test("dreaming-parity writes production dreaming and pipeline defaults", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "signet-memorybench-profile-"));
		workspaces.push(workspace);

		writeIsolatedWorkspace(workspace, "dreaming-parity", "on", "fixture-model", "http://127.0.0.1:8000/v1");

		const config = loadMemoryConfig(workspace);
		const yaml = await readFile(join(workspace, "agent.yaml"), "utf8");

		expect(config.dreaming.tokenThreshold).toBe(DEFAULT_DREAMING.tokenThreshold);
		expect(config.dreaming.maxInputTokens).toBe(DEFAULT_DREAMING.maxInputTokens);
		expect(config.dreaming.maxOutputTokens).toBe(DEFAULT_DREAMING.maxOutputTokens);
		expect(config.pipelineV2.enabled).toBe(DEFAULT_PIPELINE_V2.enabled);
		expect(config.pipelineV2.graph.enabled).toBe(DEFAULT_PIPELINE_V2.graph.enabled);
		expect(config.pipelineV2.traversal.enabled).toBe(DEFAULT_PIPELINE_V2.traversal.enabled);
		expect(yaml).toContain("tokenThreshold: 100000");
		expect(yaml).toContain("maxInputTokens: 128000");
		expect(yaml).toContain("maxOutputTokens: 16000");
		expect(yaml).toContain("  pipelineV2:\n    enabled: true");
	});

	test("the default dreaming profile retains the faster bench configuration", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "signet-memorybench-profile-"));
		workspaces.push(workspace);

		writeIsolatedWorkspace(workspace, "dreaming", "on", "fixture-model", "http://127.0.0.1:8000/v1");

		const config = loadMemoryConfig(workspace);

		expect(config.dreaming.tokenThreshold).toBe(1_000_000);
		expect(config.dreaming.maxInputTokens).toBe(64_000);
		expect(config.dreaming.maxOutputTokens).toBe(32_000);
		expect(config.pipelineV2.enabled).toBe(false);
	});
});
