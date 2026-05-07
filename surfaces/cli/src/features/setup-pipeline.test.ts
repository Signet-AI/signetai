import { describe, expect, it } from "bun:test";
import { buildSetupPipeline, defaultExtractionModel } from "./setup-pipeline";

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
