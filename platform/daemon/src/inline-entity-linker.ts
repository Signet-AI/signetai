import type { ReadDb, WriteDb } from "./db-accessor";
import { countChanges } from "./db-helpers";
const SKIP_WORDS = new Set([
	"the",
	"this",
	"that",
	"these",
	"those",
	"there",
	"then",
	"what",
	"when",
	"where",
	"which",
	"while",
	"who",
	"whom",
	"how",
	"here",
	"have",
	"has",
	"had",
	"his",
	"her",
	"its",
	"our",
	"your",
	"their",
	"some",
	"any",
	"all",
	"each",
	"every",
	"both",
	"few",
	"more",
	"most",
	"many",
	"much",
	"other",
	"another",
	"such",
	"like",
	"just",
	"also",
	"only",
	"very",
	"really",
	"quite",
	"rather",
	"still",
	"already",
	"even",
	"never",
	"always",
	"often",
	"sometimes",
	"usually",
	"about",
	"after",
	"before",
	"between",
	"during",
	"since",
	"until",
	"into",
	"onto",
	"from",
	"with",
	"without",
	"through",
	"across",
	"along",
	"around",
	"behind",
	"below",
	"above",
	"under",
	"over",
	"near",
	"next",
	"last",
	"first",
	"second",
	"third",
	"new",
	"old",
	"good",
	"great",
	"best",
	"well",
	"long",
	"high",
	"low",
	"big",
	"small",
	"large",
	"little",
	"much",
	"own",
	"same",
	"different",
	"important",
	"sure",
	"true",
	"right",
	"left",
	"yes",
	"not",
	"but",
	"and",
	"for",
	"nor",
	"yet",
	"can",
	"may",
	"will",
	"shall",
	"should",
	"would",
	"could",
	"might",
	"must",
	"does",
	"did",
	"been",
	"being",
	"are",
	"was",
	"were",
	"note",
	"also",
	"however",
	"therefore",
	"thus",
	"moreover",
	"furthermore",
	"additionally",
	"meanwhile",
	"recently",
	"currently",
	"previously",
	"originally",
	"apparently",
	"specifically",
	"essentially",
	"generally",
	"typically",
	"particularly",
	"especially",
	"actually",
	"unfortunately",
	"fortunately",
	"certainly",
	"obviously",
	"basically",
	"exactly",
	"simply",
	"finally",
	"initially",
	"key",
	"facts",
	"preferences",
	"events",
	"relationships",
]);
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

function findKnownEntityId(db: ReadDb, name: string, agentId: string): string {
	const canonical = name.trim().toLowerCase().replace(/\s+/g, " ");
	if (canonical.length < 3) return "";

	const existing = db
		.prepare(
			`SELECT id FROM entities
			 WHERE (canonical_name = ? OR name = ?) AND agent_id = ?
			 LIMIT 1`,
		)
		.get(canonical, name, agentId) as { id: string } | undefined;

	return existing?.id ?? "";
}

function resolveKnownEntity(db: WriteDb, name: string, agentId: string, now: string): string {
	const entityId = findKnownEntityId(db, name, agentId);
	if (!entityId) return "";
	db.prepare("UPDATE entities SET mentions = mentions + 1, updated_at = ? WHERE id = ?").run(now, entityId);
	return entityId;
}

export interface LinkResult {
	readonly linked: number;
	readonly entityIds: string[];
	readonly aspects: number;
	readonly attributes: number;
}
export function previewMemoryEntityLinks(db: ReadDb, memoryId: string, content: string, agentId: string): LinkResult {
	const names = extractCandidateNames(content);
	if (names.length === 0) return { linked: 0, entityIds: [], aspects: 0, attributes: 0 };

	let linked = 0;
	const entityIds: string[] = [];
	for (const name of names) {
		const entityId = findKnownEntityId(db, name, agentId);
		if (!entityId) continue;
		entityIds.push(entityId);
		const existingMention = db
			.prepare("SELECT 1 FROM memory_entity_mentions WHERE memory_id = ? AND entity_id = ? LIMIT 1")
			.get(memoryId, entityId);
		if (!existingMention) linked++;
	}

	return { linked, entityIds, aspects: 0, attributes: 0 };
}
export function linkMemoryToEntities(db: WriteDb, memoryId: string, content: string, agentId: string): LinkResult {
	const names = extractCandidateNames(content);
	if (names.length === 0) return { linked: 0, entityIds: [], aspects: 0, attributes: 0 };

	const now = new Date().toISOString();
	let linked = 0;
	const entityIds: string[] = [];

	for (const name of names) {
		const entityId = resolveKnownEntity(db, name, agentId, now);
		if (!entityId) continue;
		entityIds.push(entityId);

		const ins = db
			.prepare(
				`INSERT OR IGNORE INTO memory_entity_mentions
			 (memory_id, entity_id, mention_text, confidence, created_at)
			 VALUES (?, ?, ?, 0.8, ?)`,
			)
			.run(memoryId, entityId, name, now);
		if (countChanges(ins) > 0) linked++;
	}

	return { linked, entityIds, aspects: 0, attributes: 0 };
}
