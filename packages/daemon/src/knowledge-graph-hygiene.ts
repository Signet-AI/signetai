import type { DbAccessor } from "./db-accessor";

const GENERIC_ENTITY_NAMES = new Set([
	"a",
	"an",
	"and",
	"are",
	"be",
	"being",
	"but",
	"can",
	"did",
	"do",
	"does",
	"for",
	"from",
	"had",
	"has",
	"have",
	"he",
	"her",
	"him",
	"his",
	"i",
	"in",
	"is",
	"it",
	"its",
	"of",
	"on",
	"or",
	"she",
	"that",
	"the",
	"their",
	"them",
	"they",
	"this",
	"to",
	"was",
	"we",
	"were",
	"with",
	"you",
	"your",
]);

export interface SuspiciousEntity {
	readonly id: string;
	readonly name: string;
	readonly canonicalName: string;
	readonly entityType: string;
	readonly mentions: number;
	readonly reason: string;
}

export interface DuplicateEntityGroup {
	readonly canonicalName: string;
	readonly count: number;
	readonly ids: string[];
	readonly names: string[];
}

export interface AttributeHygieneSummary {
	readonly missingGroupKey: number;
	readonly missingClaimKey: number;
	readonly missingSourceMemory: number;
}

export interface SafeMentionCandidate {
	readonly memoryId: string;
	readonly entityId: string;
	readonly entityName: string;
	readonly mentionText: string;
	readonly snippet: string;
}

export interface KnowledgeHygieneReport {
	readonly agentId: string;
	readonly suspiciousEntities: SuspiciousEntity[];
	readonly duplicateEntities: DuplicateEntityGroup[];
	readonly attributeSummary: AttributeHygieneSummary;
	readonly safeMentionCandidates: SafeMentionCandidate[];
}

function normalize(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function reasonForEntity(name: string, canonicalName: string, mentions: number): string | null {
	const canonical = normalize(canonicalName || name);
	if (canonical.length < 2) return "too_short";
	if (GENERIC_ENTITY_NAMES.has(canonical)) return "generic_word";
	if (/^\d+$/.test(canonical)) return "numeric_only";
	if (mentions === 0) return "zero_mentions";
	return null;
}

function snippet(content: string, match: string): string {
	const index = content.toLowerCase().indexOf(match.toLowerCase());
	if (index < 0) return content.slice(0, 160);
	const start = Math.max(0, index - 60);
	const end = Math.min(content.length, index + match.length + 60);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < content.length ? "..." : "";
	return `${prefix}${content.slice(start, end)}${suffix}`.replace(/\s+/g, " ").trim();
}

function hasMention(content: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, "iu").test(content);
}

export function getKnowledgeHygieneReport(
	accessor: DbAccessor,
	opts: { readonly agentId: string; readonly limit?: number; readonly memoryLimit?: number },
): KnowledgeHygieneReport {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
	const memoryLimit = Math.min(Math.max(opts.memoryLimit ?? 200, 1), 1000);

	return accessor.withReadDb((db) => {
		const entities = db
			.prepare(
				`SELECT id, name, canonical_name, entity_type, mentions
				 FROM entities
				 WHERE agent_id = ?
				 ORDER BY updated_at DESC
				 LIMIT ?`,
			)
			.all(opts.agentId, Math.max(limit * 4, 100)) as Array<{
			id: string;
			name: string;
			canonical_name: string | null;
			entity_type: string;
			mentions: number | null;
		}>;

		const suspiciousEntities = entities
			.flatMap((entity): SuspiciousEntity[] => {
				const reason = reasonForEntity(entity.name, entity.canonical_name ?? entity.name, entity.mentions ?? 0);
				return reason
					? [
							{
								id: entity.id,
								name: entity.name,
								canonicalName: entity.canonical_name ?? normalize(entity.name),
								entityType: entity.entity_type,
								mentions: entity.mentions ?? 0,
								reason,
							},
						]
					: [];
			})
			.slice(0, limit);

		const duplicateEntities = (
			db
				.prepare(
					`SELECT canonical_name, COUNT(*) AS count,
					        GROUP_CONCAT(id, char(31)) AS ids,
					        GROUP_CONCAT(name, char(31)) AS names
					 FROM entities
					 WHERE agent_id = ?
					   AND canonical_name IS NOT NULL
					   AND TRIM(canonical_name) != ''
					 GROUP BY canonical_name
					 HAVING COUNT(*) > 1
					 ORDER BY count DESC, canonical_name ASC
					 LIMIT ?`,
				)
				.all(opts.agentId, limit) as Array<{
				canonical_name: string;
				count: number;
				ids: string | null;
				names: string | null;
			}>
		).map((row) => ({
			canonicalName: row.canonical_name,
			count: row.count,
			ids: row.ids?.split("\u001f") ?? [],
			names: row.names?.split("\u001f") ?? [],
		}));

		const attributeSummary = db
			.prepare(
				`SELECT
				   SUM(CASE WHEN group_key IS NULL OR TRIM(group_key) = '' THEN 1 ELSE 0 END) AS missingGroupKey,
				   SUM(CASE WHEN claim_key IS NULL OR TRIM(claim_key) = '' THEN 1 ELSE 0 END) AS missingClaimKey,
				   SUM(CASE WHEN memory_id IS NULL
				             OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = entity_attributes.memory_id)
				            THEN 1 ELSE 0 END) AS missingSourceMemory
				 FROM entity_attributes
				 WHERE agent_id = ?
				   AND status = 'active'`,
			)
			.get(opts.agentId) as {
			missingGroupKey: number | null;
			missingClaimKey: number | null;
			missingSourceMemory: number | null;
		};

		const memories = db
			.prepare(
				`SELECT id, content
				 FROM memories
				 WHERE agent_id = ?
				   AND is_deleted = 0
				 ORDER BY created_at DESC
				 LIMIT ?`,
			)
			.all(opts.agentId, memoryLimit) as Array<{ id: string; content: string }>;

		const safeMentionCandidates: SafeMentionCandidate[] = [];
		const knownEntities = entities.filter(
			(entity) => !reasonForEntity(entity.name, entity.canonical_name ?? entity.name, 1),
		);
		for (const memory of memories) {
			if (safeMentionCandidates.length >= limit) break;
			for (const entity of knownEntities) {
				if (safeMentionCandidates.length >= limit) break;
				if (!hasMention(memory.content, entity.name)) continue;
				const existing = db
					.prepare(
						`SELECT 1 FROM memory_entity_mentions
						 WHERE memory_id = ? AND entity_id = ?
						 LIMIT 1`,
					)
					.get(memory.id, entity.id) as unknown | undefined;
				if (existing) continue;
				safeMentionCandidates.push({
					memoryId: memory.id,
					entityId: entity.id,
					entityName: entity.name,
					mentionText: entity.name,
					snippet: snippet(memory.content, entity.name),
				});
			}
		}

		return {
			agentId: opts.agentId,
			suspiciousEntities,
			duplicateEntities,
			attributeSummary: {
				missingGroupKey: attributeSummary.missingGroupKey ?? 0,
				missingClaimKey: attributeSummary.missingClaimKey ?? 0,
				missingSourceMemory: attributeSummary.missingSourceMemory ?? 0,
			},
			safeMentionCandidates,
		};
	});
}
