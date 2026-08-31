/**
 * DP-7: Constructed memories with path provenance.
 *
 * Synthesizes purpose-built context blocks from knowledge graph
 * traversal paths. Each block combines entity attributes, constraints,
 * and dependency relationships into a coherent text representation
 * with provenance metadata for future path feedback (DP-9).
 *
 * No LLM calls — pure template synthesis.
 */

import { scanMemoryContent } from "@signet/core";
import type { DbOwnerClient } from "../db-owner-client";
import { ownerReadAll } from "../db-owner-sql";
import type { ReadDb } from "../db-accessor";
import { isMemoryContentContextEligible } from "../memory-content-safety";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

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
	// Require no space after ":" to distinguish machine-generated tags (project:signet)
	// from human-authored sentences ("Project: Signet daemon").
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

// ---------------------------------------------------------------------------
// Score normalization
// ---------------------------------------------------------------------------

/** Structural density score: more structure = higher score, clamped to [0, 1]. */
function densityScore(aspects: number, attrs: number, constraints: number): number {
	// Weighted sum: aspects contribute breadth, attributes depth,
	// constraints are high-value invariants worth extra weight.
	const raw = aspects * 0.15 + attrs * 0.05 + constraints * 0.2;
	return Math.min(1, Math.max(0, raw));
}

// ---------------------------------------------------------------------------
// Main construction function
// ---------------------------------------------------------------------------

export function constructContextBlocks(
	db: ReadDb,
	agentId: string,
	focalEntityIds: ReadonlyArray<string>,
	limit: number,
): ReadonlyArray<ConstructedContext> {
	if (focalEntityIds.length === 0) return [];

	const ph = focalEntityIds.map(() => "?").join(", ");
	const entities = db
		.prepare(
			`SELECT id, name, entity_type FROM entities
			 WHERE id IN (${ph})`,
		)
		.all(...focalEntityIds) as EntityRow[];

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
					`SELECT content, importance, memory_id FROM entity_attributes INDEXED BY idx_entity_attributes_aspect
					 WHERE aspect_id = ? AND agent_id = ?
					   AND status = 'active' AND kind != 'constraint'
					 ORDER BY importance DESC LIMIT 5`,
				)
				.all(asp.id, agentId) as AttributeRow[];

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

		// Constraints: always surface (invariant 5)
		const constraints = db
			.prepare(
				`SELECT DISTINCT ea.content, ea.importance, ea.memory_id
				 FROM entity_aspects asp INDEXED BY idx_entity_aspects_entity
				 CROSS JOIN entity_attributes ea INDEXED BY idx_entity_attributes_aspect
				   ON ea.aspect_id = asp.id
				 WHERE asp.entity_id = ? AND ea.agent_id = ?
				   AND ea.kind = 'constraint' AND ea.status = 'active'
				 ORDER BY ea.importance DESC LIMIT 10`,
			)
			.all(ent.id, agentId) as ConstraintRow[];

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

		// Dependencies: cross-reference names
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

	// Sort by density score descending, then truncate to limit
	blocks.sort((a, b) => b.score - a.score);
	return blocks.slice(0, limit);
}

/** Owner-bound constructed context for recall paths that cannot read parent SQLite. */
export async function constructContextBlocksViaOwner(
	owner: DbOwnerClient,
	agentId: string,
	focalEntityIds: ReadonlyArray<string>,
	limit: number,
): Promise<ReadonlyArray<ConstructedContext>> {
	if (focalEntityIds.length === 0) return [];
	const query = <Row extends object>(sql: string, params: readonly unknown[], operation: string) =>
		ownerReadAll<Row>(owner, sql, params, {
			operation,
			lane: "read",
			workloadClass: "foreground",
			deadlineMs: 30_000,
			estimatedWorkUnits: 200,
		});
	const ph = focalEntityIds.map(() => "?").join(", ");
	const entities = await query<EntityRow>(
		`SELECT id, name, entity_type FROM entities WHERE id IN (${ph})`,
		focalEntityIds,
		"memory-search.constructed.entities",
	);
	if (entities.length === 0) return [];

	let safetyTableExists: boolean | null = null;
	const eligible = async (content: string, memoryId: string | null): Promise<boolean> => {
		if (!scanMemoryContent(content).contextEligible) return false;
		if (!memoryId) return true;
		if (safetyTableExists === null) {
			try {
				const rows = await query<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_content_safety'",
					[],
					"memory-search.constructed.safety-table",
				);
				safetyTableExists = rows.length > 0;
			} catch {
				safetyTableExists = false;
			}
		}
		if (!safetyTableExists) return true;
		try {
			const rows = await query<{ status: string; context_eligible: number }>(
				`SELECT status, context_eligible FROM memory_content_safety
			 WHERE agent_id = ? AND source_kind = 'memory' AND source_id = ?`,
				[agentId, memoryId],
				"memory-search.constructed.safety-row",
			);
			const row = rows[0];
			return !row || (row.status === "clean" && row.context_eligible === 1);
		} catch {
			return false;
		}
	};

	const blocks: ConstructedContext[] = [];
	for (const ent of entities) {
		const aspects = await query<AspectRow>(
			`SELECT id, name FROM entity_aspects INDEXED BY idx_entity_aspects_entity
			 WHERE entity_id = ? AND agent_id = ?
			 ORDER BY weight DESC LIMIT 10`,
			[ent.id, agentId],
			"memory-search.constructed.aspects",
		);
		const lines: string[] = [];
		const aspectIds: string[] = [];
		const aspectNames: string[] = [];
		let totalAttrs = 0;

		for (const asp of aspects) {
			const attrs = await query<AttributeRow>(
				`SELECT content, importance, memory_id FROM entity_attributes INDEXED BY idx_entity_attributes_aspect
				 WHERE aspect_id = ? AND agent_id = ?
				   AND status = 'active' AND kind != 'constraint'
				 ORDER BY importance DESC LIMIT 5`,
				[asp.id, agentId],
				"memory-search.constructed.attributes",
			);
			const values: string[] = [];
			for (const attr of attrs) {
				if (!(await eligible(attr.content, attr.memory_id))) continue;
				const value = cleanValue(attr.content);
				if (!isNoise(value)) values.push(value);
			}
			if (values.length === 0) continue;
			aspectIds.push(asp.id);
			aspectNames.push(asp.name);
			totalAttrs += values.length;
			lines.push(`- ${asp.name}: ${values.join("; ")}`);
		}

		const constraints = await query<ConstraintRow>(
			`SELECT DISTINCT ea.content, ea.importance, ea.memory_id
			 FROM entity_aspects asp INDEXED BY idx_entity_aspects_entity
			 CROSS JOIN entity_attributes ea INDEXED BY idx_entity_attributes_aspect
			   ON ea.aspect_id = asp.id
			 WHERE asp.entity_id = ? AND ea.agent_id = ?
			   AND ea.kind = 'constraint' AND ea.status = 'active'
			 ORDER BY ea.importance DESC LIMIT 10`,
			[ent.id, agentId],
			"memory-search.constructed.constraints",
		);
		const cleanConstraints: string[] = [];
		for (const constraint of constraints) {
			if (!(await eligible(constraint.content, constraint.memory_id))) continue;
			const value = cleanValue(constraint.content);
			if (!isNoise(value)) cleanConstraints.push(value);
		}
		if (cleanConstraints.length > 0) lines.push(`- Constraints: ${cleanConstraints.join("; ")}`);

		const deps = await query<DependencyRow>(
			`SELECT ed.target_entity_id, e.name
			 FROM entity_dependencies ed INDEXED BY idx_entity_dependencies_source
			 JOIN entities e ON e.id = ed.target_entity_id
			 WHERE ed.source_entity_id = ? AND ed.agent_id = ?
			   AND ed.strength >= 0.3
			 ORDER BY ed.strength DESC LIMIT 8`,
			[ent.id, agentId],
			"memory-search.constructed.dependencies",
		);
		if (deps.length > 0) lines.push(`- Related: ${deps.map((dep) => dep.name).join(", ")}`);
		if (lines.length === 0) continue;

		const built = trimBlock(`[${ent.name} (${ent.entity_type})]\n${lines.join("\n")}`);
		blocks.push({
			content: built.text,
			truncated: built.truncated,
			score: densityScore(aspectIds.length, totalAttrs, cleanConstraints.length),
			source: "constructed",
			provenance: {
				entityId: ent.id,
				entityName: ent.name,
				entityType: ent.entity_type,
				aspectIds,
				aspectNames,
				attributeCount: totalAttrs,
				constraintCount: constraints.length,
				dependencyEntityIds: deps.map((dep) => dep.target_entity_id),
			},
		});
	}
	blocks.sort((a, b) => b.score - a.score);
	return blocks.slice(0, limit);
}
