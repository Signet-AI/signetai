/**
 * Cognitive Profile Builder
 *
 * Analyzes accumulated Signet memories to build a comprehensive user profile.
 * Uses the same LLM calling pattern as refiners/base.ts (Ollama HTTP API).
 *
 * The profile captures problem-solving style, communication preferences,
 * work patterns, tool preferences, expertise, and decision-making tendencies.
 */

import type { CognitiveProfile, WorkingStyle } from "./types";
import { analyzeWorkingStyle } from "./working-style";
import type { RefinerLLMConfig } from "../refiners/base";
import { DEFAULT_REFINER_LLM_CONFIG } from "../refiners/base";

// ---------------------------------------------------------------------------
// Database interface (accepts raw SQLite db)
// ---------------------------------------------------------------------------

interface ProfileDb {
	prepare(sql: string): {
		all(...args: unknown[]): Record<string, unknown>[];
		get(...args: unknown[]): Record<string, unknown> | undefined;
		run(...args: unknown[]): void;
	};
}

// ---------------------------------------------------------------------------
// LLM System Prompts
// ---------------------------------------------------------------------------

const PROFILE_SYNTHESIS_PROMPT = `You are analyzing a user's collected memories and observations to build a cognitive profile — a comprehensive picture of how they think, work, and communicate.

You will receive categorized memories about their skills, decisions, procedures, preferences, and work patterns.

Produce a JSON object with this exact structure:

{
  "problemSolving": {
    "approach": "systematic" | "exploratory" | "collaborative" | "intuitive",
    "debuggingStyle": "string describing their debugging approach",
    "researchDepth": "surface" | "moderate" | "deep",
    "prefersTryFirst": true | false
  },
  "communication": {
    "verbosity": "terse" | "moderate" | "detailed",
    "formality": "casual" | "professional" | "technical",
    "preferredFormats": ["array", "of", "formats"],
    "documentationHabits": "string describing documentation habits"
  },
  "toolPreferences": {
    "editor": "detected editor name or unknown",
    "terminal": "detected terminal or unknown",
    "prefersCLI": true | false,
    "automationLevel": "manual" | "scripts" | "heavy-automation"
  },
  "expertise": {
    "primaryDomains": ["domains"],
    "languages": ["programming languages"],
    "frameworks": ["frameworks"],
    "weakAreas": ["areas they struggle with"]
  },
  "decisionMaking": {
    "speed": "quick" | "deliberate" | "analysis-paralysis",
    "revisitsDecisions": true | false,
    "riskTolerance": "conservative" | "moderate" | "bold"
  },
  "confidenceScore": 0.0-1.0
}

Rules:
- Only include claims supported by the evidence in the memories
- If you don't have enough evidence for a field, use reasonable defaults and lower the confidenceScore
- Be specific in string fields (e.g., debuggingStyle should be something like "logs-first, adds console.log before debugger" not just "good")
- The confidenceScore should reflect how much data you had to work with (0.3 = very little, 0.7 = moderate, 0.9 = extensive)
- Return ONLY the JSON object, no explanation`;

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Build a full cognitive profile from all available memories.
 */
export async function buildCognitiveProfile(
	db: ProfileDb,
	llmConfig: Partial<RefinerLLMConfig> = {},
): Promise<CognitiveProfile> {
	const config = { ...DEFAULT_REFINER_LLM_CONFIG, ...llmConfig };

	// 1. Query relevant memories by type/tags
	const memories = queryProfileMemories(db);

	// 2. Get working style from raw perception data
	const workingStyle = await analyzeWorkingStyle(db);

	// 3. Build context for LLM
	const context = formatMemoriesForProfile(memories, workingStyle);

	// 4. Synthesize via LLM
	const rawResponse = await callLLM(
		config,
		PROFILE_SYNTHESIS_PROMPT,
		context,
	);

	// 5. Parse and merge with working style data
	const profile = parseProfileResponse(rawResponse, workingStyle);

	// 6. Store as a special memory
	storeProfile(db, profile);

	return profile;
}

/**
 * Incrementally update an existing cognitive profile with new memories.
 */
export async function updateCognitiveProfile(
	db: ProfileDb,
	llmConfig: Partial<RefinerLLMConfig> = {},
	existing: CognitiveProfile,
): Promise<CognitiveProfile> {
	const config = { ...DEFAULT_REFINER_LLM_CONFIG, ...llmConfig };

	// Only query memories since last update
	const newMemories = queryProfileMemories(db, existing.lastUpdated);

	if (newMemories.length === 0) {
		return existing; // Nothing new to analyze
	}

	const workingStyle = await analyzeWorkingStyle(db);

	const context = formatIncrementalContext(existing, newMemories, workingStyle);

	const UPDATE_PROMPT = `You are updating a user's cognitive profile with new observations.

You have their EXISTING profile and NEW memories collected since the last update.
Merge the new observations into the existing profile. Only change fields where the new evidence is strong enough to warrant an update. Increase the confidenceScore slightly if the new data is consistent with existing patterns.

Return the COMPLETE updated profile as a JSON object with the same structure as the existing one.
Return ONLY the JSON object, no explanation.`;

	const rawResponse = await callLLM(config, UPDATE_PROMPT, context);
	const profile = parseProfileResponse(rawResponse, workingStyle);

	// Preserve observation continuity
	profile.observationDays = Math.max(
		existing.observationDays,
		calculateObservationDays(db),
	);

	storeProfile(db, profile);

	return profile;
}

/**
 * Load the most recently stored cognitive profile, if any.
 */
export function loadCognitiveProfile(db: ProfileDb): CognitiveProfile | null {
	try {
		const row = db
			.prepare(
				`SELECT content FROM memories
				 WHERE type = 'system' AND tags LIKE '%cognitive-profile%'
				 ORDER BY updated_at DESC
				 LIMIT 1`,
			)
			.get() as { content: string } | undefined;

		if (!row) return null;

		// The content is a JSON-encoded profile
		const parsed = JSON.parse(row.content);
		return parsed as CognitiveProfile;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Query memories relevant to profile building.
 */
function queryProfileMemories(
	db: ProfileDb,
	since?: string,
): Array<{ type: string; content: string; tags: string; createdAt: string }> {
	const relevantTypes = [
		"skill",
		"decision",
		"procedural",
		"preference",
		"fact",
		"pattern",
	];
	const placeholders = relevantTypes.map(() => "?").join(",");

	let query = `SELECT type, content, tags, created_at as createdAt
				 FROM memories
				 WHERE type IN (${placeholders})
				   AND (is_deleted = 0 OR is_deleted IS NULL)`;
	const params: unknown[] = [...relevantTypes];

	if (since) {
		query += ` AND created_at > ?`;
		params.push(since);
	}

	query += ` ORDER BY created_at DESC LIMIT 500`;

	try {
		return db.prepare(query).all(...params) as Array<{
			type: string;
			content: string;
			tags: string;
			createdAt: string;
		}>;
	} catch {
		return [];
	}
}

/**
 * Format memories into an LLM-friendly context string.
 */
function formatMemoriesForProfile(
	memories: Array<{ type: string; content: string; tags: string; createdAt: string }>,
	workingStyle: WorkingStyle,
): string {
	const sections: string[] = [];

	// Group memories by type
	const groups = new Map<string, string[]>();
	for (const mem of memories) {
		const group = groups.get(mem.type) || [];
		group.push(mem.content);
		groups.set(mem.type, group);
	}

	for (const [type, contents] of groups) {
		sections.push(`## ${type.toUpperCase()} Memories (${contents.length})`);
		for (const c of contents.slice(0, 50)) {
			sections.push(`- ${c}`);
		}
		sections.push("");
	}

	// Add working style data
	sections.push("## Working Style (from temporal analysis)");
	sections.push(`Peak hours: ${workingStyle.peakHours.join(", ")}`);
	sections.push(
		`Average session: ${workingStyle.averageSessionMinutes} minutes`,
	);
	sections.push(`Context switching: ${workingStyle.contextSwitchFrequency}`);
	sections.push(`Break frequency: ${workingStyle.breakFrequency}`);
	sections.push(
		`Terminal usage: ${workingStyle.terminalUsagePercent}% of screen time`,
	);

	if (workingStyle.mostUsedApps.length > 0) {
		sections.push("Most used apps:");
		for (const app of workingStyle.mostUsedApps.slice(0, 5)) {
			sections.push(`  - ${app.app} (${app.percentage}%)`);
		}
	}

	sections.push(`\nTotal observation data: ${memories.length} memories`);

	return sections.join("\n");
}

/**
 * Format incremental update context.
 */
function formatIncrementalContext(
	existing: CognitiveProfile,
	newMemories: Array<{ type: string; content: string; tags: string; createdAt: string }>,
	workingStyle: WorkingStyle,
): string {
	const sections: string[] = [];

	sections.push("## EXISTING PROFILE");
	sections.push("```json");
	sections.push(JSON.stringify(existing, null, 2));
	sections.push("```");
	sections.push("");

	sections.push(`## NEW MEMORIES SINCE LAST UPDATE (${newMemories.length})`);
	for (const mem of newMemories.slice(0, 100)) {
		sections.push(`- [${mem.type}] ${mem.content}`);
	}
	sections.push("");

	sections.push("## CURRENT WORKING STYLE");
	sections.push(`Peak hours: ${workingStyle.peakHours.join(", ")}`);
	sections.push(
		`Average session: ${workingStyle.averageSessionMinutes} minutes`,
	);
	sections.push(`Context switching: ${workingStyle.contextSwitchFrequency}`);
	sections.push(`Break frequency: ${workingStyle.breakFrequency}`);

	return sections.join("\n");
}

/**
 * Parse the LLM response into a CognitiveProfile.
 */
function parseProfileResponse(
	raw: string,
	workingStyle: WorkingStyle,
): CognitiveProfile {
	// Extract JSON from possibly-fenced response
	let jsonStr = raw.trim();
	const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenceMatch) {
		jsonStr = fenceMatch[1].trim();
	}

	const objStart = jsonStr.indexOf("{");
	const objEnd = jsonStr.lastIndexOf("}");
	if (objStart >= 0 && objEnd > objStart) {
		jsonStr = jsonStr.slice(objStart, objEnd + 1);
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		// Try cleaning trailing commas
		try {
			const cleaned = jsonStr.replace(/,\s*([}\]])/g, "$1");
			parsed = JSON.parse(cleaned);
		} catch {
			parsed = {};
		}
	}

	// Build profile with LLM output + working style data
	const profile: CognitiveProfile = {
		problemSolving: {
			approach: validateEnum(
				(parsed.problemSolving as Record<string, unknown>)?.approach,
				["systematic", "exploratory", "collaborative", "intuitive"],
				"systematic",
			) as CognitiveProfile["problemSolving"]["approach"],
			debuggingStyle:
				String(
					(parsed.problemSolving as Record<string, unknown>)?.debuggingStyle ??
						"unknown",
				),
			researchDepth: validateEnum(
				(parsed.problemSolving as Record<string, unknown>)?.researchDepth,
				["surface", "moderate", "deep"],
				"moderate",
			) as CognitiveProfile["problemSolving"]["researchDepth"],
			prefersTryFirst: Boolean(
				(parsed.problemSolving as Record<string, unknown>)?.prefersTryFirst ??
					true,
			),
		},
		communication: {
			verbosity: validateEnum(
				(parsed.communication as Record<string, unknown>)?.verbosity,
				["terse", "moderate", "detailed"],
				"moderate",
			) as CognitiveProfile["communication"]["verbosity"],
			formality: validateEnum(
				(parsed.communication as Record<string, unknown>)?.formality,
				["casual", "professional", "technical"],
				"technical",
			) as CognitiveProfile["communication"]["formality"],
			preferredFormats: Array.isArray(
				(parsed.communication as Record<string, unknown>)?.preferredFormats,
			)
				? ((parsed.communication as Record<string, unknown>)
						.preferredFormats as string[])
				: ["code examples"],
			documentationHabits: String(
				(parsed.communication as Record<string, unknown>)
					?.documentationHabits ?? "unknown",
			),
		},
		workPatterns: {
			peakHours: workingStyle.peakHours,
			averageSessionMinutes: workingStyle.averageSessionMinutes,
			contextSwitchFrequency: workingStyle.contextSwitchFrequency,
			breakFrequency: workingStyle.breakFrequency,
		},
		toolPreferences: {
			editor: String(
				(parsed.toolPreferences as Record<string, unknown>)?.editor ??
					detectEditorFromApps(workingStyle),
			),
			terminal: String(
				(parsed.toolPreferences as Record<string, unknown>)?.terminal ??
					detectTerminalFromApps(workingStyle),
			),
			prefersCLI: Boolean(
				(parsed.toolPreferences as Record<string, unknown>)?.prefersCLI ??
					workingStyle.terminalUsagePercent > 20,
			),
			automationLevel: validateEnum(
				(parsed.toolPreferences as Record<string, unknown>)?.automationLevel,
				["manual", "scripts", "heavy-automation"],
				"scripts",
			) as CognitiveProfile["toolPreferences"]["automationLevel"],
		},
		expertise: {
			primaryDomains: Array.isArray(
				(parsed.expertise as Record<string, unknown>)?.primaryDomains,
			)
				? ((parsed.expertise as Record<string, unknown>)
						.primaryDomains as string[])
				: [],
			languages: Array.isArray(
				(parsed.expertise as Record<string, unknown>)?.languages,
			)
				? ((parsed.expertise as Record<string, unknown>).languages as string[])
				: [],
			frameworks: Array.isArray(
				(parsed.expertise as Record<string, unknown>)?.frameworks,
			)
				? ((parsed.expertise as Record<string, unknown>)
						.frameworks as string[])
				: [],
			weakAreas: Array.isArray(
				(parsed.expertise as Record<string, unknown>)?.weakAreas,
			)
				? ((parsed.expertise as Record<string, unknown>).weakAreas as string[])
				: [],
		},
		decisionMaking: {
			speed: validateEnum(
				(parsed.decisionMaking as Record<string, unknown>)?.speed,
				["quick", "deliberate", "analysis-paralysis"],
				"deliberate",
			) as CognitiveProfile["decisionMaking"]["speed"],
			revisitsDecisions: Boolean(
				(parsed.decisionMaking as Record<string, unknown>)
					?.revisitsDecisions ?? false,
			),
			riskTolerance: validateEnum(
				(parsed.decisionMaking as Record<string, unknown>)?.riskTolerance,
				["conservative", "moderate", "bold"],
				"moderate",
			) as CognitiveProfile["decisionMaking"]["riskTolerance"],
		},
		lastUpdated: new Date().toISOString(),
		observationDays: 0, // Will be set by caller
		confidenceScore: typeof parsed.confidenceScore === "number"
			? Math.min(1, Math.max(0, parsed.confidenceScore))
			: 0.3,
	};

	return profile;
}

/**
 * Store the cognitive profile as a special system memory.
 */
function storeProfile(db: ProfileDb, profile: CognitiveProfile): void {
	const now = new Date().toISOString();
	const content = JSON.stringify(profile);
	const id = crypto.randomUUID();

	try {
		// Check if a profile memory already exists
		const existing = db
			.prepare(
				`SELECT id FROM memories
				 WHERE type = 'system' AND tags LIKE '%cognitive-profile%'
				 LIMIT 1`,
			)
			.get() as { id: string } | undefined;

		if (existing) {
			// Update existing
			db.prepare(
				`UPDATE memories
				 SET content = ?, updated_at = ?, importance = 1.0
				 WHERE id = ?`,
			).run(content, now, existing.id);
		} else {
			// Insert new
			db.prepare(
				`INSERT INTO memories
				 (id, type, content, confidence, tags, importance, created_at, updated_at, updated_by)
				 VALUES (?, 'system', ?, 1.0, ?, 1.0, ?, ?, 'perception-distillation')`,
			).run(id, content, JSON.stringify(["cognitive-profile", "distillation"]), now, now);
		}
	} catch (err) {
		console.warn(
			"[distillation] Failed to store cognitive profile:",
			err instanceof Error ? err.message : String(err),
		);
	}
}

/**
 * Calculate how many days of observation data we have.
 */
function calculateObservationDays(db: ProfileDb): number {
	try {
		const row = db
			.prepare(
				`SELECT
				   MIN(created_at) as first,
				   MAX(created_at) as last
				 FROM memories
				 WHERE (is_deleted = 0 OR is_deleted IS NULL)`,
			)
			.get() as { first: string; last: string } | undefined;

		if (!row?.first || !row?.last) return 0;

		const days =
			(new Date(row.last).getTime() - new Date(row.first).getTime()) /
			(24 * 60 * 60 * 1000);

		return Math.max(1, Math.round(days));
	} catch {
		return 0;
	}
}

/**
 * Detect the user's editor from app usage data.
 */
function detectEditorFromApps(workingStyle: WorkingStyle): string {
	const editorKeywords = [
		"visual studio code",
		"vscode",
		"cursor",
		"vim",
		"neovim",
		"emacs",
		"sublime",
		"intellij",
		"webstorm",
		"zed",
		"nova",
	];

	for (const app of workingStyle.mostUsedApps) {
		const lower = app.app.toLowerCase();
		for (const kw of editorKeywords) {
			if (lower.includes(kw)) return app.app;
		}
	}

	return "unknown";
}

/**
 * Detect the user's terminal from app usage data.
 */
function detectTerminalFromApps(workingStyle: WorkingStyle): string {
	const termKeywords = [
		"terminal",
		"iterm",
		"wezterm",
		"kitty",
		"alacritty",
		"hyper",
		"warp",
		"ghostty",
	];

	for (const app of workingStyle.mostUsedApps) {
		const lower = app.app.toLowerCase();
		for (const kw of termKeywords) {
			if (lower.includes(kw)) return app.app;
		}
	}

	return "unknown";
}

/**
 * Validate an enum value against allowed options.
 */
function validateEnum(
	value: unknown,
	allowed: string[],
	fallback: string,
): string {
	if (typeof value === "string" && allowed.includes(value)) return value;
	return fallback;
}

/**
 * Call Ollama HTTP API (same pattern as refiners/base.ts).
 */
async function callLLM(
	config: RefinerLLMConfig,
	system: string,
	prompt: string,
): Promise<string> {
	const url = `${config.ollamaUrl}/api/generate`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: config.model,
				system,
				prompt,
				stream: false,
				options: {
					temperature: 0.1,
					num_predict: 4096,
				},
			}),
			signal: controller.signal,
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(
				`Ollama returned ${res.status}: ${body.slice(0, 200)}`,
			);
		}

		const data = (await res.json()) as { response: string };
		return data.response;
	} finally {
		clearTimeout(timeout);
	}
}
