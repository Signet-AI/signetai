/**
 * DP-7: Constructed memories with path provenance.
 *
 * This module assembles prompt-facing entity and constructed context from a
 * bounded raw snapshot. SQLite access and snapshot accounting live in
 * context-snapshot.ts; no content scanning occurs in an owner callback.
 */

import { scanMemoryContent } from "@signet/core";
import { yieldEvery } from "../async-yield";
import type { DbOwnerClient } from "../db-owner-client";
import {
	loadContextSnapshotViaOwner,
	CONTEXT_MAX_ATTRIBUTES_PER_ASPECT,
	type AspectRow,
	type AttributeRow,
	type ConstraintRow,
	type DependencyRow,
	type ContextSnapshot,
} from "./context-snapshot";

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

export interface PreparedContextRows {
	/** All safe active attributes, used by the entity-context view. */
	readonly attributesByAspect: ReadonlyMap<string, ReadonlyArray<AttributeRow>>;
	/** Safe non-constraint attributes, used by constructed cards. */
	readonly constructibleAttributesByAspect: ReadonlyMap<string, ReadonlyArray<AttributeRow>>;
	readonly constraintsByEntity: ReadonlyMap<string, ReadonlyArray<ConstraintRow>>;
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
	if (text.length <= MAX_BLOCK_CHARS) return { text, truncated: false };
	return {
		text: `${text.slice(0, Math.max(1, MAX_BLOCK_CHARS - 3)).trimEnd()}...`,
		truncated: true,
	};
}

/** Structural density score: more structure = higher score, clamped to [0, 1]. */
function densityScore(aspects: number, attrs: number, constraints: number): number {
	// Weighted sum: aspects contribute breadth, attributes depth,
	// constraints are high-value invariants worth extra weight.
	const raw = aspects * 0.15 + attrs * 0.05 + constraints * 0.2;
	return Math.min(1, Math.max(0, raw));
}

function normalizeBlockLimit(limit: number): number {
	if (!Number.isFinite(limit) || limit <= 0) return 0;
	return Math.max(1, Math.trunc(limit));
}

// ---------------------------------------------------------------------------
// Parent-side safety filtering and view assembly
// ---------------------------------------------------------------------------

function contextEligible(snapshot: ContextSnapshot, content: string, memoryId: string | null): boolean {
	if (!scanMemoryContent(content).contextEligible) return false;
	if (!memoryId) return true;
	if (snapshot.safetyLedger === "unavailable") return false;
	const persisted = snapshot.safety.get(memoryId);
	return !persisted || (persisted.status === "clean" && persisted.context_eligible === 1);
}

export async function prepareContextRows(snapshot: ContextSnapshot): Promise<PreparedContextRows> {
	const attributesByAspect = new Map<string, AttributeRow[]>();
	const constructibleAttributesByAspect = new Map<string, AttributeRow[]>();
	const constraintsByEntity = new Map<string, ConstraintRow[]>();
	const yieldRows = yieldEvery(100);
	for (const attribute of snapshot.attributes) {
		if (contextEligible(snapshot, attribute.content, attribute.memory_id)) {
			if (attribute.all_row_number <= CONTEXT_MAX_ATTRIBUTES_PER_ASPECT) {
				const rows = attributesByAspect.get(attribute.aspect_id) ?? [];
				rows.push(attribute);
				attributesByAspect.set(attribute.aspect_id, rows);
			}
			if (attribute.kind !== "constraint" && attribute.kind_row_number <= CONTEXT_MAX_ATTRIBUTES_PER_ASPECT) {
				const constructibleRows = constructibleAttributesByAspect.get(attribute.aspect_id) ?? [];
				constructibleRows.push(attribute);
				constructibleAttributesByAspect.set(attribute.aspect_id, constructibleRows);
			}
		}
		await yieldRows();
	}
	for (const constraint of snapshot.constraints) {
		if (contextEligible(snapshot, constraint.content, constraint.memory_id)) {
			const rows = constraintsByEntity.get(constraint.entity_id) ?? [];
			rows.push(constraint);
			constraintsByEntity.set(constraint.entity_id, rows);
		}
		await yieldRows();
	}
	return { attributesByAspect, constructibleAttributesByAspect, constraintsByEntity };
}

function buildEntityContextFromRows(
	snapshot: ContextSnapshot,
	prepared: PreparedContextRows,
): Array<{
	name: string;
	type: string;
	aspects: Array<{ name: string; attributes: Array<{ content: string; status: string; importance: number }> }>;
}> {
	const aspectsByEntity = new Map<string, AspectRow[]>();
	for (const aspect of snapshot.aspects) {
		const rows = aspectsByEntity.get(aspect.entity_id) ?? [];
		rows.push(aspect);
		aspectsByEntity.set(aspect.entity_id, rows);
	}
	const result: Array<{
		name: string;
		type: string;
		aspects: Array<{ name: string; attributes: Array<{ content: string; status: string; importance: number }> }>;
	}> = [];
	for (const entity of snapshot.entities) {
		const contextAspects: Array<{
			name: string;
			attributes: Array<{ content: string; status: string; importance: number }>;
		}> = [];
		for (const aspect of aspectsByEntity.get(entity.id) ?? []) {
			const attributes = (prepared.attributesByAspect.get(aspect.id) ?? []).map((attribute) => ({
				content: attribute.content,
				status: attribute.status,
				importance: attribute.importance,
			}));
			if (attributes.length > 0) contextAspects.push({ name: aspect.name, attributes });
		}
		if (contextAspects.length > 0)
			result.push({ name: entity.name, type: entity.entity_type, aspects: contextAspects });
	}
	return result;
}

/** Build prompt-facing entity context after the owner has released SQLite. */
export async function buildEntityContextFromSnapshot(
	snapshot: ContextSnapshot,
	prepared?: PreparedContextRows,
): Promise<
	Array<{
		name: string;
		type: string;
		aspects: Array<{
			name: string;
			attributes: Array<{ content: string; status: string; importance: number }>;
		}>;
	}>
> {
	const rows = prepared ?? (await prepareContextRows(snapshot));
	return buildEntityContextFromRows(snapshot, rows);
}

function buildConstructedContextFromRows(
	snapshot: ContextSnapshot,
	prepared: PreparedContextRows,
	limit: number,
): ReadonlyArray<ConstructedContext> {
	const aspectsByEntity = new Map<string, AspectRow[]>();
	for (const aspect of snapshot.aspects) {
		const rows = aspectsByEntity.get(aspect.entity_id) ?? [];
		rows.push(aspect);
		aspectsByEntity.set(aspect.entity_id, rows);
	}
	const dependenciesByEntity = new Map<string, DependencyRow[]>();
	for (const dependency of snapshot.dependencies) {
		const rows = dependenciesByEntity.get(dependency.source_entity_id) ?? [];
		rows.push(dependency);
		dependenciesByEntity.set(dependency.source_entity_id, rows);
	}
	const blocks: ConstructedContext[] = [];
	for (const entity of snapshot.entities) {
		const lines: string[] = [];
		const aspectIds: string[] = [];
		const aspectNames: string[] = [];
		let totalAttrs = 0;
		for (const aspect of aspectsByEntity.get(entity.id) ?? []) {
			const values = (prepared.constructibleAttributesByAspect.get(aspect.id) ?? [])
				.map((attribute) => cleanValue(attribute.content))
				.filter((value) => !isNoise(value));
			if (values.length === 0) continue;
			aspectIds.push(aspect.id);
			aspectNames.push(aspect.name);
			totalAttrs += values.length;
			lines.push(`- ${aspect.name}: ${values.join("; ")}`);
		}

		const constraints = prepared.constraintsByEntity.get(entity.id) ?? [];
		const cleanConstraints = constraints
			.map((constraint) => cleanValue(constraint.content))
			.filter((value) => !isNoise(value));
		if (cleanConstraints.length > 0) lines.push(`- Constraints: ${cleanConstraints.join("; ")}`);

		const dependencies = dependenciesByEntity.get(entity.id) ?? [];
		if (dependencies.length > 0)
			lines.push(`- Related: ${dependencies.map((dependency) => dependency.name).join(", ")}`);
		if (lines.length === 0) continue;

		const built = trimBlock(`[${entity.name} (${entity.entity_type})]\n${lines.join("\n")}`);
		blocks.push({
			content: built.text,
			truncated: built.truncated,
			score: densityScore(aspectIds.length, totalAttrs, cleanConstraints.length),
			source: "constructed",
			provenance: {
				entityId: entity.id,
				entityName: entity.name,
				entityType: entity.entity_type,
				aspectIds,
				aspectNames,
				attributeCount: totalAttrs,
				constraintCount: constraints.length,
				dependencyEntityIds: dependencies.map((dependency) => dependency.target_entity_id),
			},
		});
	}
	blocks.sort((a, b) => b.score - a.score);
	return blocks.slice(0, normalizeBlockLimit(limit));
}

/**
 * Construct context from a previously loaded snapshot. This keeps all text
 * assembly and content handling outside the owner callback.
 */
export async function constructContextBlocksFromSnapshot(
	snapshot: ContextSnapshot,
	limit: number,
	prepared?: PreparedContextRows,
): Promise<ReadonlyArray<ConstructedContext>> {
	const rows = prepared ?? (await prepareContextRows(snapshot));
	return buildConstructedContextFromRows(snapshot, rows, limit);
}

/** Owner-bound constructed context for recall paths that cannot read parent SQLite. */
export async function constructContextBlocksViaOwner(
	owner: DbOwnerClient,
	agentId: string,
	focalEntityIds: ReadonlyArray<string>,
	limit: number,
): Promise<ReadonlyArray<ConstructedContext>> {
	const boundedLimit = normalizeBlockLimit(limit);
	if (boundedLimit === 0) return [];
	const snapshot = await loadContextSnapshotViaOwner(owner, agentId, focalEntityIds, boundedLimit);
	return await constructContextBlocksFromSnapshot(snapshot, boundedLimit);
}
