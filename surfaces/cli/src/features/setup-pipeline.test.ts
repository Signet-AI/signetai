import { describe, expect, it } from "bun:test";
import { buildSetupInference, buildSetupPipeline, defaultExtractionModel } from "./setup-pipeline";

describe("defaultExtractionModel", () => {
	it("prefers the cheap codex mini model", () => {
		expect(defaultExtractionModel("codex")).toBe("gpt-5-codex-mini");
	});

	it("uses qwen3:4b as the ollama floor", () => {
		expect(defaultExtractionModel("ollama")).toBe("qwen3:4b");
	});
});

describe("buildSetupPipeline", () => {
	it("writes an explicit disabled pipeline when extraction is turned off", () => {
		expect(buildSetupPipeline("none")).toEqual({
			enabled: false,
			extraction: {
				provider: "none",
				model: "",
			},
			synthesis: {
				enabled: false,
				provider: "none",
				model: "",
				timeout: 120000,
			},
		});
	});

	it("fills in safe defaults for enabled providers", () => {
		expect(buildSetupPipeline("claude-code")).toEqual({
			enabled: true,
			extraction: {
				provider: "claude-code",
				model: "haiku",
			},
			synthesis: {
				enabled: true,
				provider: "claude-code",
				model: "haiku",
				timeout: 120000,
			},
			semanticContradictionEnabled: true,
			graph: { enabled: true },
			reranker: { enabled: true },
			autonomous: {
				enabled: true,
				allowUpdateDelete: true,
				maintenanceMode: "execute",
			},
		});
	});

	it("copies the selected extraction provider into explicit synthesis config", () => {
		expect(buildSetupPipeline("ollama", "qwen3.5:4b").synthesis).toEqual({
			enabled: true,
			provider: "ollama",
			model: "qwen3.5:4b",
			timeout: 120000,
		});
	});
});

describe("buildSetupInference", () => {
	it("writes ACPX as explicit inference routing with the selected harness agent", () => {
		const inference = buildSetupInference("acpx", "gpt-5-codex-mini", ["opencode", "codex"]);
		expect(inference?.targets["background-acpx"]).toMatchObject({
			executor: "acpx",
			acpx: {
				agent: "opencode",
				version: "0.7.0",
				hooks: "disabled",
				permissions: "deny-all",
				terminal: "inherit",
			},
		});
		expect(inference?.workloads.memoryExtraction).toEqual({
			target: "background-acpx/default",
			taskClass: "memory_extraction",
		});
	});

	it("selects ACPX agent from detected providers when no harness was selected", () => {
		const inference = buildSetupInference("acpx", "haiku", [], ["acpx", "claude-code"]);
		expect(inference?.targets["background-acpx"]).toMatchObject({
			executor: "acpx",
			acpx: { agent: "claude-code" },
		});
	});
});
