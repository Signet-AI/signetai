/**
 * Live Ollama test for dependency-synthesis prompt quality.
 *
 * Override model with SIGNET_OLLAMA_TEST_MODEL, for example:
 * SIGNET_OLLAMA_TEST_MODEL=nemotron-3-nano:4b bun test dependency-synthesis.test.ts
 */

import { describe, expect, test } from "bun:test";
import { DEPENDENCY_TYPES } from "@signet/core";
import { stripFences, tryParseJson } from "./extraction";
import { buildSynthesisPrompt } from "./dependency-synthesis";

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
			options: { temperature: 0.1 },
		}),
	});
	return ((await resp.json()) as { response: string }).response;
}

interface SynthDep {
	readonly target: string;
	readonly depType: string;
	readonly reason: string;
}

function extract(raw: string): readonly SynthDep[] {
	const parsed = tryParseJson(stripFences(raw));
	if (!Array.isArray(parsed)) return [];

	const out: SynthDep[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const obj = item as Record<string, unknown>;
		const target = typeof obj.target === "string" ? obj.target.trim() : "";
		const depType = typeof obj.dep_type === "string" ? obj.dep_type.trim() : "";
		const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
		if (target.length === 0 || !VALID.has(depType)) continue;
		out.push({ target, depType, reason });
	}
	return out;
}

const entity = {
	id: "ent-auth",
	name: "auth service",
	entityType: "system",
};

const facts = [
	"auth service uses Redis for rate limiting and ephemeral session state",
	"auth service is owned by the platform team",
	"auth service informs the audit log of every login attempt",
];

const candidates = [
	{ id: "ent-redis", name: "Redis", entityType: "system", mentions: 9 },
	{ id: "ent-platform", name: "platform team", entityType: "person", mentions: 7 },
	{ id: "ent-audit", name: "audit log", entityType: "system", mentions: 6 },
];

describe(`${MODEL} dependency synthesis`, () => {
	test("prompt encodes candidate boundary and empty-array rules", () => {
		const prompt = buildSynthesisPrompt(entity, facts, candidates, new Set(["Redis"]));
		expect(prompt).toContain("Only connect auth service to entities from the known entity list above");
		expect(prompt).toContain("If no supported connection is stated, return []");
		expect(prompt).toContain("Do not repeat already-connected entities unless the dependency type differs");
	});

	test("prompt yields expected edges for known candidates", async () => {
		if (!EXPLICIT_MODEL) {
			console.log("SKIP: set SIGNET_OLLAMA_TEST_MODEL to run live Ollama tests");
			return;
		}
		const available = await ollamaAvailable();
		if (!available) {
			console.log(`SKIP: ${MODEL} not available on Ollama`);
			return;
		}

		const prompt = buildSynthesisPrompt(entity, facts, candidates, new Set());

		let best: readonly SynthDep[] = [];
		for (let attempt = 0; attempt < 2; attempt++) {
			const deps = extract(await generate(prompt));
			if (deps.length > best.length) best = deps;
			if (best.length >= 3) break;
		}

		const seen = new Set(best.map((d) => `${d.target}|${d.depType}`));
		console.log(best);

		expect(seen.has("Redis|uses")).toBe(true);
		expect(seen.has("platform team|owned_by")).toBe(true);
		expect(seen.has("audit log|informs")).toBe(true);
		for (const dep of best) {
			expect(dep.reason.length).toBeGreaterThan(0);
		}
	}, 120_000);
});
