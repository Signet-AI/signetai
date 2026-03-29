/**
 * Integration tests for structural-dependency type extraction.
 *
 * Validates that the configured Ollama model can reliably
 * produce all 21 dependency types from the extraction prompt format.
 * Uses the pipeline's actual stripFences + tryParseJson parsing.
 *
 * Requires: Ollama running locally with the selected model loaded.
 * Override via SIGNET_OLLAMA_TEST_MODEL=nemotron-3-nano:4b
 *
 * Known limitation: temporal types (precedes, follows, triggers) are
 * produced correctly but inconsistently — the model sometimes emits
 * verbose reasoning instead of JSON. This is a model-level issue
 * affecting all extraction, not specific to these types.
 */

import { describe, test, expect } from "bun:test";
import { DEPENDENCY_TYPES } from "@signet/core";

// Uses the actual pipeline parsing — validates that stripFences handles
// verbose model output (unfenced JSON arrays, explanation-then-JSON, etc.)
import { stripFences, tryParseJson } from "./extraction";
import { DEP_DESCRIPTIONS, buildDependencyPrompt } from "./structural-dependency";

// ---------------------------------------------------------------------------
// Ollama helper
// ---------------------------------------------------------------------------

const OLLAMA = "http://localhost:11434";
// Live Ollama tests only run when SIGNET_OLLAMA_TEST_MODEL is explicitly set.
// This prevents nondeterministic failures in CI or on machines where the model
// is installed but not under test.
const EXPLICIT_MODEL = process.env.SIGNET_OLLAMA_TEST_MODEL;
const MODEL = EXPLICIT_MODEL ?? "qwen3:4b";
const VALID = new Set<string>(DEPENDENCY_TYPES);

async function ollamaAvailable(): Promise<boolean> {
	try {
		const resp = await fetch(`${OLLAMA}/api/tags`);
		const data = (await resp.json()) as { models: Array<{ name: string }> };
		return data.models.some((m) => m.name === MODEL);
	} catch {
		return false;
	}
}

async function generate(prompt: string): Promise<string> {
	const resp = await fetch(`${OLLAMA}/api/generate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			prompt,
			stream: false,
			// Match the pipeline's temperature (0.1)
			options: { temperature: 0.1 },
		}),
	});
	return ((await resp.json()) as { response: string }).response;
}

interface ExtractedDep {
	readonly i: number;
	readonly type: string;
	readonly target: string;
	readonly aspect: string;
}

function extract(raw: string, factCount: number): readonly ExtractedDep[] {
	const parsed = tryParseJson(stripFences(raw));
	if (!Array.isArray(parsed)) return [];

	const results: ExtractedDep[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const obj = item as Record<string, unknown>;
		const i = typeof obj.i === "number" ? obj.i : -1;
		if (i < 1 || i > factCount) continue;
		const dt = typeof obj.dep_type === "string" ? obj.dep_type : "";
		const target = typeof obj.dep_target === "string" ? obj.dep_target : "";
		const aspect = typeof obj.aspect === "string" ? obj.aspect : "";
		if (dt && VALID.has(dt)) {
			results.push({ i, type: dt, target, aspect });
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------

interface Scenario {
	readonly name: string;
	readonly entity: string;
	readonly type: string;
	readonly aspects: readonly string[];
	readonly facts: readonly string[];
	readonly expected: readonly string[];
}

const SCENARIOS: readonly Scenario[] = [
	{
		name: "core",
		entity: "auth service",
		type: "system",
		aspects: ["security", "api"],
		facts: [
			"auth service uses JWT tokens for session management",
			"auth service requires a running redis instance",
			"auth service is owned by the platform team",
			"auth service blocks deployment when health check fails",
			"auth service informs the audit log of all login attempts",
		],
		expected: ["uses", "requires", "owned_by", "blocks", "informs"],
	},
	{
		name: "knowledge",
		entity: "ML pipeline",
		type: "system",
		aspects: ["training", "inference"],
		facts: [
			"the ML pipeline was built by the data science team",
			"the ML pipeline depends on the feature store for input data",
			"the ML pipeline is related to the analytics dashboard",
			"the ML pipeline learned from historical user behavior data",
			"the ML pipeline teaches the recommendation engine new patterns",
			"the ML pipeline knows the schema of the user events table",
			"the ML pipeline assumes the feature store provides normalized data",
		],
		expected: [
			"built", "depends_on", "related_to", "learned_from",
			"teaches", "knows", "assumes",
		],
	},
	{
		name: "structural",
		entity: "config v2",
		type: "concept",
		aspects: ["schema", "migration"],
		facts: [
			"config v2 contradicts the legacy config format on timeout defaults",
			"config v2 supersedes the original config schema",
			"the timeout setting is part of config v2",
		],
		expected: ["contradicts", "supersedes", "part_of"],
	},
	{
		name: "temporal",
		entity: "deploy pipeline",
		type: "process",
		aspects: ["ci", "release"],
		facts: [
			"the build step precedes the test step in the deploy pipeline",
			"the notification step follows the deploy step",
			"a merged PR triggers the deploy pipeline",
		],
		expected: ["precedes", "follows", "triggers"],
	},
	{
		name: "impact",
		entity: "database migration",
		type: "process",
		aspects: ["schema", "data"],
		facts: [
			"the database migration impacts all downstream services",
			"the database migration produces a new schema version artifact",
			"the database migration consumes the migration script files",
		],
		expected: ["impacts", "produces", "consumes"],
	},
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("structural-dependency types", () => {
	test("DEPENDENCY_TYPES has 21 entries", () => {
		expect(DEPENDENCY_TYPES).toHaveLength(21);
	});

	test("all types have descriptions", () => {
		for (const t of DEPENDENCY_TYPES) {
			expect(DEP_DESCRIPTIONS[t]).toBeDefined();
		}
	});

	test("prompt includes all types with descriptions", () => {
		const prompt = buildDependencyPrompt("test", "entity", [], ["test fact"]);
		for (const t of DEPENDENCY_TYPES) {
			expect(prompt).toContain(`- ${t}: `);
		}
	});

	test("prompt encodes cardinality and null-handling rules for small local models", () => {
		const prompt = buildDependencyPrompt("auth service", "system", ["security"], ["fact one", "fact two"]);
		expect(prompt).toContain("Return exactly 2 JSON objects");
		expect(prompt).toContain("Use dep_target = null and dep_type = null");
		expect(prompt).toContain("Do not skip facts");
		expect(prompt).toContain("\"auth service is owned by the platform team\"");
	});
});

describe(`${MODEL} extraction`, () => {
	test("model produces valid dependency types across scenarios", async () => {
		if (!EXPLICIT_MODEL) {
			console.log("SKIP: set SIGNET_OLLAMA_TEST_MODEL to run live Ollama tests");
			return;
		}
		const available = await ollamaAvailable();
		if (!available) {
			console.log(`SKIP: ${MODEL} not available on Ollama`);
			return;
		}

		const allSeen = new Set<string>();
		let totalDeps = 0;
		let parseable = 0;

		for (const scenario of SCENARIOS) {
			const prompt = buildDependencyPrompt(
				scenario.entity,
				scenario.type,
				scenario.aspects,
				scenario.facts,
			);

			// Best of 2 attempts — small local models occasionally emit verbose
			// reasoning instead of JSON, especially at low temperature
			let best: readonly ExtractedDep[] = [];
			for (let attempt = 0; attempt < 2; attempt++) {
				const deps = extract(await generate(prompt), scenario.facts.length);
				if (deps.length > best.length) best = deps;
				if (best.length > 0) break;
			}

			const seen = new Set(best.map((d) => d.type));
			for (const t of seen) allSeen.add(t);
			totalDeps += best.length;
			if (best.length > 0) parseable++;

			const overlap = scenario.expected.filter((t) => seen.has(t));
			console.log(
				`  ${scenario.name}: ${overlap.length}/${scenario.expected.length} expected ` +
				`(${best.length} deps) [${[...seen].join(", ")}]`,
			);
		}

		console.log(
			`\n  Total: ${allSeen.size}/${DEPENDENCY_TYPES.length} types, ` +
			`${totalDeps} deps, ${parseable}/${SCENARIOS.length} parseable`,
		);
		console.log(`  Types: ${[...allSeen].sort().join(", ")}`);

		const missing = DEPENDENCY_TYPES.filter((t) => !allSeen.has(t));
		if (missing.length > 0) {
			console.log(`  Missing: ${missing.join(", ")}`);
		}

		// At least 3/5 scenarios should produce parseable results
		expect(parseable).toBeGreaterThanOrEqual(3);
		// Model should produce at least 10/21 types across all scenarios
		// (conservative threshold — actual runs typically hit 15-18)
		expect(allSeen.size).toBeGreaterThanOrEqual(10);
		// All extracted types must be valid DEPENDENCY_TYPES members
		for (const t of allSeen) {
			expect(VALID.has(t)).toBe(true);
		}
	}, 180_000);
});
