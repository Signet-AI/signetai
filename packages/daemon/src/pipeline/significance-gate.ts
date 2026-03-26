/**
 * Significance gate: zero-cost continuity filter.
 *
 * Assesses whether a session transcript is worth sending through
 * the LLM summarization pipeline. Sessions below a significance
 * threshold skip extraction entirely, saving LLM inference cost
 * while preserving the raw transcript (lossless retention).
 *
 * Three independent signals are evaluated:
 *   1. Turn count — substantive back-and-forth exchanges
 *   2. Entity overlap — references to known high-mention entities
 *   3. Content novelty — unique tokens vs recent session summaries
 *
 * All three must indicate low significance to gate the session.
 */

import type { ReadDb } from "../db-accessor";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SignificanceConfig {
	readonly enabled: boolean;
	readonly minTurns: number;
	readonly minEntityOverlap: number;
	readonly noveltyThreshold: number;
}

export interface SignificanceResult {
	readonly significant: boolean;
	readonly scores: {
		readonly turnCount: number;
		readonly entityOverlap: number;
		readonly novelty: number;
	};
	readonly reason: string;
}

// ---------------------------------------------------------------------------
// Turn counting
// ---------------------------------------------------------------------------

/** Regex patterns that mark the start of a user or assistant block. */
const TURN_PREFIX = /^(?:Human|User|Assistant|assistant|human|user):\s*/im;

/**
 * Count substantive turn pairs in a transcript. A turn is substantive
 * when the user message exceeds 20 chars and the assistant response
 * exceeds 50 chars.
 */
function countSubstantiveTurns(transcript: string): number {
	const lines = transcript.split("\n");

	let currentRole: "user" | "assistant" | null = null;
	let currentBlock = "";
	const userBlocks: string[] = [];
	const assistantBlocks: string[] = [];

	for (const line of lines) {
		const lower = line.trimStart().toLowerCase();
		if (lower.startsWith("human:") || lower.startsWith("user:")) {
			// Flush previous block
			if (currentRole === "user") userBlocks.push(currentBlock);
			if (currentRole === "assistant") assistantBlocks.push(currentBlock);
			currentRole = "user";
			currentBlock = line.replace(TURN_PREFIX, "");
		} else if (lower.startsWith("assistant:")) {
			if (currentRole === "user") userBlocks.push(currentBlock);
			if (currentRole === "assistant") assistantBlocks.push(currentBlock);
			currentRole = "assistant";
			currentBlock = line.replace(TURN_PREFIX, "");
		} else {
			currentBlock += `\n${line}`;
		}
	}

	// Flush final block
	if (currentRole === "user") userBlocks.push(currentBlock);
	if (currentRole === "assistant") assistantBlocks.push(currentBlock);

	// Count pairs where both sides are substantive
	const pairCount = Math.min(userBlocks.length, assistantBlocks.length);
	let substantive = 0;
	for (let i = 0; i < pairCount; i++) {
		const userLen = userBlocks[i].trim().length;
		const assistLen = assistantBlocks[i].trim().length;
		if (userLen > 20 && assistLen > 50) {
			substantive++;
		}
	}

	return substantive;
}

// ---------------------------------------------------------------------------
// Entity overlap
// ---------------------------------------------------------------------------

interface EntityNameRow {
	readonly name: string;
}

/**
 * Count how many known high-mention entities appear in the transcript.
 * Uses the entities table with `mentions >= 3` as a proxy for importance.
 * Returns -1 if the entities table does not exist (passes the gate).
 */
function countEntityOverlap(transcript: string, db: ReadDb, agentId: string): number {
	let rows: ReadonlyArray<EntityNameRow>;
	try {
		rows = db
			.prepare(
				`SELECT DISTINCT e.name FROM entities e
				 WHERE e.agent_id = ? AND e.mentions >= 3`,
			)
			.all(agentId) as EntityNameRow[];
	} catch {
		// Table may not exist yet — let the gate pass
		return -1;
	}

	if (rows.length === 0) return 0;

	const lowerTranscript = transcript.toLowerCase();
	let matches = 0;
	for (const row of rows) {
		if (lowerTranscript.includes(row.name.toLowerCase())) {
			matches++;
		}
	}

	return matches;
}

// ---------------------------------------------------------------------------
// Content novelty
// ---------------------------------------------------------------------------

interface TranscriptRow {
	readonly transcript: string;
}

/**
 * Simple token-set novelty check. Compares the first 2000 chars of
 * the transcript against the last 5 completed session transcripts.
 * Returns a 0-1 score: 1.0 = highly novel, 0.0 = highly redundant.
 */
function computeNovelty(transcript: string, db: ReadDb, agentId: string): number {
	let recentTranscripts: ReadonlyArray<TranscriptRow>;
	try {
		try {
			recentTranscripts = db
				.prepare(
					`SELECT transcript FROM summary_jobs
					 WHERE status = 'completed' AND agent_id = ?
					 ORDER BY completed_at DESC LIMIT 5`,
				)
				.all(agentId) as TranscriptRow[];
		} catch {
			recentTranscripts = db
				.prepare(
					`SELECT transcript FROM summary_jobs
					 WHERE status = 'completed'
					 ORDER BY completed_at DESC LIMIT 5`,
				)
				.all() as TranscriptRow[];
		}
	} catch {
		// Table missing or query failed — treat as novel
		return 1.0;
	}

	if (recentTranscripts.length === 0) return 1.0;

	const currentTokens = tokenize(sampleTranscript(transcript));
	if (currentTokens.size === 0) return 1.0; // Unrecognizable content is novel by default

	// Build union of tokens from recent sessions
	const recentTokens = new Set<string>();
	for (const row of recentTranscripts) {
		for (const tok of tokenize(sampleTranscript(row.transcript))) {
			recentTokens.add(tok);
		}
	}

	if (recentTokens.size === 0) return 1.0;

	let unique = 0;
	for (const tok of currentTokens) {
		if (!recentTokens.has(tok)) unique++;
	}

	const ratio = unique / currentTokens.size;

	// Interpolate: <10% unique → 0.0, >30% unique → 1.0
	if (ratio >= 0.3) return 1.0;
	if (ratio <= 0.1) return 0.0;
	return (ratio - 0.1) / 0.2;
}

/**
 * Sample a representative cross-section of the transcript.
 * Taking only the head biases novelty toward 0 because system prompts and
 * agent instructions are structurally identical across sessions. Instead
 * we sample head + mid + tail within the same 2000-char total budget.
 */
function sampleTranscript(t: string): string {
	if (t.length <= 2000) return t;
	const mid = Math.floor(t.length * 0.4);
	return `${t.slice(0, 400)} ${t.slice(mid, mid + 1200)} ${t.slice(-400)}`;
}

/** Split text into lowercase alpha-numeric tokens (>= 3 chars). */
function tokenize(text: string): Set<string> {
	const tokens = new Set<string>();
	const matches = text.toLowerCase().match(/[a-z0-9]{3,}/g);
	if (matches) {
		for (const m of matches) tokens.add(m);
	}
	return tokens;
}

// ---------------------------------------------------------------------------
// Main assessment
// ---------------------------------------------------------------------------

export function assessSignificance(
	transcript: string,
	db: ReadDb,
	agentId: string,
	config: SignificanceConfig,
): SignificanceResult {
	const turnCount = countSubstantiveTurns(transcript);
	const entityOverlap = countEntityOverlap(transcript, db, agentId);
	const novelty = computeNovelty(transcript, db, agentId);

	// Entity overlap of -1 means the table doesn't exist — let it pass
	const entityPasses = entityOverlap < 0 || entityOverlap >= config.minEntityOverlap;
	const turnPasses = turnCount >= config.minTurns;
	const noveltyPasses = novelty >= config.noveltyThreshold;

	// Session is insignificant only when ALL three gates fail
	const significant = turnPasses || entityPasses || noveltyPasses;

	const reasons: string[] = [];
	if (!turnPasses) reasons.push(`turns=${turnCount}<${config.minTurns}`);
	if (!entityPasses) reasons.push(`entities=${entityOverlap}<${config.minEntityOverlap}`);
	if (!noveltyPasses) reasons.push(`novelty=${novelty.toFixed(2)}<${config.noveltyThreshold}`);

	const reason = significant ? "passed" : `below threshold: ${reasons.join(", ")}`;

	logger.debug("summary-worker", "Significance assessment", {
		turnCount,
		entityOverlap,
		novelty: Number(novelty.toFixed(3)),
		significant,
		reason,
	});

	return {
		significant,
		scores: {
			turnCount,
			entityOverlap: Math.max(0, entityOverlap),
			novelty,
		},
		reason,
	};
}
