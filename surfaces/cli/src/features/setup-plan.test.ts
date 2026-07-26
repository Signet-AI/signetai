import { describe, expect, it } from "bun:test";
import { IDENTITY_PRESETS } from "@signet/core";
import { type SetupPlan, parseSetupPlan, setupPlanJsonSchema } from "./setup-plan.js";

function basePlan(overrides: Partial<SetupPlan> = {}): SetupPlan {
	return {
		agentName: "My Agent",
		agentDescription: "Personal AI assistant",
		networkMode: "localhost",
		harnesses: ["claude-code"],
		openclawRuntimePath: "plugin",
		configureOpenClawWs: false,
		embeddingProvider: "native",
		embeddingModel: "nomic-embed-text-v1.5",
		embeddingDimensions: 768,
		extractionProvider: "claude-code",
		extractionModel: "haiku",
		extractionEndpoint: undefined,
		searchBalance: 0.7,
		searchTopK: 20,
		searchMinScore: 0.3,
		memorySessionBudget: 2000,
		memoryDecayRate: 0.95,
		gitEnabled: false,
		signetSecretsEnabled: true,
		graphiqEnabled: false,
		identityMode: "managed",
		identityPreset: "minimal",
		startupIdentityFiles: [...IDENTITY_PRESETS.minimal.startup],
		specialIdentityFiles: [...IDENTITY_PRESETS.minimal.special],
		...overrides,
	};
}

describe("setupPlanSchema", () => {
	it("accepts a well-formed plan", () => {
		const plan = basePlan();
		expect(parseSetupPlan(plan)).toEqual(plan);
	});

	it("accepts a plan with an http openai-compatible endpoint", () => {
		const plan = basePlan({
			extractionProvider: "openai-compatible",
			extractionEndpoint: "http://127.0.0.1:1234/v1",
		});
		expect(parseSetupPlan(plan).extractionEndpoint).toBe("http://127.0.0.1:1234/v1");
	});

	it("accepts identity mode off with empty identity file lists", () => {
		const plan = basePlan({
			identityMode: "off",
			startupIdentityFiles: [],
			specialIdentityFiles: [],
		});
		expect(parseSetupPlan(plan).identityMode).toBe("off");
	});

	it("rejects an out-of-range search balance", () => {
		expect(() => parseSetupPlan(basePlan({ searchBalance: 1.5 }))).toThrow("searchBalance");
	});

	it("rejects a non-positive top_k", () => {
		expect(() => parseSetupPlan(basePlan({ searchTopK: 0 }))).toThrow("searchTopK");
	});

	it("rejects an unknown harness", () => {
		expect(() => parseSetupPlan(basePlan({ harnesses: ["unknown-harness" as never] }))).toThrow();
	});

	it("rejects an unknown identity mode", () => {
		expect(() => parseSetupPlan(basePlan({ identityMode: "ghost" as never }))).toThrow("identityMode");
	});

	it("rejects an unknown extraction provider", () => {
		expect(() => parseSetupPlan(basePlan({ extractionProvider: "bedrock" as never }))).toThrow();
	});

	it("rejects an unknown embedding provider", () => {
		expect(() => parseSetupPlan(basePlan({ embeddingProvider: "voyage" as never }))).toThrow();
	});

	it("rejects a non-integer or negative embedding dimension", () => {
		expect(() => parseSetupPlan(basePlan({ embeddingDimensions: 768.5 }))).toThrow("embeddingDimensions");
		expect(() => parseSetupPlan(basePlan({ embeddingDimensions: -1 }))).toThrow("embeddingDimensions");
	});

	it("rejects a non-positive memory session budget", () => {
		expect(() => parseSetupPlan(basePlan({ memorySessionBudget: 0 }))).toThrow("memorySessionBudget");
	});

	it("rejects an out-of-range search min score", () => {
		expect(() => parseSetupPlan(basePlan({ searchMinScore: 2 }))).toThrow("searchMinScore");
	});

	it("rejects an invalid special-identity session kind", () => {
		const bad = basePlan({
			specialIdentityFiles: [{ path: "DREAMING.md", kind: "naptime" as never }],
		});
		expect(() => parseSetupPlan(bad)).toThrow("kind");
	});

	it("rejects a non-http extraction endpoint", () => {
		expect(() => parseSetupPlan(basePlan({ extractionEndpoint: "ftp://example.test/v1" }))).toThrow(
			"extractionEndpoint",
		);
	});

	it("lists every invalid field when multiple are wrong", () => {
		const bad = basePlan({ searchBalance: 5, memoryDecayRate: -1, identityMode: "ghost" as never });
		try {
			parseSetupPlan(bad);
			throw new Error("should have thrown");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).toContain("searchBalance");
			expect(message).toContain("memoryDecayRate");
			expect(message).toContain("identityMode");
		}
	});

	it("accepts the startup files the openclaw preset produces", () => {
		const plan = basePlan({
			identityPreset: "openclaw",
			startupIdentityFiles: [...IDENTITY_PRESETS.openclaw.startup],
			specialIdentityFiles: [...IDENTITY_PRESETS.openclaw.special],
		});
		const parsed = parseSetupPlan(plan);
		expect(parsed.specialIdentityFiles.some((entry) => entry.kind === "dreaming")).toBe(true);
	});
});

describe("setupPlanJsonSchema", () => {
	it("emits a JSON Schema document with the plan properties", () => {
		const schema = setupPlanJsonSchema() as { properties: Record<string, unknown> };
		expect(schema.properties).toBeDefined();
		for (const key of [
			"agentName",
			"networkMode",
			"harnesses",
			"embeddingProvider",
			"searchBalance",
			"identityPreset",
		]) {
			expect(schema.properties[key]).toBeDefined();
		}
	});

	it("keeps the zod schema and its inferred type in sync", () => {
		// parseSetupPlan returns the same shape setupPlanSchema infers; a
		// round-trip through JSON must stay valid (plan is serializable).
		const plan = basePlan();
		const roundTrip = parseSetupPlan(JSON.parse(JSON.stringify(plan)));
		expect(roundTrip).toEqual(plan);
	});
});
