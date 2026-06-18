/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
	applyOnboardingConfig,
	identityFileNamesForPreset,
	missingIdentityFiles,
	validateOnboardingStep,
} from "./onboarding-config";
import { createDefaultState } from "./onboarding-state.svelte";

describe("onboarding config persistence", () => {
	it("persists embedding and identity preset file lists into agent config", () => {
		const state = createDefaultState();
		state.identityPreset = "openclaw";
		state.selectedHarnesses = ["codex"];
		state.selectedHarness = "codex";
		state.embeddingProvider = "ollama";
		state.embeddingModel = "mxbai-embed-large";
		state.embeddingEndpoint = "http://127.0.0.1:11434";
		state.extractionProvider = "ollama";
		state.extractionModel = "qwen3:4b";
		state.extractionEndpoint = "http://127.0.0.1:11434";

		const agent: Record<string, unknown> = {};
		applyOnboardingConfig(agent, state);

		expect(agent.embedding).toEqual({
			provider: "ollama",
			model: "mxbai-embed-large",
			dimensions: 1024,
			base_url: "http://127.0.0.1:11434",
		});
		expect(agent.identity).toMatchObject({
			preset: "openclaw",
			startup: {
				load: [
					{ path: "AGENTS.md" },
					{ path: "SOUL.md" },
					{ path: "IDENTITY.md" },
					{ path: "USER.md" },
					{ path: "MEMORY.md" },
				],
			},
			special: [
				{ path: "HEARTBEAT.md", kind: "heartbeat" },
				{ path: "DREAMING.md", kind: "dreaming" },
				{ path: "BOOTSTRAP.md", kind: "bootstrap" },
			],
		});
		expect(agent.memory).toMatchObject({
			pipelineV2: {
				extractionProvider: "ollama",
				extractionEndpoint: "http://127.0.0.1:11434",
			},
		});
		expect(agent.inference).toBeUndefined();
	});

	it("persists selected ACPX harness as the generated inference agent", () => {
		const state = createDefaultState();
		state.selectedHarnesses = ["opencode"];
		state.selectedHarness = "opencode";
		state.extractionProvider = "acpx";
		state.extractionModel = "gpt-5-codex-mini";

		const agent: Record<string, unknown> = {};
		applyOnboardingConfig(agent, state);

		expect(agent.memory).toMatchObject({
			pipelineV2: {
				extraction: { provider: "acpx", harness: "opencode" },
			},
		});
		expect(agent.inference).toMatchObject({
			targets: {
				"background-acpx": {
					acpx: { agent: "opencode" },
				},
			},
		});
	});

	it("removes embedding config when onboarding turns embeddings off", () => {
		const state = createDefaultState();
		state.embeddingProvider = "none";
		state.extractionProvider = "none";
		const agent: Record<string, unknown> = {
			embedding: { provider: "native", model: "nomic-embed-text-v1.5", dimensions: 768 },
		};

		applyOnboardingConfig(agent, state);

		expect(agent.embedding).toBeUndefined();
	});

	it("reports the preset files that must exist for selected identity", () => {
		expect(identityFileNamesForPreset("hermes")).toEqual(["SOUL.md", "AGENTS.md", "DREAMING.md"]);
		expect(
			missingIdentityFiles(
				[
					{ name: "AGENTS.md", content: "", size: 0 },
					{ name: "DREAMING.md", content: "", size: 0 },
				],
				"hermes",
			),
		).toEqual(["SOUL.md"]);
	});

	it("rejects malformed extraction endpoints before save", () => {
		const state = createDefaultState();
		state.extractionProvider = "ollama";
		state.extractionModel = "qwen3:4b";
		state.extractionEndpoint = "localhost:11434";

		expect(validateOnboardingStep(state, 3)).toEqual(["Endpoint must be an http:// or https:// URL."]);
	});
});
