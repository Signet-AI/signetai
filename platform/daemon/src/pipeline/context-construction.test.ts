import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DbOwnerClient, DbOwnerJobHandle, DbOwnerRequest, DbOwnerSubmitOptions } from "../db-owner-client";
import {
	CONTEXT_MAX_ASPECTS_PER_ENTITY,
	CONTEXT_MAX_ATTRIBUTES_PER_ASPECT,
	CONTEXT_MAX_DEPENDENCIES_PER_ENTITY,
	CONTEXT_SNAPSHOT_MAX_STATEMENTS,
	CONTEXT_SNAPSHOT_WORK_UNIT_CEILING,
} from "./context-snapshot";
import { constructContextBlocksFromSnapshot, prepareContextRows } from "./context-construction";
import { loadContextSnapshotViaOwner } from "./context-snapshot";

interface OwnerCall {
	readonly operation: string;
	readonly estimatedWorkUnits: number | undefined;
	readonly sql: string;
	readonly params: readonly unknown[];
}

function createOwner(db: Database, calls: OwnerCall[], shouldFail?: (sql: string) => boolean): DbOwnerClient {
	return {
		submit<Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> {
			if (request.kind !== "query") throw new Error(`unexpected owner request: ${request.kind}`);
			if (shouldFail?.(request.statement.sql)) throw new Error("injected context query failure");
			const params = request.statement.params ?? [];
			if (params.some((param) => typeof param === "object" && param !== null))
				throw new Error("unexpected byte parameter in context query");
			calls.push({
				operation: options.operation,
				estimatedWorkUnits: options.estimatedWorkUnits,
				sql: request.statement.sql,
				params,
			});
			const statement = db.prepare(request.statement.sql);
			const result =
				request.statement.result === "all"
					? statement.all(...params)
					: request.statement.result === "get"
						? statement.get(...params)
						: statement.run(...params);
			return { result: Promise.resolve(result as Result) } as DbOwnerJobHandle<Result>;
		},
	} as DbOwnerClient;
}

function seedSchema(db: Database): void {
	db.exec(`
		CREATE TABLE entities (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			entity_type TEXT NOT NULL,
			agent_id TEXT NOT NULL
		);
		CREATE TABLE entity_aspects (
			id TEXT PRIMARY KEY,
			entity_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			name TEXT NOT NULL,
			weight REAL NOT NULL
		);
		CREATE TABLE entity_attributes (
			id TEXT PRIMARY KEY,
			aspect_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			memory_id TEXT,
			kind TEXT NOT NULL,
			content TEXT NOT NULL,
			status TEXT NOT NULL,
			importance REAL NOT NULL
		);
		CREATE TABLE entity_dependencies (
			id TEXT PRIMARY KEY,
			source_entity_id TEXT NOT NULL,
			target_entity_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			strength REAL NOT NULL
		);
		CREATE TABLE memory_content_safety (
			agent_id TEXT NOT NULL,
			source_kind TEXT NOT NULL,
			source_id TEXT NOT NULL,
			status TEXT NOT NULL,
			context_eligible INTEGER NOT NULL,
			PRIMARY KEY (agent_id, source_kind, source_id)
		);
		CREATE INDEX idx_entity_aspects_entity ON entity_aspects(entity_id);
		CREATE INDEX idx_entity_attributes_aspect ON entity_attributes(aspect_id);
		CREATE INDEX idx_entity_dependencies_source ON entity_dependencies(source_entity_id);
	`);
}

function seedWorstCaseGraph(db: Database, entityCount: number): string[] {
	const entity = db.prepare(
		"INSERT INTO entities (id, name, entity_type, agent_id) VALUES (?, ?, 'project', 'default')",
	);
	const aspect = db.prepare(
		"INSERT INTO entity_aspects (id, entity_id, agent_id, name, weight) VALUES (?, ?, 'default', ?, ?)",
	);
	const attribute = db.prepare(
		"INSERT INTO entity_attributes (id, aspect_id, agent_id, memory_id, kind, content, status, importance) VALUES (?, ?, 'default', NULL, 'attribute', ?, 'active', ?)",
	);
	const dependency = db.prepare(
		"INSERT INTO entity_dependencies (id, source_entity_id, target_entity_id, agent_id, strength) VALUES (?, ?, ?, 'default', ?)",
	);
	const focalIds: string[] = [];
	for (let entityIndex = 0; entityIndex < entityCount; entityIndex++) {
		const entityId = `entity-${entityIndex}`;
		focalIds.push(entityId);
		entity.run(entityId, `Entity ${entityIndex}`);
		for (let aspectIndex = 0; aspectIndex < CONTEXT_MAX_ASPECTS_PER_ENTITY; aspectIndex++) {
			const aspectId = `${entityId}-aspect-${aspectIndex}`;
			aspect.run(aspectId, entityId, `Aspect ${aspectIndex}`, 1 - aspectIndex / 100);
			for (let attributeIndex = 0; attributeIndex < CONTEXT_MAX_ATTRIBUTES_PER_ASPECT; attributeIndex++) {
				attribute.run(
					`${aspectId}-attribute-${attributeIndex}`,
					aspectId,
					`${entityId} value ${aspectIndex}-${attributeIndex}`,
					1 - attributeIndex / 100,
				);
			}
		}
		for (let dependencyIndex = 0; dependencyIndex < CONTEXT_MAX_DEPENDENCIES_PER_ENTITY; dependencyIndex++) {
			const targetIndex = (entityIndex + dependencyIndex + 1) % entityCount;
			dependency.run(
				`${entityId}-dependency-${dependencyIndex}`,
				entityId,
				`entity-${targetIndex}`,
				1 - dependencyIndex / 100,
			);
		}
	}
	return focalIds;
}

function seedSafetyRows(db: Database): void {
	const aspectId = "entity-0-aspect-0";
	db.prepare(
		`INSERT INTO entity_attributes
			(id, aspect_id, agent_id, memory_id, kind, content, status, importance)
			VALUES (?, ?, 'default', ?, 'attribute', ?, 'active', ?)`,
	).run("safety-clean", aspectId, "memory-clean", "clean persisted context", 2);
	db.prepare(
		`INSERT INTO entity_attributes
			(id, aspect_id, agent_id, memory_id, kind, content, status, importance)
			VALUES (?, ?, 'default', ?, 'attribute', ?, 'active', ?)`,
	).run("safety-tainted", aspectId, "memory-tainted", "tainted persisted context", 1.9);
	db.prepare(
		`INSERT INTO entity_attributes
			(id, aspect_id, agent_id, memory_id, kind, content, status, importance)
			VALUES (?, ?, 'default', ?, 'attribute', ?, 'active', ?)`,
	).run("safety-missing", aspectId, "memory-missing", "missing ledger context", 1.8);
	db.prepare(
		`INSERT INTO entity_attributes
			(id, aspect_id, agent_id, memory_id, kind, content, status, importance)
			VALUES (?, ?, 'default', NULL, 'constraint', ?, 'active', ?)`,
	).run("safety-constraint", aspectId, "preserve the bounded context contract", 1.7);
	db.prepare(
		`INSERT INTO memory_content_safety
			(agent_id, source_kind, source_id, status, context_eligible)
			VALUES ('default', 'memory', ?, ?, ?)`,
	).run("memory-clean", "clean", 1);
	db.prepare(
		`INSERT INTO memory_content_safety
			(agent_id, source_kind, source_id, status, context_eligible)
			VALUES ('default', 'memory', ?, ?, ?)`,
	).run("memory-tainted", "tainted", 0);
}

describe("bounded context snapshots", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		seedSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("bounds statements and parent-side work before assembling constructed cards", async () => {
		const focalIds = seedWorstCaseGraph(db, 200);
		seedSafetyRows(db);
		const calls: OwnerCall[] = [];
		const owner = createOwner(db, calls);
		let eventLoopBreaths = 0;
		let done = false;
		const breathe = (): void => {
			if (done) return;
			eventLoopBreaths++;
			setImmediate(breathe);
		};
		setImmediate(breathe);

		const snapshot = await loadContextSnapshotViaOwner(owner, "default", focalIds, 3);
		const prepared = await prepareContextRows(snapshot);
		const blocks = await constructContextBlocksFromSnapshot(snapshot, 3, prepared);
		done = true;

		expect(blocks).toHaveLength(3);
		expect(snapshot.work).toMatchObject({
			focalEntityCount: 200,
			selectedEntityCount: 3,
			entityCount: 3,
			entityLimit: 3,
			omittedEntityCount: 197,
			statementCount: CONTEXT_SNAPSHOT_MAX_STATEMENTS,
			partial: true,
			safetyLedger: "available",
		});
		expect(snapshot.work.estimatedWorkUnits).toBeLessThanOrEqual(CONTEXT_SNAPSHOT_WORK_UNIT_CEILING);
		expect(calls).toHaveLength(CONTEXT_SNAPSHOT_MAX_STATEMENTS);
		expect(calls.every((call) => call.operation === "memory-search.context.snapshot")).toBe(true);
		expect(calls.reduce((total, call) => total + (call.estimatedWorkUnits ?? 0), 0)).toBeLessThanOrEqual(
			CONTEXT_SNAPSHOT_WORK_UNIT_CEILING,
		);
		expect(eventLoopBreaths).toBeGreaterThan(0);
	});

	it("keeps persisted safety fail-closed while allowing a missing ledger row", async () => {
		const focalIds = seedWorstCaseGraph(db, 1);
		seedSafetyRows(db);
		const owner = createOwner(db, []);
		const snapshot = await loadContextSnapshotViaOwner(owner, "default", focalIds, 1);
		const prepared = await prepareContextRows(snapshot);
		const blocks = await constructContextBlocksFromSnapshot(snapshot, 1, prepared);
		const content = blocks[0]?.content ?? "";
		const safeAttributes = prepared.attributesByAspect.get("entity-0-aspect-0") ?? [];
		const safeConstraints = prepared.constraintsByEntity.get("entity-0") ?? [];

		expect(snapshot.safetyLedger).toBe("available");
		expect(safeAttributes.map((attribute) => attribute.content)).toContain("clean persisted context");
		expect(safeAttributes.map((attribute) => attribute.content)).toContain("missing ledger context");
		expect(safeAttributes.map((attribute) => attribute.content)).not.toContain("tainted persisted context");
		expect(safeConstraints.map((constraint) => constraint.content)).toContain("preserve the bounded context contract");
		// The card remains bounded even when the fixture has the full per-entity shape.
		expect(content.length).toBeLessThanOrEqual(900);
	});

	it("fails closed when the batched safety decision read is unavailable", async () => {
		const focalIds = seedWorstCaseGraph(db, 1);
		seedSafetyRows(db);
		const owner = createOwner(db, [], (sql) => sql.includes("SELECT source_id, status"));
		const snapshot = await loadContextSnapshotViaOwner(owner, "default", focalIds, 1);
		const prepared = await prepareContextRows(snapshot);
		const safeAttributes = prepared.attributesByAspect.get("entity-0-aspect-0") ?? [];

		expect(snapshot.work).toMatchObject({ partial: true, safetyLedger: "unavailable" });
		expect(safeAttributes.map((attribute) => attribute.content)).not.toContain("clean persisted context");
		expect(safeAttributes.map((attribute) => attribute.content)).not.toContain("missing ledger context");
		expect(safeAttributes.map((attribute) => attribute.content)).toContain("entity-0 value 0-0");
	});
});
