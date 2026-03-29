/**
 * Inline entity linking + structural extraction for the remember endpoint.
 *
 * When a memory is stored, extract entities, aspects, and attributes
 * from the content text. This runs synchronously at write time (no LLM
 * needed) so KA traversal can find this memory immediately via
 * entity_aspects → entity_attributes → memory_id.
 *
 * The pipeline extraction still runs later for deeper analysis
 * (supersession, dependency synthesis, confidence calibration).
 */

import type { WriteDb } from "./db-accessor";
import { requireDependencyReason } from "./dependency-history";

// ---------------------------------------------------------------------------
// Decision pattern detection
// ---------------------------------------------------------------------------

const DECISION_PATTERNS: readonly RegExp[] = [
	/\b(?:chose|chosen)\s+(?:to\s+)?(?:use\s+)?(?:over|instead)/i,
	/\bdecided\s+(?:to\s+|on\s+|against\s+)/i,
	/\bswitched\s+(?:from|to)\b/i,
	/\bmigrated?\s+(?:from|to|away)\b/i,
	/\bpicked\s+.+\s+over\b/i,
	/\bwent\s+with\b/i,
	/\bsticking\s+with\b/i,
	/\bcommitted\s+to\b/i,
	/\bsettled\s+on\b/i,
	/\bwill\s+(?:use|go\s+with|stick\s+with)\b/i,
	/\bprefer(?:s|red)?\s+.+\s+(?:over|instead|rather)\b/i,
	/\badopted\b/i,
	/\barchitecture\s+decision\b/i,
	/\bdesign\s+decision\b/i,
];

/** Check whether content text contains decision-indicating language. */
export function isDecisionContent(content: string): boolean {
	return DECISION_PATTERNS.some((re) => re.test(content));
}

// ---------------------------------------------------------------------------
// Aspect inference from verb patterns
// ---------------------------------------------------------------------------

const ASPECT_PATTERNS: ReadonlyArray<{
	readonly pattern: RegExp;
	readonly aspect: string;
}> = [
	{ pattern: /\b(likes?|enjoys?|loves?|prefers?|favou?rites?|passionate about)\b/i, aspect: "preferences" },
	{ pattern: /\b(hates?|dislikes?|avoids?|afraid of|fears?)\b/i, aspect: "preferences" },
	{ pattern: /\b(is|was|am|are|were|became|becomes|identifies as)\b/i, aspect: "properties" },
	{ pattern: /\b(went|goes|attended|visited|moved|traveled|arrived|returned|came)\b/i, aspect: "events" },
	{ pattern: /\b(works?|studies|researches?|teaches|pursues?|specializes)\b/i, aspect: "activities" },
	{ pattern: /\b(thinks?|believes?|feels?|considers?|realizes?|realized)\b/i, aspect: "perspectives" },
	{ pattern: /\b(has|have|had|owns?|keeps?|maintains?)\b/i, aspect: "properties" },
	{ pattern: /\b(married|dating|divorced|engaged|single|relationship)\b/i, aspect: "relationships" },
	{ pattern: /\b(born|raised|grew up|lives? in|moved from|comes? from)\b/i, aspect: "background" },
	{ pattern: /\b(plans?|intends?|wants? to|hopes? to|decided|chose|choosing)\b/i, aspect: "decision patterns" },
	{ pattern: /\b(reads?|plays?|runs?|swims?|paints?|cooks?|camps?|hikes?)\b/i, aspect: "activities" },
	{ pattern: /\b(said|told|mentioned|shared|expressed|stated)\b/i, aspect: "general" },
];

function inferAspect(text: string): string {
	for (const { pattern, aspect } of ASPECT_PATTERNS) {
		if (pattern.test(text)) return aspect;
	}
	return "general";
}

// ---------------------------------------------------------------------------
// Name extraction
// ---------------------------------------------------------------------------

// Common words that appear capitalized but aren't entity names
const SKIP_WORDS = new Set([
	"the", "this", "that", "these", "those", "there", "then",
	"what", "when", "where", "which", "while", "who", "whom",
	"how", "here", "have", "has", "had", "his", "her", "its",
	"our", "your", "their", "some", "any", "all", "each",
	"every", "both", "few", "more", "most", "many", "much",
	"other", "another", "such", "like", "just", "also", "only",
	"very", "really", "quite", "rather", "still", "already",
	"even", "never", "always", "often", "sometimes", "usually",
	"about", "after", "before", "between", "during", "since",
	"until", "into", "onto", "from", "with", "without",
	"through", "across", "along", "around", "behind", "below",
	"above", "under", "over", "near", "next", "last", "first",
	"second", "third", "new", "old", "good", "great", "best",
	"well", "long", "high", "low", "big", "small", "large",
	"little", "much", "own", "same", "different", "important",
	"sure", "true", "right", "left", "yes", "not",
	"but", "and", "for", "nor", "yet", "can", "may",
	"will", "shall", "should", "would", "could", "might",
	"must", "does", "did", "been", "being", "are", "was",
	"were", "note", "also", "however", "therefore", "thus",
	"moreover", "furthermore", "additionally", "meanwhile",
	"recently", "currently", "previously", "originally",
	"apparently", "specifically", "essentially", "generally",
	"typically", "particularly", "especially", "actually",
	"unfortunately", "fortunately", "certainly", "obviously",
	"basically", "exactly", "simply", "finally", "initially",
	// Markdown / structural tokens
	"key", "facts", "preferences", "events", "relationships",
]);

/**
 * Extract candidate proper nouns from text. Finds capitalized words
 * and multi-word names (consecutive capitalized tokens). Filters out
 * sentence-initial capitals and common false positives.
 */
export function extractCandidateNames(text: string): string[] {
	const names: string[] = [];
	const sentences = text.split(/[.!?\n]+/).filter(Boolean);

	for (const sentence of sentences) {
		const words = sentence.trim().split(/\s+/);
		if (words.length === 0) continue;

		let run: string[] = [];

		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			const clean = word.replace(/[,;:'"()[\]{}]+$/g, "").replace(/^['"([\]{}]+/, "");
			if (!clean) continue;

			const isCapitalized = /^[A-Z][a-z]/.test(clean);
			const isAllCaps = /^[A-Z]{2,}$/.test(clean) && clean.length <= 6;

			if ((isCapitalized || isAllCaps) && !SKIP_WORDS.has(clean.toLowerCase())) {
				// Sentence-initial capitals that pass SKIP_WORDS are proper
				// nouns (Caroline, Melanie, etc.) — include them.
				run.push(clean);
			} else {
				if (run.length > 0) {
					const name = run.join(" ");
					if (name.length >= 3) names.push(name);
					run = [];
				}
			}
		}

		if (run.length > 0) {
			const name = run.join(" ");
			if (name.length >= 3) names.push(name);
		}
	}

	return [...new Set(names)];
}

// ---------------------------------------------------------------------------
// Clause extraction: entity + predicate pairs from sentences
// ---------------------------------------------------------------------------

interface Clause {
	readonly entity: string;
	readonly predicate: string;
	readonly aspect: string;
}

/**
 * Extract entity-predicate clauses from text. For each sentence
 * containing a known entity name, captures the predicate (rest of
 * the clause after the entity) and infers an aspect category.
 */
function extractClauses(text: string, entityNames: ReadonlyArray<string>): Clause[] {
	if (entityNames.length === 0) return [];

	const clauses: Clause[] = [];
	// Sort longer names first so "LGBTQ support group" matches before "LGBTQ"
	const sorted = [...entityNames].sort((a, b) => b.length - a.length);

	// Split on sentence boundaries and list markers
	const segments = text
		.split(/(?:[.!?\n]|\s*-\s+)/)
		.map((s) => s.trim())
		.filter((s) => s.length > 10);

	for (const segment of segments) {
		for (const name of sorted) {
			const idx = segment.indexOf(name);
			if (idx < 0) continue;

			// Extract predicate: everything after the entity name in this segment
			const after = segment.slice(idx + name.length).trim();
			// Clean leading punctuation and conjunctions
			const predicate = after
				.replace(/^[,;:\s]+/, "")
				.replace(/^(and|or|but|who|that|which)\s+/i, "")
				.trim();

			if (predicate.length < 5) continue;
			// Cap at reasonable length
			const capped = predicate.length > 200 ? predicate.slice(0, 200) : predicate;
			const aspect = inferAspect(capped);

			clauses.push({ entity: name, predicate: capped, aspect });
			break; // one entity per segment to avoid duplication
		}
	}

	return clauses;
}

// ---------------------------------------------------------------------------
// Entity resolution / creation
// ---------------------------------------------------------------------------

function resolveEntity(
	db: WriteDb,
	name: string,
	agentId: string,
	now: string,
): string {
	const canonical = name.trim().toLowerCase().replace(/\s+/g, " ");
	if (canonical.length < 3) return "";

	const existing = db
		.prepare(
			`SELECT id FROM entities
			 WHERE (canonical_name = ? OR name = ?) AND agent_id = ?
			 LIMIT 1`,
		)
		.get(canonical, name, agentId) as { id: string } | undefined;

	if (existing) {
		db.prepare(
			`UPDATE entities SET mentions = mentions + 1, updated_at = ? WHERE id = ?`,
		).run(now, existing.id);
		return existing.id;
	}

	const id = crypto.randomUUID();
	try {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, 'extracted', ?, 1, ?, ?)`,
		).run(id, name, canonical, agentId, now, now);
		return id;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!msg.includes("UNIQUE constraint")) throw e;
		const fallback = db
			.prepare("SELECT id FROM entities WHERE name = ? AND agent_id = ? LIMIT 1")
			.get(name, agentId) as { id: string } | undefined;
		if (!fallback) return "";
		db.prepare(
			`UPDATE entities SET mentions = mentions + 1, updated_at = ? WHERE id = ?`,
		).run(now, fallback.id);
		return fallback.id;
	}
}

// ---------------------------------------------------------------------------
// Aspect resolution / creation
// ---------------------------------------------------------------------------

function resolveAspect(
	db: WriteDb,
	entityId: string,
	agentId: string,
	name: string,
	now: string,
): string {
	const canonical = name.trim().toLowerCase().replace(/\s+/g, " ");

	const existing = db
		.prepare(
			`SELECT id FROM entity_aspects
			 WHERE entity_id = ? AND canonical_name = ? AND agent_id = ?
			 LIMIT 1`,
		)
		.get(entityId, canonical, agentId) as { id: string } | undefined;

	if (existing) return existing.id;

	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO entity_aspects
		 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 0.5, ?, ?)
		 ON CONFLICT(entity_id, canonical_name) DO UPDATE SET
		   updated_at = excluded.updated_at`,
	).run(id, entityId, agentId, name, canonical, now, now);

	// Read back in case of conflict
	const row = db
		.prepare(
			`SELECT id FROM entity_aspects
			 WHERE entity_id = ? AND canonical_name = ? AND agent_id = ?`,
		)
		.get(entityId, canonical, agentId) as { id: string };
	return row.id;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LinkResult {
	readonly linked: number;
	readonly entityIds: string[];
	readonly aspects: number;
	readonly attributes: number;
}

/**
 * Link a memory to entities found in its content, creating the full
 * entity → aspect → attribute structure that KA traversal requires.
 *
 * 1. Extract candidate entity names from proper nouns
 * 2. Resolve or create entities
 * 3. Extract entity-predicate clauses from sentence structure
 * 4. Create aspects and attributes for each clause
 * 5. Create memory_entity_mentions for all resolved entities
 *
 * Must run inside a withWriteTx closure.
 */
export function linkMemoryToEntities(
	db: WriteDb,
	memoryId: string,
	content: string,
	agentId: string,
): LinkResult {
	const names = extractCandidateNames(content);
	if (names.length === 0) return { linked: 0, entityIds: [], aspects: 0, attributes: 0 };

	const now = new Date().toISOString();
	let linked = 0;
	let aspectCount = 0;
	let attributeCount = 0;
	const entityIds: string[] = [];
	const entityMap = new Map<string, string>(); // name → entityId

	// Step 1: Resolve all entities
	for (const name of names) {
		const entityId = resolveEntity(db, name, agentId, now);
		if (!entityId) continue;
		entityMap.set(name, entityId);
		entityIds.push(entityId);

		// Create memory-entity mention link
		const ins = db.prepare(
			`INSERT OR IGNORE INTO memory_entity_mentions
			 (memory_id, entity_id, mention_text, confidence, created_at)
			 VALUES (?, ?, ?, 0.8, ?)`,
		).run(memoryId, entityId, name, now);
		if (ins.changes > 0) linked++;
	}

	// Step 2: Extract clauses and create aspects + attributes
	const clauses = extractClauses(content, names);
	const decision = isDecisionContent(content);
	const kind = decision ? "constraint" : "attribute";
	const importance = decision ? 0.85 : 0.5;

	for (const clause of clauses) {
		const entityId = entityMap.get(clause.entity);
		if (!entityId) continue;

		const aspectId = resolveAspect(db, entityId, agentId, clause.aspect, now);
		if (!aspectId) continue;
		aspectCount++;

		// Check for duplicate attribute content on this aspect
		const normalized = clause.predicate.trim().toLowerCase().replace(/\s+/g, " ");
		const dup = db
			.prepare(
				`SELECT id FROM entity_attributes
				 WHERE aspect_id = ? AND agent_id = ? AND normalized_content = ?
				   AND status = 'active'
				 LIMIT 1`,
			)
			.get(aspectId, agentId, normalized) as { id: string } | undefined;

		if (dup) continue;

		const attrId = crypto.randomUUID();
		try {
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, memory_id, kind, content,
				  normalized_content, confidence, importance, status,
				  created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 0.7, ?, 'active', ?, ?)`,
			).run(attrId, aspectId, agentId, memoryId, kind, clause.predicate, normalized, importance, now, now);
			attributeCount++;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UNIQUE constraint")) throw e;
		}
	}

	// Step 3: Create dependencies between co-occurring entities
	const ids = [...entityMap.values()];
	if (ids.length >= 2) {
		for (let i = 0; i < ids.length - 1; i++) {
			for (let j = i + 1; j < ids.length; j++) {
				if (ids[i] === ids[j]) continue;
				try {
					const row = db
						.prepare(
							`SELECT id
							 FROM entity_dependencies
							 WHERE source_entity_id = ? AND target_entity_id = ?
							   AND dependency_type = 'related_to' AND agent_id = ?
							 LIMIT 1`,
						)
						.get(ids[i], ids[j], agentId) as
						| { id: string }
						| undefined;
					if (row) continue;
					const id = crypto.randomUUID();
					const reason = requireDependencyReason(
						"related_to",
						`co-occurred in remembered memory ${memoryId}`,
					);
					db.prepare(
						`INSERT INTO entity_dependencies
						 (id, source_entity_id, target_entity_id, agent_id,
						  dependency_type, strength, confidence, reason, created_at, updated_at)
						 VALUES (?, ?, ?, ?, 'related_to', 0.3, 0.5, ?, ?, ?)`,
					).run(id, ids[i], ids[j], agentId, reason, now, now);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					if (!msg.includes("UNIQUE constraint")) throw e;
				}
			}
		}
	}

	return { linked, entityIds, aspects: aspectCount, attributes: attributeCount };
}
