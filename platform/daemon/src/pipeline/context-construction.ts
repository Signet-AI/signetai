import { redactCredentials } from "@signet/core";
import type { DbOwnerClient } from "../db-owner-client";
import { ownerReadAll } from "../db-owner-sql";
import { type ReadScope, requireReadScope } from "../read-scope";
import { derivedScopeSql } from "../read-scope-tables";
import { memoryOriginEligibilitySql, type MemorySearchFilterClause } from "../memory-search-filters";

export interface ConstructedProvenance {
	readonly entityId: string;
	readonly compartmentIds: readonly number[];
	readonly attributeIds: readonly string[];
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
	readonly compartment_id: number | null;
	readonly id: string;
	readonly name: string;
	readonly entity_type: string;
}

interface AspectRow {
	readonly compartment_id: number | null;
	readonly id: string;
	readonly name: string;
}

interface AttributeRow {
	readonly id: string;
	readonly compartment_id: number | null;
	readonly content: string;
	readonly importance: number;
	readonly memory_id: string | null;
	readonly status: string;
}

interface ConstraintRow {
	readonly id: string;
	readonly compartment_id: number | null;
	readonly aspect_compartment_id: number | null;
	readonly content: string;
	readonly importance: number;
	readonly memory_id: string | null;
}

interface DependencyRow {
	readonly compartment_id: number | null;
	readonly target_compartment_id: number | null;
	readonly target_entity_id: string;
	readonly name: string;
}

const MAX_BLOCK_CHARS = 900;

function cleanValue(value: string): string {
	return redactCredentials(value).replace(/\s+/g, " ").trim();
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

export async function constructContextBlocksViaOwner(
	owner: DbOwnerClient,
	_agentId: string,
	focalEntityIds: ReadonlyArray<string>,
	limit: number,
	filter: MemorySearchFilterClause | undefined,
	allowUnlinked: boolean,
	readScope: ReadScope,
): Promise<ConstructedContextSnapshot> {
	const scope = requireReadScope(readScope);
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
	const clause = (alias: string) => derivedScopeSql(alias, scope, { memory: null, session: null, source: null });
	const entityScope = clause("e");
	const aspectScope = clause("asp");
	const attributeScope = clause("ea");
	const dependencyScope = clause("ed");
	const entityIds = [...new Set(focalEntityIds)];
	const entities: EntityRow[] = [];
	for (let offset = 0; offset < entityIds.length; offset += 100) {
		const batch = entityIds.slice(offset, offset + 100);
		const placeholders = batch.map(() => "?").join(", ");
		entities.push(
			...(await query<EntityRow>(
				`SELECT e.id, e.name, e.entity_type, e.compartment_id FROM entities e WHERE e.id IN (${placeholders})${entityScope.sql}`,
				[...batch, ...entityScope.args],
				"memory-search.constructed.entities",
				batch.length,
			)),
		);
	}
	if (entities.length === 0) return { blocks: [], entities: [] };

	const originEligibility = filter ? memoryOriginEligibilitySql("ea", filter, allowUnlinked) : "1 = 1";
	const validEntities = entities.map((entity) => entity.id);
	const aspects: Array<AspectRow & { readonly entity_id: string; readonly aspect_rank: number }> = [];
	for (let offset = 0; offset < validEntities.length; offset += 100) {
		const batch = validEntities.slice(offset, offset + 100);
		const placeholders = batch.map(() => "?").join(", ");
		aspects.push(
			...(await query<AspectRow & { readonly entity_id: string; readonly aspect_rank: number }>(
				`SELECT id, name, entity_id, compartment_id, aspect_rank FROM (
				 SELECT id, name, entity_id, compartment_id,
				        row_number() OVER (PARTITION BY entity_id ORDER BY weight DESC) AS aspect_rank
				 FROM entity_aspects asp WHERE entity_id IN (${placeholders})${aspectScope.sql}
				) WHERE aspect_rank <= 10 ORDER BY entity_id, aspect_rank`,
				[...batch, ...aspectScope.args],
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
				`SELECT id, compartment_id, aspect_id, content, importance, memory_id, status FROM (
				 SELECT ea.id, ea.compartment_id, ea.aspect_id, ea.content, ea.importance, ea.memory_id, ea.status,
				        row_number() OVER (PARTITION BY ea.aspect_id ORDER BY ea.importance DESC) AS attribute_rank
				 FROM entity_attributes ea
				 WHERE ea.aspect_id IN (${placeholders})${attributeScope.sql}
				   AND ea.status = 'active' AND ea.kind != 'constraint'
				   AND ${originEligibility}
				) WHERE attribute_rank <= 5 ORDER BY aspect_id, attribute_rank`,
				[...batch, ...attributeScope.args, ...(filter?.args ?? [])],
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
					`SELECT id, compartment_id, aspect_compartment_id, entity_id, content, importance, memory_id FROM (
				 SELECT ea.id, ea.compartment_id, asp.compartment_id AS aspect_compartment_id, asp.entity_id, ea.content, ea.importance, ea.memory_id,
				        row_number() OVER (PARTITION BY asp.entity_id ORDER BY ea.importance DESC) AS constraint_rank
				 FROM entity_aspects asp
				 JOIN entity_attributes ea ON ea.aspect_id = asp.id
				 WHERE asp.entity_id IN (${placeholders})${aspectScope.sql}${attributeScope.sql}
				   AND ea.kind = 'constraint' AND ea.status = 'active'
				   AND ${originEligibility}
				) WHERE constraint_rank <= 10 ORDER BY entity_id, constraint_rank`,
					[...batch, ...aspectScope.args, ...attributeScope.args, ...(filter?.args ?? [])],
					"memory-search.constructed.constraints",
					batch.length * 10,
				)),
			);
		}
	}

	const dependencyEligibility =
		filter && !allowUnlinked
			? `AND ed.aspect_id IS NOT NULL AND EXISTS (
			SELECT 1 FROM entity_attributes ea
			WHERE ea.aspect_id = ed.aspect_id AND ea.agent_id = ed.agent_id${attributeScope.sql}
			  AND ea.kind != 'constraint' AND ea.status = 'active'
			  AND ${originEligibility}
		)`
			: "";
	const dependencies: Array<DependencyRow & { readonly source_entity_id: string }> = [];
	if (limit > 0) {
		for (let offset = 0; offset < validEntities.length; offset += 100) {
			const batch = validEntities.slice(offset, offset + 100);
			const placeholders = batch.map(() => "?").join(", ");
			dependencies.push(
				...(await query<DependencyRow & { readonly source_entity_id: string }>(
					`SELECT source_entity_id, target_entity_id, name, compartment_id, target_compartment_id FROM (
				 SELECT ed.compartment_id, e.compartment_id AS target_compartment_id, ed.source_entity_id, ed.target_entity_id, e.name,
				        row_number() OVER (PARTITION BY ed.source_entity_id ORDER BY ed.strength DESC) AS dependency_rank
				 FROM entity_dependencies ed
				 JOIN entities e ON e.id = ed.target_entity_id AND e.agent_id = ed.agent_id
				 WHERE ed.source_entity_id IN (${placeholders})${dependencyScope.sql}${entityScope.sql} AND ed.strength >= 0.3
				   ${dependencyEligibility}
				) WHERE dependency_rank <= 8 ORDER BY source_entity_id, dependency_rank`,
					[
						...batch,
						...dependencyScope.args,
						...entityScope.args,
						...(filter && !allowUnlinked ? [...attributeScope.args, ...filter.args] : []),
					],
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
		const values = attributesByAspect.get(attribute.aspect_id) ?? [];
		values.push(attribute);
		attributesByAspect.set(attribute.aspect_id, values);
	}
	const constraintsByEntity = new Map<string, Array<(typeof constraints)[number]>>();
	for (const constraint of constraints) {
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
					content: redactCredentials(attribute.content),
					status: attribute.status,
					importance: attribute.importance,
				}));
			return values.length > 0 ? [{ name: aspect.name, attributes: values }] : [];
		});
		if (contextAspects.length > 0)
			structured.push({ name: entity.name, type: entity.entity_type, aspects: contextAspects });
		if (limit <= 0) continue;

		const labels = new Set<number>();
		const attributeIds: string[] = [];
		const addLabel = (value: number | null) => {
			if (value !== null) labels.add(value);
		};
		addLabel(entity.compartment_id);
		const lines: string[] = [];
		const aspectIdsForBlock: string[] = [];
		const aspectNames: string[] = [];
		let totalAttrs = 0;
		for (const aspect of entityAspects) {
			const included = (attributesByAspect.get(aspect.id) ?? []).filter((attribute) => !isNoise(attribute.content));
			const values = included.map((attribute) => cleanValue(attribute.content));
			if (values.length > 0) addLabel(aspect.compartment_id);
			for (const attribute of included) {
				addLabel(attribute.compartment_id);
				attributeIds.push(attribute.id);
			}
			if (values.length === 0) continue;
			aspectIdsForBlock.push(aspect.id);
			aspectNames.push(aspect.name);
			totalAttrs += values.length;
			lines.push(`- ${aspect.name}: ${values.join("; ")}`);
		}
		const includedConstraints = (constraintsByEntity.get(entity.id) ?? []).filter(
			(constraint) => !isNoise(constraint.content),
		);
		const cleanConstraints = includedConstraints.map((constraint) => cleanValue(constraint.content));
		for (const constraint of includedConstraints) {
			addLabel(constraint.compartment_id);
			addLabel(constraint.aspect_compartment_id);
			attributeIds.push(constraint.id);
		}
		if (cleanConstraints.length > 0) lines.push(`- Constraints: ${cleanConstraints.join("; ")}`);
		const related = dependenciesByEntity.get(entity.id) ?? [];
		for (const dependency of related) {
			addLabel(dependency.compartment_id);
			addLabel(dependency.target_compartment_id);
		}
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
				compartmentIds: [...labels].sort((a, b) => a - b),
				attributeIds: [...new Set(attributeIds)],
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
