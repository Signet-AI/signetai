import { describe, expect, it } from "bun:test";
import {
	DEPLOYMENT_TYPE_CHOICES,
	defaultEmbeddingProviderForDeployment,
	defaultExtractionProviderForDeployment,
	detectExtractionProviderFromAvailable,
	getDeploymentExtractionGuidance,
	resolveSetupExtractionProvider,
} from "./setup-shared.js";

describe("setup deployment defaults", () => {
	it("supports local, vps, and server deployment choices", () => {
		expect(DEPLOYMENT_TYPE_CHOICES).toEqual(["local", "vps", "server"]);
	});

	it("defaults embedding provider to native across deployment types", () => {
		expect(defaultEmbeddingProviderForDeployment("local")).toBe("native");
		expect(defaultEmbeddingProviderForDeployment("vps")).toBe("native");
		expect(defaultEmbeddingProviderForDeployment("server")).toBe("native");
	});

	it("prefers non-local extraction defaults on vps based on harness availability and detection", () => {
		expect(defaultExtractionProviderForDeployment("vps", "ollama", ["claude-code"])).toBe("claude-code");
		expect(defaultExtractionProviderForDeployment("vps", "none", ["codex"])).toBe("codex");
		expect(defaultExtractionProviderForDeployment("vps", "none", ["opencode"])).toBe("opencode");
		expect(defaultExtractionProviderForDeployment("vps", "codex")).toBe("codex");
		expect(defaultExtractionProviderForDeployment("vps", "none")).toBe("none");
	});

	it("prefers selected harness extraction providers before other detected tooling on vps", () => {
		expect(defaultExtractionProviderForDeployment("vps", "claude-code", ["claude-code", "codex"], ["codex"])).toBe(
			"codex",
		);
		expect(defaultExtractionProviderForDeployment("vps", "none", ["opencode", "claude-code"], ["opencode"])).toBe(
			"opencode",
		);
	});

	it("falls back when selected harness extraction tooling is unavailable on vps", () => {
		expect(defaultExtractionProviderForDeployment("vps", "none", [], ["codex"])).toBe("none");
		expect(defaultExtractionProviderForDeployment("vps", "claude-code", ["claude-code"], ["codex"])).toBe(
			"claude-code",
		);
	});

	it("keeps detected extraction provider for local and server", () => {
		expect(defaultExtractionProviderForDeployment("local", "ollama")).toBe("ollama");
		expect(defaultExtractionProviderForDeployment("server", "codex")).toBe("codex");
	});

	it("preserves local/server detection precedence (ollama before opencode)", () => {
		expect(detectExtractionProviderFromAvailable(["ollama", "opencode"])).toBe("ollama");
		expect(detectExtractionProviderFromAvailable(["claude-code", "ollama", "opencode"])).toBe("claude-code");
		expect(detectExtractionProviderFromAvailable(["opencode"])).toBe("opencode");
		expect(detectExtractionProviderFromAvailable([])).toBe("none");
	});

	it("returns guidance text for each deployment type", () => {
		expect(getDeploymentExtractionGuidance("local").length).toBeGreaterThan(0);
		expect(getDeploymentExtractionGuidance("vps").join(" ").includes("VPS")).toBe(true);
		expect(getDeploymentExtractionGuidance("server").join(" ").includes("Dedicated")).toBe(true);
	});

	it("preserves existing configured providers on migration paths", () => {
		expect(
			resolveSetupExtractionProvider({
				deploymentType: "vps",
				requestedProvider: null,
				providerFromConfig: "ollama",
				preserveExisting: true,
				detectedProvider: "none",
			}),
		).toBe("ollama");
	});

	it("lets explicit provider flags override preserved migration config", () => {
		expect(
			resolveSetupExtractionProvider({
				deploymentType: "vps",
				requestedProvider: "codex",
				providerFromConfig: "ollama",
				preserveExisting: true,
				detectedProvider: "none",
			}),
		).toBe("codex");
	});

	it("applies deployment defaults only when not preserving existing config", () => {
		expect(
			resolveSetupExtractionProvider({
				deploymentType: "vps",
				requestedProvider: null,
				providerFromConfig: "ollama",
				preserveExisting: false,
				detectedProvider: "none",
				availableProviders: ["claude-code"],
				preferredHarnesses: [],
			}),
		).toBe("claude-code");
	});
});
