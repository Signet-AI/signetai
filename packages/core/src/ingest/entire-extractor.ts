/**
 * Entire.io Session Extraction for the ingestion engine.
 *
 * Specialized extraction logic for Entire.io AI coding session data.
 * DIFFERENT from regular chat extraction — this focuses on extracting
 * SKILL SIGNALS from developer-AI interaction patterns:
 *
 * - Skills demonstrated: technologies, tools, patterns used
 * - Problem-solving approach: decomposition strategy, first moves
 * - Decision paths: choices made, alternatives considered
 * - Communication style with AI: prompt craftsmanship
 * - Domain knowledge signals: what they know vs. ask about
 * - Workflow patterns: build→test→commit cycles
 * - Tool mastery: IDE features, CLI commands, framework expertise
 *
 * Uses the same Ollama-based extraction as the document/chat extractors
 * but with a prompt specifically designed for developer skill assessment.
 */

import type { ChunkResult, ExtractionResult } from "./types";
import {
	callOllama as sharedCallOllama,
	parseExtractionResponse as sharedParseExtractionResponse,
	type ParseOptions,
} from "./ollama-client";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EntireExtractorConfig {
	/** Ollama base URL */
	readonly ollamaUrl: string;
	/** Model to use for extraction */
	readonly model: string;
	/** Request timeout in ms */
	readonly timeoutMs: number;
	/** Minimum confidence to keep an extracted item */
	readonly minConfidence: number;
}

export const DEFAULT_ENTIRE_EXTRACTOR_CONFIG: EntireExtractorConfig = {
	ollamaUrl: "http://localhost:11434",
	model: "llama3.2",
	timeoutMs: 120_000,
	minConfidence: 0.4,
};

// ---------------------------------------------------------------------------
// Skill Signal Extraction Prompt
// ---------------------------------------------------------------------------

function buildSkillExtractionPrompt(
	sessionText: string,
	sessionMetadata: string | null,
): string {
	const metaBlock = sessionMetadata
		? `SESSION CONTEXT:\n${sessionMetadata}\n\n`
		: "";

	return `You are a developer skill assessment engine analyzing an AI coding session transcript.

This is a recording of a developer working with an AI coding assistant (Claude Code, Gemini CLI, etc.).
Your job is to extract SKILL SIGNALS — evidence of what this developer knows, how they work, and what they're capable of.

${metaBlock}TASK: Extract developer skill signals from this coding session.

Each item must be:
1. EVIDENCE-BASED — grounded in what the developer actually said or did
2. SPECIFIC — name the exact technology, pattern, tool, or approach
3. ACTIONABLE — useful for building a profile of the developer's capabilities
4. ATTRIBUTED — clarify if a skill was DEMONSTRATED (developer showed it) or DISCUSSED (developer asked about it)

Return a JSON object with "items" and "relations" arrays.

ITEM SCHEMA:
{"content": "<specific skill signal with evidence>", "type": "<type>", "confidence": <0.0-1.0>}

TYPES (use exactly these strings):
- "skill" — Demonstrated technical skill (the developer showed they KNOW this)
- "preference" — Working style, tool preference, or approach preference
- "decision" — Architectural or design decision with reasoning
- "rationale" — WHY something was chosen (reveals depth of understanding)
- "procedural" — Workflow pattern (how they build, test, debug, deploy)
- "semantic" — Domain concept or mental model the developer holds
- "fact" — Concrete technical detail (endpoint, config, version) from the session

WHAT TO EXTRACT:

1. SKILLS DEMONSTRATED (high confidence):
   - Languages and frameworks USED, not just mentioned
   - Design patterns applied (observer, factory, middleware, etc.)
   - Tools wielded fluently (git, docker, vim, specific CLIs)
   - Testing approaches (TDD, property testing, integration testing)
   - Architecture knowledge (microservices, event sourcing, CQRS)

2. PROBLEM-SOLVING PATTERNS:
   - How they decompose problems (top-down? bottom-up? spike first?)
   - First instinct when debugging (logs? breakpoints? bisect? reproduce first?)
   - How they handle ambiguity (ask clarifying questions? prototype? research?)
   - Error recovery (how they respond when something breaks)

3. DECISION EVIDENCE:
   - Technology choices and WHY
   - Trade-offs explicitly considered
   - Alternatives mentioned and rejected
   - "I chose X because Y" statements (gold — these reveal deep knowledge)

4. AI INTERACTION STYLE (reveals experience level):
   - Prompt specificity (vague "fix this" vs precise "refactor X to use pattern Y")
   - Correction patterns (how they redirect the AI when it goes wrong)
   - Context provision (do they give examples? constraints? anti-patterns to avoid?)
   - Trust calibration (when do they verify AI output vs. accept it?)

5. WORKFLOW SIGNALS:
   - Build→test→commit rhythm
   - Code review habits (self-review, asking AI to review)
   - Documentation practices
   - Refactoring patterns

6. DOMAIN KNOWLEDGE:
   - What the developer explains TO the AI (they know this well)
   - What the developer asks the AI (they're learning this)
   - Jargon used naturally (domain fluency)
   - Edge cases anticipated (deep domain experience)

RELATION SCHEMA (developer capabilities graph):
{"source": "<developer or project>", "relationship": "<verb>", "target": "<technology/skill/pattern>", "confidence": <0.0-1.0>}

QUALITY RULES:
- DISTINGUISH between "developer knows X" and "developer asked AI about X"
- Higher confidence for skills DEMONSTRATED in code, lower for merely discussed
- Include evidence: "used React hooks in the component refactor" not just "knows React"
- For decisions, include the alternative that was rejected
- "Fluent with X" (used without hesitation) vs "familiar with X" (needed reminders)
- Group related skills: if they used TypeScript generics, that implies TypeScript knowledge

SKIP ENTIRELY:
- The AI's knowledge (we're assessing the DEVELOPER, not the AI)
- Generic programming concepts everyone knows
- Greetings, meta-conversation, small talk
- Repeated demonstrations of the same skill (extract once at highest confidence)
- File contents that the AI generated (focus on what the developer directed)

EXAMPLES:

Session excerpt:
[USER]: Refactor the auth middleware to use the decorator pattern instead of the current chain. Make sure the refresh token rotation still works with the new structure.
[ASSISTANT]: I'll refactor the auth middleware...
[TOOL:Write] → src/middleware/auth.ts
[USER]: The refresh token needs to check the jti claim for replay protection. You missed that.

Extraction:
{"items": [
  {"content": "Demonstrated knowledge of decorator pattern and its applicability to middleware refactoring — initiated the pattern choice, not the AI", "type": "skill", "confidence": 0.9},
  {"content": "Deep understanding of JWT security: specifically requested jti claim checking for refresh token replay protection, caught the AI's omission", "type": "skill", "confidence": 0.95},
  {"content": "Prefers decorator pattern over middleware chaining for auth — chose to refactor existing working code for better structure", "type": "preference", "confidence": 0.8},
  {"content": "Code review pattern: checks AI-generated code against security requirements, caught missing replay protection", "type": "procedural", "confidence": 0.85}
], "relations": [
  {"source": "developer", "relationship": "expert_in", "target": "JWT security (jti claims, token rotation)", "confidence": 0.9},
  {"source": "developer", "relationship": "applies", "target": "decorator pattern", "confidence": 0.85}
]}

Return ONLY valid JSON. No markdown fences, no explanation.
If there are no skill signals worth extracting, return: {"items": [], "relations": []}

SESSION TRANSCRIPT:
${sessionText}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract skill signals from an Entire.io session chunk.
 */
export async function extractFromEntireSession(
	chunk: ChunkResult,
	sessionMetadata: string | null,
	config: EntireExtractorConfig = DEFAULT_ENTIRE_EXTRACTOR_CONFIG,
): Promise<ExtractionResult> {
	const prompt = buildSkillExtractionPrompt(chunk.text, sessionMetadata);

	try {
		const response = await callOllama(prompt, config);
		const parsed = parseExtractionResponse(response, config.minConfidence);

		return {
			chunkIndex: chunk.index,
			items: parsed.items,
			relations: parsed.relations,
			warnings: parsed.warnings,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			chunkIndex: chunk.index,
			items: [],
			relations: [],
			warnings: [`Entire session extraction failed for chunk ${chunk.index}: ${msg}`],
		};
	}
}

/**
 * Extract skill signals from all Entire.io session chunks.
 */
export async function extractFromEntireSessions(
	chunks: readonly ChunkResult[],
	sessionMetadata: string | null,
	config: EntireExtractorConfig = DEFAULT_ENTIRE_EXTRACTOR_CONFIG,
	onChunkDone?: (chunkIndex: number, itemCount: number) => void,
): Promise<ExtractionResult[]> {
	const results: ExtractionResult[] = [];

	for (const chunk of chunks) {
		const result = await extractFromEntireSession(
			chunk,
			sessionMetadata,
			config,
		);
		results.push(result);
		if (onChunkDone) {
			onChunkDone(chunk.index, result.items.length);
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Ollama API call — delegates to shared client
// ---------------------------------------------------------------------------

async function callOllama(
	prompt: string,
	config: EntireExtractorConfig,
): Promise<string> {
	return sharedCallOllama(prompt, config);
}

// ---------------------------------------------------------------------------
// Parse LLM response — delegates to shared parser with Entire-specific config
// ---------------------------------------------------------------------------

/** Valid types for Entire session extraction */
const ENTIRE_VALID_TYPES = new Set([
	"skill", "preference", "decision", "rationale",
	"procedural", "semantic", "fact",
]);

/** Map alternative type names to valid ones */
const ENTIRE_TYPE_MAP: Record<string, string> = {
	technology: "skill",
	expertise: "skill",
	tool: "skill",
	pattern: "skill",
	knowledge: "semantic",
	workflow: "procedural",
	process: "procedural",
	architectural: "decision",
	configuration: "fact",
	system: "fact",
};

function parseExtractionResponse(
	raw: string,
	minConfidence: number,
) {
	const opts: ParseOptions = {
		minConfidence,
		validTypes: ENTIRE_VALID_TYPES,
		typeMap: ENTIRE_TYPE_MAP,
		defaultType: "skill",
		minContentLength: 15,
	};
	return sharedParseExtractionResponse(raw, opts);
}
