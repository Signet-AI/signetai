import { scanMemoryContent } from "@signet/core";
import type { DbOwnerClient } from "../db-owner-client";
import { ownerReadAll } from "../db-owner-sql";
import type { ReadDb } from "../db-accessor";
import { memoryOriginEligibilitySql, type MemorySearchFilterClause } from "../memory-search-filters";
import { isMemoryContentContextEligible } from "../memory-content-safety";

export interface ConstructedProvenance {
	readonly entityId: string;
	readonly entityName: string;
	readonly entityType: string;
	readonly aspectIds: ReadonlyArray<string>;
	readonly aspectNames: ReadonlyArray<string>;
	readonly attributeCount: number;
	readonly constraintCount: number;
	readonly dependencyEntityIds: ReadonlyArray<string>;
}

export interface ConstructedContext {
	readonly content: string;
	readonly truncated: boolean;
	readonly score: number;
	readonly source: "constructed";
	readonly provenance: ConstructedProvenance;
}

export interface AuthorizedEntityContext {
	readonly name: string;
	readonly type: string;
	readonly aspects: Array<{
		readonly name: string;
		readonly attributes: Array<{ readonly content: string; readonly status: string; readonly importance: number }>;
	}>;
}

export interface ConstructedContextSnapshot {
	readonly blocks: ReadonlyArray<ConstructedContext>;
	readonly entities: Array<AuthorizedEntityContext>;
}

interface EntityRow {
	readonly id: string;
	readonly name: string;
	readonly entity_type: string;
}

interface AspectRow {
	readonly id: string;
	readonly name: string;
}

interface AttributeRow {
	readonly content: string;
	readonly importance: number;
	readonly memory_id: string | null;
	readonly status: string;
}

interface ConstraintRow {
	readonly content: string;
	readonly importance: number;
	readonly memory_id: string | null;
}

interface DependencyRow {
	readonly target_entity_id: string;
	readonly name: string;
}

const MAX_BLOCK_CHARS = 900;

function cleanValue(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function isNoise(value: string): boolean {
	const text = cleanValue(value).toLowerCase();
	if (text.length < 3) return true;
	if (/^\*+\s*:/.test(text)) return true;
	if (text.includes("[[memory/")) return true;
	if (/(^|[\s|])(session|source|latest|node|project|harness|compaction)=[^\s]/.test(text)) return true;
	if (/(^|[\s|])(session|source|latest|node|project|harness):[^\s]/.test(text)) return true;
	if (text.includes("#source:")) return true;
	return false;
}

function trimBlock(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_BLOCK_CHARS) {
		return { text, truncated: false };
	}
	return {
		text: `${text.slice(0, Math.max(1, MAX_BLOCK_CHARS - 3)).trimEnd()}...`,
		truncated: true,
	};
}
function densityScore(aspects: number, attrs: number, constraints: number): number {
	const raw = aspects * 0.15 + attrs * 0.05 + constraints * 0.2;
	return Math.min(1, Math.max(0, raw));
}

export function constructContextBlocks(
	db: ReadDb,
	agentId: string,
	focalEntityIds: ReadonlyArray<string>,
	limit: number,
	filter?: MemorySearchFilterClause,
	allowUnlinked = true,
): ReadonlyArray<ConstructedContext> {
	if (focalEntityIds.length === 0) return [];

	const ph = focalEntityIds.map(() => "?").join(", ");
	const originEligibility = filter ? memoryOriginEligibilitySql("ea", filter, allowUnlinked) : "1 = 1";
	const entities = db
		.prepare(
			`SELECT id, name, entity_type FROM entities
			 WHERE id IN (${ph}) AND agent_id = ?`,
		)
		.all(...focalEntityIds, agentId) as EntityRow[];

	if (entities.length === 0) return [];

	const blocks: ConstructedContext[] = [];

	for (const ent of entities) {
		const aspects = db
			.prepare(
				`SELECT id, name FROM entity_aspects INDEXED BY idx_entity_aspects_entity
				 WHERE entity_id = ? AND agent_id = ?
				 ORDER BY weight DESC LIMIT 10`,
			)
			.all(ent.id, agentId) as AspectRow[];

		const lines: string[] = [];
		const aspectIds: string[] = [];
		const aspectNames: string[] = [];
		let totalAttrs = 0;

		for (const asp of aspects) {
			const attrs = db
				.prepare(
					`SELECT content, importance, memory_id, status FROM entity_attributes INDEXED BY idx_entity_attributes_aspect
					 WHERE aspect_id = ? AND agent_id = ?
					   AND status = 'active' AND kind != 'constraint'
					   AND ${originEligibility}
					 ORDER BY importance DESC LIMIT 5`,
				)
				.all(asp.id, agentId, ...(filter?.args ?? [])) as AttributeRow[];

			const values = attrs
				.filter((a) =>
					a.memory_id
						? isMemoryContentContextEligible(db, {
								agentId,
								sourceKind: "memory",
								sourceId: a.memory_id,
								content: a.content,
							})
						: scanMemoryContent(a.content).contextEligible,
				)
				.map((a) => cleanValue(a.content))
				.filter((value) => !isNoise(value));
			if (values.length === 0) continue;

			aspectIds.push(asp.id);
			aspectNames.push(asp.name);
			totalAttrs += values.length;

			const vals = values.join("; ");
			lines.push(`- ${asp.name}: ${vals}`);
		}
		const constraints = db
			.prepare(
				`SELECT DISTINCT ea.content, ea.importance, ea.memory_id
				 FROM entity_aspects asp INDEXED BY idx_entity_aspects_entity
				 CROSS JOIN entity_attributes ea INDEXED BY idx_entity_attributes_aspect
				   ON ea.aspect_id = asp.id
				 WHERE asp.entity_id = ? AND ea.agent_id = ?
				   AND ea.kind = 'constraint' AND ea.status = 'active'
				   AND ${originEligibility}
				 ORDER BY ea.importance DESC LIMIT 10`,
			)
			.all(ent.id, agentId, ...(filter?.args ?? [])) as ConstraintRow[];

		const cleanConstraints = constraints
			.filter((c) =>
				c.memory_id
					? isMemoryContentContextEligible(db, {
							agentId,
							sourceKind: "memory",
							sourceId: c.memory_id,
							content: c.content,
						})
					: scanMemoryContent(c.content).contextEligible,
			)
			.map((c) => cleanValue(c.content))
			.filter((value) => !isNoise(value));
		if (cleanConstraints.length > 0) {
			const vals = cleanConstraints.join("; ");
			lines.push(`- Constraints: ${vals}`);
		}
		const deps = db
			.prepare(
				`SELECT ed.target_entity_id, e.name
				 FROM entity_dependencies ed INDEXED BY idx_entity_dependencies_source
				 JOIN entities e ON e.id = ed.target_entity_id
				 WHERE ed.source_entity_id = ? AND ed.agent_id = ?
				   AND ed.strength >= 0.3
				 ORDER BY ed.strength DESC LIMIT 8`,
			)
			.all(ent.id, agentId) as DependencyRow[];

		if (deps.length > 0) {
			lines.push(`- Related: ${deps.map((d) => d.name).join(", ")}`);
		}

		if (lines.length === 0) continue;

		const built = trimBlock(`[${ent.name} (${ent.entity_type})]\n${lines.join("\n")}`);
		const score = densityScore(aspectIds.length, totalAttrs, cleanConstraints.length);

		blocks.push({
			content: built.text,
			truncated: built.truncated,
			score,
			source: "constructed",
			provenance: {
				entityId: ent.id,
				entityName: ent.name,
				entityType: ent.entity_type,
				aspectIds,
				aspectNames,
				attributeCount: totalAttrs,
				constraintCount: constraints.length,
				dependencyEntityIds: deps.map((d) => d.target_entity_id),
			},
		});
	}
	blocks.sort((a, b) => b.score - a.score);
	return blocks.slice(0, limit);
}
export async function constructContextBlocksViaOwner(
	owner: DbOwnerClient,
	agentId: string,
	focalEntityIds: ReadonlyArray<string>,
	limit: number,
	filter?: MemorySearchFilterClause,
	allowUnlinked = true,
): Promise<ConstructedContextSnapshot> {
	if (focalEntityIds.length === 0) return { blocks: [], entities: [] };
	const query = <Row extends object>(
		sql: string,
		params: readonly unknown[],
		operation: string,
		estimatedWorkUnits = 200,
	) =>
		ownerReadAll<Row>(owner, sql, params, {
			operation,
			lane: "read",
			workloadClass: "foreground",
			deadlineMs: 30_000,
			estimatedWorkUnits: Math.min(10_000, estimatedWorkUnits),
		});
	const entityIds = [...new Set(focalEntityIds)];
	const entities: EntityRow[] = [];
	for (let offset = 0; offset < entityIds.length; offset += 100) {
		const batch = entityIds.slice(offset, offset + 100);
		const placeholders = batch.map(() => "?").join(", ");
		entities.push(
			...(await query<EntityRow>(
				`SELECT id, name, entity_type FROM entities WHERE id IN (${placeholders}) AND agent_id = ?`,
				[...batch, agentId],
				"memory-search.constructed.entities",
				batch.length,
			)),
		);
	}
	if (entities.length === 0) return { blocks: [], entities: [] };

	const safetyRows = await query<{ readonly name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_content_safety' LIMIT 1",
		[],
		"memory-search.constructed.safety-schema",
		1,
	);
	const hasSafetyLedger = safetyRows.length > 0;
	const safetyJoin = hasSafetyLedger
		? "LEFT JOIN memory_content_safety safety ON safety.agent_id = ea.agent_id AND safety.source_kind = 'memory' AND safety.source_id = ea.memory_id"
		: "";
	const safetyFilter = hasSafetyLedger
		? "AND (safety.source_id IS NULL OR (safety.status = 'clean' AND safety.context_eligible = 1))"
		: "";
	const originEligibility = filter ? memoryOriginEligibilitySql("ea", filter, allowUnlinked) : "1 = 1";
	const validEntities = entities.map((entity) => entity.id);
	const aspects: Array<AspectRow & { readonly entity_id: string; readonly aspect_rank: number }> = [];
	for (let offset = 0; offset < validEntities.length; offset += 100) {
		const batch = validEntities.slice(offset, offset + 100);
		const placeholders = batch.map(() => "?").join(", ");
		aspects.push(
			...(await query<AspectRow & { readonly entity_id: string; readonly aspect_rank: number }>(
				`SELECT id, name, entity_id, aspect_rank FROM (
				 SELECT id, name, entity_id,
				        row_number() OVER (PARTITION BY entity_id ORDER BY weight DESC) AS aspect_rank
				 FROM entity_aspects WHERE entity_id IN (${placeholders}) AND agent_id = ?
				) WHERE aspect_rank <= 10 ORDER BY entity_id, aspect_rank`,
				[...batch, agentId],
				"memory-search.constructed.aspects",
				batch.length * 10,
			)),
		);
	}

	const attributes: Array<AttributeRow & { readonly aspect_id: string }> = [];
	const aspectIds = aspects.map((aspect) => aspect.id);
	for (let offset = 0; offset < aspectIds.length; offset += 100) {
		const batch = aspectIds.slice(offset, offset + 100);
		const placeholders = batch.map(() => "?").join(", ");
		attributes.push(
			...(await query<AttributeRow & { readonly aspect_id: string }>(
				`SELECT aspect_id, content, importance, memory_id, status FROM (
				 SELECT ea.aspect_id, ea.content, ea.importance, ea.memory_id, ea.status,
				        row_number() OVER (PARTITION BY ea.aspect_id ORDER BY ea.importance DESC) AS attribute_rank
				 FROM entity_attributes ea ${safetyJoin}
				 WHERE ea.aspect_id IN (${placeholders}) AND ea.agent_id = ?
				   AND ea.status = 'active' AND ea.kind != 'constraint'
				   AND ${originEligibility} ${safetyFilter}
				) WHERE attribute_rank <= 5 ORDER BY aspect_id, attribute_rank`,
				[...batch, agentId, ...(filter?.args ?? [])],
				"memory-search.constructed.attributes",
				batch.length * 5,
			)),
		);
	}

	const constraints: Array<ConstraintRow & { readonly entity_id: string }> = [];
	if (limit > 0) {
		for (let offset = 0; offset < validEntities.length; offset += 100) {
			const batch = validEntities.slice(offset, offset + 100);
			const placeholders = batch.map(() => "?").join(", ");
			constraints.push(
				...(await query<ConstraintRow & { readonly entity_id: string }>(
					`SELECT entity_id, content, importance, memory_id FROM (
				 SELECT asp.entity_id, ea.content, ea.importance, ea.memory_id,
				        row_number() OVER (PARTITION BY asp.entity_id ORDER BY ea.importance DESC) AS constraint_rank
				 FROM entity_aspects asp
				 JOIN entity_attributes ea ON ea.aspect_id = asp.id ${safetyJoin}
				 WHERE asp.entity_id IN (${placeholders}) AND asp.agent_id = ? AND ea.agent_id = ?
				   AND ea.kind = 'constraint' AND ea.status = 'active'
				   AND ${originEligibility} ${safetyFilter}
				) WHERE constraint_rank <= 10 ORDER BY entity_id, constraint_rank`,
					[...batch, agentId, agentId, ...(filter?.args ?? [])],
					"memory-search.constructed.constraints",
					batch.length * 10,
				)),
			);
		}
	}

	const dependencyEligibility =
		filter && !allowUnlinked
			? `AND ed.aspect_id IS NOT NULL AND EXISTS (
			SELECT 1 FROM entity_attributes ea ${safetyJoin}
			WHERE ea.aspect_id = ed.aspect_id AND ea.agent_id = ed.agent_id
			  AND ea.kind != 'constraint' AND ea.status = 'active'
			  AND ${originEligibility} ${safetyFilter}
		)`
			: "";
	const dependencies: Array<DependencyRow & { readonly source_entity_id: string }> = [];
	if (limit > 0) {
		for (let offset = 0; offset < validEntities.length; offset += 100) {
			const batch = validEntities.slice(offset, offset + 100);
			const placeholders = batch.map(() => "?").join(", ");
			dependencies.push(
				...(await query<DependencyRow & { readonly source_entity_id: string }>(
					`SELECT source_entity_id, target_entity_id, name FROM (
				 SELECT ed.source_entity_id, ed.target_entity_id, e.name,
				        row_number() OVER (PARTITION BY ed.source_entity_id ORDER BY ed.strength DESC) AS dependency_rank
				 FROM entity_dependencies ed
				 JOIN entities e ON e.id = ed.target_entity_id AND e.agent_id = ed.agent_id
				 WHERE ed.source_entity_id IN (${placeholders}) AND ed.agent_id = ? AND ed.strength >= 0.3
				   ${dependencyEligibility}
				) WHERE dependency_rank <= 8 ORDER BY source_entity_id, dependency_rank`,
					[...batch, agentId, ...(filter && !allowUnlinked ? filter.args : [])],
					"memory-search.constructed.dependencies",
					batch.length * 8,
				)),
			);
		}
	}

	const aspectsByEntity = new Map<string, Array<(typeof aspects)[number]>>();
	for (const aspect of aspects) {
		const values = aspectsByEntity.get(aspect.entity_id) ?? [];
		values.push(aspect);
		aspectsByEntity.set(aspect.entity_id, values);
	}
	const attributesByAspect = new Map<string, Array<(typeof attributes)[number]>>();
	for (const attribute of attributes) {
		if (!scanMemoryContent(attribute.content).contextEligible) continue;
		const values = attributesByAspect.get(attribute.aspect_id) ?? [];
		values.push(attribute);
		attributesByAspect.set(attribute.aspect_id, values);
	}
	const constraintsByEntity = new Map<string, Array<(typeof constraints)[number]>>();
	for (const constraint of constraints) {
		if (!scanMemoryContent(constraint.content).contextEligible) continue;
		const values = constraintsByEntity.get(constraint.entity_id) ?? [];
		values.push(constraint);
		constraintsByEntity.set(constraint.entity_id, values);
	}
	const dependenciesByEntity = new Map<string, Array<(typeof dependencies)[number]>>();
	for (const dependency of dependencies) {
		const values = dependenciesByEntity.get(dependency.source_entity_id) ?? [];
		values.push(dependency);
		dependenciesByEntity.set(dependency.source_entity_id, values);
	}

	const blocks: ConstructedContext[] = [];
	const structured: AuthorizedEntityContext[] = [];
	for (const entity of entities) {
		const entityAspects = aspectsByEntity.get(entity.id) ?? [];
		const contextAspects = entityAspects.flatMap((aspect) => {
			const values = (attributesByAspect.get(aspect.id) ?? [])
				.filter((attribute) => !isNoise(attribute.content))
				.map((attribute) => ({
					content: attribute.content,
					status: attribute.status,
					importance: attribute.importance,
				}));
			return values.length > 0 ? [{ name: aspect.name, attributes: values }] : [];
		});
		if (contextAspects.length > 0)
			structured.push({ name: entity.name, type: entity.entity_type, aspects: contextAspects });
		if (limit <= 0) continue;

		const lines: string[] = [];
		const aspectIdsForBlock: string[] = [];
		const aspectNames: string[] = [];
		let totalAttrs = 0;
		for (const aspect of entityAspects) {
			const values = (attributesByAspect.get(aspect.id) ?? [])
				.map((attribute) => cleanValue(attribute.content))
				.filter((value) => !isNoise(value));
			if (values.length === 0) continue;
			aspectIdsForBlock.push(aspect.id);
			aspectNames.push(aspect.name);
			totalAttrs += values.length;
			lines.push(`- ${aspect.name}: ${values.join("; ")}`);
		}
		const cleanConstraints = (constraintsByEntity.get(entity.id) ?? [])
			.map((constraint) => cleanValue(constraint.content))
			.filter((value) => !isNoise(value));
		if (cleanConstraints.length > 0) lines.push(`- Constraints: ${cleanConstraints.join("; ")}`);
		const related = dependenciesByEntity.get(entity.id) ?? [];
		if (related.length > 0) lines.push(`- Related: ${related.map((dependency) => dependency.name).join(", ")}`);
		if (lines.length === 0) continue;
		const built = trimBlock(`[${entity.name} (${entity.entity_type})]\n${lines.join("\n")}`);
		blocks.push({
			content: built.text,
			truncated: built.truncated,
			score: densityScore(aspectIdsForBlock.length, totalAttrs, cleanConstraints.length),
			source: "constructed",
			provenance: {
				entityId: entity.id,
				entityName: entity.name,
				entityType: entity.entity_type,
				aspectIds: aspectIdsForBlock,
				aspectNames,
				attributeCount: totalAttrs,
				constraintCount: cleanConstraints.length,
				dependencyEntityIds: related.map((dependency) => dependency.target_entity_id),
			},
		});
	}
	blocks.sort((left, right) => right.score - left.score);
	return { blocks: blocks.slice(0, limit), entities: structured };
}
