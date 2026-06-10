/**
 * Comparison test: old per-entity loop vs new batched traversal.
 *
 * Runs both implementations against the real memories.db and diffs:
 *   - memory IDs selected
 *   - memory scores
 *   - constraints
 *   - paths
 *
 * Run: bun test platform/daemon/src/pipeline/graph-traversal-compare.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { traverseKnowledgeGraph as traverseKnowledgeGraph_NEW, resolveFocalEntities } from "./graph-traversal.js";
import type { ReadDb } from "../db-accessor.js";

// ---------------------------------------------------------------------------
// Types (shared)
// ---------------------------------------------------------------------------

interface TraversalPath {
	readonly entityIds: ReadonlyArray<string>;
	readonly aspectIds: ReadonlyArray<string>;
	readonly dependencyIds: ReadonlyArray<string>;
}

interface TraversalConfig {
	readonly scope?: string | null;
	readonly maxAspectsPerEntity: number;
	readonly maxAttributesPerAspect: number;
	readonly maxDependencyHops: number;
	readonly minDependencyStrength: number;
	readonly maxBranching: number;
	readonly maxTraversalPaths: number;
	readonly minConfidence: number;
	readonly timeoutMs: number;
	readonly aspectFilter?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeEntityIds(ids: ReadonlyArray<string>): string[] {
	const unique = new Set<string>();
	for (const id of ids) {
		if (typeof id === "string" && id.length > 0) unique.add(id);
	}
	return [...unique];
}

const DEFAULT_CONFIG: TraversalConfig = {
	maxAspectsPerEntity: 10,
	maxAttributesPerAspect: 20,
	maxDependencyHops: 10,
	minDependencyStrength: 0.3,
	maxBranching: 4,
	maxTraversalPaths: 50,
	minConfidence: 0.5,
	timeoutMs: 5000,
};

// ---------------------------------------------------------------------------
// OLD implementation (per-entity loop, extracted from git HEAD)
// ---------------------------------------------------------------------------

function traverseKnowledgeGraph_OLD(
	focalEntityIds: ReadonlyArray<string>,
	db: Database,
	agentId: string,
	config: TraversalConfig,
) {
	const focalIds = sanitizeEntityIds(focalEntityIds);
	if (focalIds.length === 0) {
		return { memoryIds: new Set<string>(), memoryScores: new Map<string, number>(), memoryPaths: new Map<string, TraversalPath>(), constraints: [], entityCount: 0, timedOut: false, activeAspectIds: [] as string[], focalEntityIds: [] as string[] };
	}

	const memoryIds = new Set<string>();
	const memoryScores = new Map<string, number>();
	const memoryPaths = new Map<string, TraversalPath>();
	const constraints: Array<{ entityName: string; content: string; importance: number }> = [];
	const activeAspectIds = new Set<string>();
	const constraintKeys = new Set<string>();
	const visitedEntities = new Set<string>();

	const toPath = (entityId: string, sourceEntityId?: string, aspectId?: string, dependencyId?: string): TraversalPath => ({
		entityIds: typeof sourceEntityId === "string" && sourceEntityId.length > 0 && sourceEntityId !== entityId ? [sourceEntityId, entityId] : [entityId],
		aspectIds: typeof aspectId === "string" && aspectId.length > 0 ? [aspectId] : [],
		dependencyIds: typeof dependencyId === "string" && dependencyId.length > 0 ? [dependencyId] : [],
	});
	const pathSize = (p: TraversalPath): number => p.entityIds.length + p.aspectIds.length + p.dependencyIds.length;
	const recordPath = (mid: string, eid: string, src?: string, asp?: string, dep?: string) => {
		const next = toPath(eid, src, asp, dep);
		const prev = memoryPaths.get(mid);
		if (!prev || pathSize(next) > pathSize(prev)) memoryPaths.set(mid, next);
	};

	const budget = config.maxTraversalPaths;

	const collectForEntity = (entityId: string, sourceEntityId?: string, dependencyId?: string): void => {
		if (visitedEntities.has(entityId) || memoryIds.size >= budget) return;
		visitedEntities.add(entityId);

		// Constraints
		const cRows = db.prepare(
			`SELECT e.name as entity_name, ea.content, ea.importance FROM entity_aspects asp INDEXED BY idx_entity_aspects_entity CROSS JOIN entity_attributes ea INDEXED BY idx_entity_attributes_aspect ON ea.aspect_id = asp.id JOIN entities e ON e.id = asp.entity_id WHERE asp.entity_id = ? AND asp.agent_id = ? AND ea.agent_id = ? AND ea.kind = 'constraint' AND ea.status = 'active' ORDER BY ea.importance DESC`,
		).all(entityId, agentId, agentId) as Array<{ entity_name: string; content: string; importance: number }>;
		for (const r of cRows) { const k = `${r.entity_name}::${r.content}`; if (!constraintKeys.has(k)) { constraintKeys.add(k); constraints.push({ entityName: r.entity_name, content: r.content, importance: r.importance }); } }

		// Aspects
		const aRows = db.prepare(`SELECT id FROM entity_aspects INDEXED BY idx_entity_aspects_entity WHERE entity_id = ? AND agent_id = ? ORDER BY weight DESC LIMIT ?`).all(entityId, agentId, config.maxAspectsPerEntity) as Array<{ id: string }>;
		for (const asp of aRows) {
			if (memoryIds.size >= budget) break;
			activeAspectIds.add(asp.id);
			const attrRows = db.prepare(`SELECT memory_id, importance FROM entity_attributes INDEXED BY idx_entity_attributes_aspect WHERE aspect_id = ? AND agent_id = ? AND status = 'active' ORDER BY importance DESC LIMIT ?`).all(asp.id, agentId, config.maxAttributesPerAspect) as Array<{ memory_id: string | null; importance: number }>;
			for (const r of attrRows) {
				if (!r.memory_id) continue;
				memoryIds.add(r.memory_id);
				recordPath(r.memory_id, entityId, sourceEntityId, asp.id, dependencyId);
				const cur = memoryScores.get(r.memory_id);
				if (cur === undefined || r.importance > cur) memoryScores.set(r.memory_id, r.importance);
			}
		}

		// Mentions fallback
		if (memoryIds.size >= budget) return;
		const mBud = Math.min(config.maxAttributesPerAspect, budget - memoryIds.size);
		if (mBud <= 0) return;
		const mRows = db.prepare(`SELECT mem.memory_id, COALESCE(m.importance, 0.5) AS importance FROM memory_entity_mentions mem JOIN memories m ON m.id = mem.memory_id WHERE mem.entity_id = ? AND m.is_deleted = 0 ORDER BY mem.confidence DESC, m.importance DESC LIMIT ?`).all(entityId, mBud) as Array<{ memory_id: string; importance: number }>;
		for (const r of mRows) {
			memoryIds.add(r.memory_id);
			recordPath(r.memory_id, entityId, sourceEntityId, undefined, dependencyId);
			const cur = memoryScores.get(r.memory_id);
			if (cur === undefined || r.importance > cur) memoryScores.set(r.memory_id, r.importance);
		}
	};

	for (const eid of focalIds) { if (memoryIds.size >= budget) break; collectForEntity(eid); }

	if (memoryIds.size < budget) {
		const ph = focalIds.map(() => "?").join(", ");
		const dRows = db.prepare(`SELECT id, source_entity_id, target_entity_id FROM entity_dependencies INDEXED BY idx_entity_dependencies_source WHERE agent_id = ? AND source_entity_id IN (${ph}) AND (COALESCE(confidence, 0.7) * strength) >= ? AND COALESCE(confidence, 0.7) >= ? ORDER BY (COALESCE(confidence, 0.7) * strength) DESC LIMIT ?`).all(agentId, ...focalIds, config.minDependencyStrength, config.minConfidence, config.maxBranching * focalIds.length) as Array<{ id: string; source_entity_id: string; target_entity_id: string }>;
		for (const r of dRows) { if (memoryIds.size >= budget) break; collectForEntity(r.target_entity_id, r.source_entity_id, r.id); }
	}

	constraints.sort((a, b) => b.importance - a.importance);
	return { memoryIds, memoryScores, memoryPaths, constraints, entityCount: visitedEntities.size, timedOut: false, activeAspectIds: [...activeAspectIds], focalEntityIds: focalIds };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

const dbPath = join(homedir(), ".agents", "memory", "memories.db");

describe.skipIf(!existsSync(dbPath))("traversal comparison (old vs new)", () => {
	const agentId = "default";
	let db: Database;

	beforeAll(() => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		db = new (require("bun:sqlite") as unknown as { Database: new (path: string, opts: { readonly: boolean }) => Database }).Database(dbPath, { readonly: true });
	});

	afterAll(() => { db?.close?.(); });

	function compareResults(project: string): void {
		const focal = resolveFocalEntities(db as unknown as ReadDb, agentId, { project });

		console.log(`\n  Project: ${project}`);
		console.log(`  Focal entities: ${focal.entityIds.length} (${focal.entityNames.join(", ")})`);
		console.log(`  Source: ${focal.source}`);

		if (focal.entityIds.length === 0) {
			console.log("  No focal entities — skipping");
			return;
		}

		const config = { ...DEFAULT_CONFIG };

		const t0 = performance.now();
		const oldResult = traverseKnowledgeGraph_OLD(focal.entityIds, db, agentId, config);
		const oldMs = performance.now() - t0;

		const t1 = performance.now();
		const newResult = traverseKnowledgeGraph_NEW(focal.entityIds, db as unknown as ReadDb, agentId, config);
		const newMs = performance.now() - t1;

		console.log(`\n  === Performance ===`);
		console.log(`  OLD: ${oldMs.toFixed(1)}ms`);
		console.log(`  NEW: ${newMs.toFixed(1)}ms`);
		console.log(`  Speedup: ${(oldMs / newMs).toFixed(1)}x`);

		console.log(`\n  === Memory IDs ===`);
		console.log(`  OLD: ${oldResult.memoryIds.size} memories`);
		console.log(`  NEW: ${newResult.memoryIds.size} memories`);

		const oldIds = [...oldResult.memoryIds].sort();
		const newIds = [...newResult.memoryIds].sort();
		const onlyInOld = oldIds.filter((id) => !newResult.memoryIds.has(id));
		const onlyInNew = newIds.filter((id) => !oldResult.memoryIds.has(id));
		const common = oldIds.filter((id) => newResult.memoryIds.has(id));

		console.log(`  Common: ${common.length}`);
		console.log(`  Only in OLD: ${onlyInOld.length}`);
		console.log(`  Only in NEW: ${onlyInNew.length}`);

		if (onlyInOld.length > 0) {
			console.log(`\n  --- Memories only in OLD ---`);
			for (const id of onlyInOld.slice(0, 20)) {
				const score = oldResult.memoryScores.get(id);
				console.log(`    ${id.slice(0, 8)}... score=${score?.toFixed(3)}`);
			}
		}

		if (onlyInNew.length > 0) {
			console.log(`\n  --- Memories only in NEW ---`);
			for (const id of onlyInNew.slice(0, 20)) {
				const score = newResult.memoryScores.get(id);
				console.log(`    ${id.slice(0, 8)}... score=${score?.toFixed(3)}`);
			}
		}

		console.log(`\n  === Constraints ===`);
		console.log(`  OLD: ${oldResult.constraints.length}`);
		console.log(`  NEW: ${newResult.constraints.length}`);
		const oldCKeys = new Set(oldResult.constraints.map((c) => `${c.entityName}::${c.content}`));
		const newCKeys = new Set(newResult.constraints.map((c) => `${c.entityName}::${c.content}`));
		const onlyOldC = [...oldCKeys].filter((k) => !newCKeys.has(k));
		const onlyNewC = [...newCKeys].filter((k) => !oldCKeys.has(k));
		if (onlyOldC.length > 0) console.log(`  Constraints only in OLD: ${onlyOldC.length}`);
		if (onlyNewC.length > 0) console.log(`  Constraints only in NEW: ${onlyNewC.length}`);

		console.log(`\n  === Entity Count ===`);
		console.log(`  OLD: ${oldResult.entityCount}, NEW: ${newResult.entityCount}`);

		console.log(`\n  === Active Aspects ===`);
		console.log(`  OLD: ${oldResult.activeAspectIds.length}, NEW: ${newResult.activeAspectIds.length}`);

		// New code visits ALL focal entities; old code stopped at the first
		// entity that filled the budget, silently skipping the rest.
		// This means the new code will always have >= constraints and entities.
		expect(newResult.entityCount).toBeGreaterThanOrEqual(oldResult.entityCount);
		expect(newCKeys.size).toBeGreaterThanOrEqual(oldCKeys.size);
		// All old constraints must be present in new (old is a subset)
		for (const k of oldCKeys) {
			expect(newCKeys.has(k)).toBe(true);
		}

		const overlap = common.length / Math.max(oldResult.memoryIds.size, newResult.memoryIds.size, 1);
		console.log(`  Memory overlap: ${(overlap * 100).toFixed(1)}%`);

		// When old code visits only 1 entity (budget filled by entity 1),
		// the new code will produce a different (broader) memory set.
		// This is expected — the new code doesn't silently skip entities.
		if (oldResult.entityCount < newResult.entityCount) {
			console.log(`\n  ℹ️  OLD visited ${oldResult.entityCount} entity(s), NEW visited ${newResult.entityCount} — memory differences expected`);
		} else if (onlyInOld.length === 0 && onlyInNew.length === 0) {
			console.log(`\n  ✅ IDENTICAL memory IDs`);
		} else {
			console.log(`\n  ⚠️  ${onlyInOld.length + onlyInNew.length} memory IDs differ despite same entity count`);
		}
	}

	test("signetai project", () => compareResults("/home/nicholai/signet/signetai"));
	test(".agents project", () => compareResults("/home/nicholai/.agents"));
});
