/**
 * Distillation Layer — Orchestrates deep analysis of perception data.
 *
 * Runs less frequently than refiners (daily/weekly). Synthesizes patterns
 * across many refiner outputs into deeper insights: cognitive profile,
 * expertise graph, agent card, and training context.
 */

import type { RefinerLLMConfig } from "../refiners/base";
import { DEFAULT_REFINER_LLM_CONFIG } from "../refiners/base";
import type {
	CognitiveProfile,
	ExpertiseGraph,
	AgentCard,
	DistillationState,
} from "./types";
import {
	buildCognitiveProfile,
	updateCognitiveProfile,
	loadCognitiveProfile,
} from "./cognitive-profile";
import { buildExpertiseGraph, getExpertiseGraph } from "./expertise-graph";
import {
	generateAgentCard,
	exportAgentCard,
	generateTrainingContext,
	loadMemoriesForCard,
} from "./agent-card";

// ---------------------------------------------------------------------------
// Database interface
// ---------------------------------------------------------------------------

interface DistillationDb {
	prepare(sql: string): {
		all(...args: unknown[]): Record<string, unknown>[];
		get(...args: unknown[]): Record<string, unknown> | undefined;
		run(...args: unknown[]): void;
	};
	exec(sql: string): void;
}

// ---------------------------------------------------------------------------
// Distillation Results
// ---------------------------------------------------------------------------

export interface DistillationResult {
	profile: CognitiveProfile | null;
	graph: ExpertiseGraph | null;
	card: AgentCard | null;
	trainingContext: string | null;
	errors: string[];
	durationMs: number;
}

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Run all distillation steps in order.
 *
 * 1. Build/update cognitive profile (LLM-powered)
 * 2. Build expertise graph (deterministic)
 * 3. Generate agent card + training context
 * 4. Track last run in perception_state
 */
export async function runDistillation(
	db: DistillationDb,
	llmConfig: Partial<RefinerLLMConfig> = {},
): Promise<DistillationResult> {
	const startMs = Date.now();
	const config = { ...DEFAULT_REFINER_LLM_CONFIG, ...llmConfig };
	const errors: string[] = [];

	let profile: CognitiveProfile | null = null;
	let graph: ExpertiseGraph | null = null;
	let card: AgentCard | null = null;
	let trainingContext: string | null = null;

	// 1. Cognitive Profile
	try {
		const existing = loadCognitiveProfile(db);
		if (existing) {
			console.log("[distillation] Updating existing cognitive profile...");
			profile = await updateCognitiveProfile(db, config, existing);
		} else {
			console.log("[distillation] Building initial cognitive profile...");
			profile = await buildCognitiveProfile(db, config);
		}
		console.log(
			`[distillation] Profile built (confidence: ${Math.round(profile.confidenceScore * 100)}%)`,
		);
	} catch (err) {
		const msg = `Cognitive profile failed: ${err instanceof Error ? err.message : String(err)}`;
		console.warn(`[distillation] ${msg}`);
		errors.push(msg);
	}

	// 2. Expertise Graph
	try {
		console.log("[distillation] Building expertise graph...");
		graph = await buildExpertiseGraph(db);
		console.log(
			`[distillation] Graph built: ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
		);
	} catch (err) {
		const msg = `Expertise graph failed: ${err instanceof Error ? err.message : String(err)}`;
		console.warn(`[distillation] ${msg}`);
		errors.push(msg);
	}

	// 3. Agent Card + Training Context
	if (profile) {
		try {
			const memories = loadMemoriesForCard(db);
			card = generateAgentCard(profile, memories);
			trainingContext = generateTrainingContext(profile, memories);
			console.log(
				`[distillation] Agent card generated with ${card.skills.length} skills`,
			);
		} catch (err) {
			const msg = `Agent card failed: ${err instanceof Error ? err.message : String(err)}`;
			console.warn(`[distillation] ${msg}`);
			errors.push(msg);
		}
	}

	// 4. Track last run
	try {
		updateDistillationState(db, {
			lastRun: new Date().toISOString(),
			lastProfileUpdate: profile ? new Date().toISOString() : undefined,
			lastGraphUpdate: graph ? new Date().toISOString() : undefined,
			lastCardGeneration: card ? new Date().toISOString() : undefined,
		});
	} catch {
		// Non-critical
	}

	const durationMs = Date.now() - startMs;
	console.log(
		`[distillation] Complete in ${(durationMs / 1000).toFixed(1)}s` +
			(errors.length > 0 ? ` (${errors.length} errors)` : ""),
	);

	return { profile, graph, card, trainingContext, errors, durationMs };
}

/**
 * Get the current distillation state (last run times).
 */
export function getDistillationState(db: DistillationDb): DistillationState {
	const state: DistillationState = {};

	try {
		const keys = [
			"distillation.lastRun",
			"distillation.lastProfileUpdate",
			"distillation.lastGraphUpdate",
			"distillation.lastCardGeneration",
		];

		for (const key of keys) {
			const row = db
				.prepare(`SELECT value FROM perception_state WHERE key = ?`)
				.get(key) as { value: string } | undefined;

			if (row?.value) {
				const field = key.split(".")[1] as keyof DistillationState;
				state[field] = row.value;
			}
		}
	} catch {
		// Table might not exist
	}

	return state;
}

/**
 * Check if distillation should run (based on time since last run).
 */
export function shouldRunDistillation(
	db: DistillationDb,
	intervalHours: number = 24,
): boolean {
	const state = getDistillationState(db);

	if (!state.lastRun) return true;

	const lastRunMs = new Date(state.lastRun).getTime();
	const elapsedMs = Date.now() - lastRunMs;
	const elapsedHours = elapsedMs / (60 * 60 * 1000);

	return elapsedHours >= intervalHours;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Update distillation state in perception_state table.
 */
function updateDistillationState(
	db: DistillationDb,
	state: Partial<DistillationState>,
): void {
	const now = new Date().toISOString();

	const upsert = db.prepare(
		`INSERT INTO perception_state (key, value, updated_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
	);

	if (state.lastRun) {
		upsert.run("distillation.lastRun", state.lastRun, now);
	}
	if (state.lastProfileUpdate) {
		upsert.run(
			"distillation.lastProfileUpdate",
			state.lastProfileUpdate,
			now,
		);
	}
	if (state.lastGraphUpdate) {
		upsert.run("distillation.lastGraphUpdate", state.lastGraphUpdate, now);
	}
	if (state.lastCardGeneration) {
		upsert.run(
			"distillation.lastCardGeneration",
			state.lastCardGeneration,
			now,
		);
	}
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
	CognitiveProfile,
	WorkingStyle,
	ExpertiseGraph,
	ExpertiseNode,
	ExpertiseEdge,
	ExpertiseDepth,
	AgentCard,
	AgentCardSkill,
	DistillationState,
} from "./types";

export {
	buildCognitiveProfile,
	updateCognitiveProfile,
	loadCognitiveProfile,
} from "./cognitive-profile";

export { analyzeWorkingStyle } from "./working-style";

export {
	buildExpertiseGraph,
	getExpertiseGraph,
	getRelatedSkills,
	getExpertiseDepth,
} from "./expertise-graph";

export {
	generateAgentCard,
	exportAgentCard,
	generateTrainingContext,
	loadMemoriesForCard,
} from "./agent-card";
