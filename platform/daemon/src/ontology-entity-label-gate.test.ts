import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../core/src/migrations";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { applyOntologyOperationBatch } from "./ontology-proposals";

/** Single-connection DbAccessor over an in-memory DB (correct for single-threaded tests). */
function makeAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (d: WriteDb) => T): T {
			return fn(db as unknown as WriteDb);
		},
		withReadDb<T>(fn: (d: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		close(): void {
			/* noop */
		},
	};
}

function entityCanonicalExists(db: Database, canonicalName: string): boolean {
	const row = db
		.prepare("SELECT 1 FROM entities WHERE canonical_name = ? LIMIT 1")
		.get(canonicalName) as { "1": number } | null;
	return row !== null;
}

describe("ontology entity-label gate (#914/#904)", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("rejects a markdown-polluted create_entity name per-op while a clean name succeeds", () => {
		const result = applyOntologyOperationBatch(accessor, {
			agentId: "default",
			actor: "operator",
			dryRun: true,
			operations: [
				{ operation: "create_entity", payload: { name: "**Status:**", entity_type: "project" } },
				{ operation: "create_entity", payload: { name: "GLM 5.1", entity_type: "model" } },
			],
		});

		// Bad-label op is recorded as a per-op failure (status 400), not silently
		// skipped; the clean-named op still applies.
		expect(result.items).toHaveLength(1);
		expect(result.items[0].proposal.operation).toBe("create_entity");
		expect(result.items[0].proposal.payload).toMatchObject({ name: "GLM 5.1" });
		expect(result.errors).toEqual([
			{
				index: 0,
				line: 1,
				operation: "create_entity",
				error: expect.stringContaining("rejected entity label"),
				status: 400,
			},
		]);

		// No entity row persists for the rejected label — the gate threw before the
		// INSERT, so neither the markdown-stripped canonical ("status") nor the raw
		// canonical ("**status:**") sneaks into the graph.
		expect(entityCanonicalExists(db, "status")).toBe(false);
		expect(entityCanonicalExists(db, "**status:**")).toBe(false);
	});

	it("throws on a rejected label in a non-dry-run batch and inserts no entity", () => {
		expect(() =>
			applyOntologyOperationBatch(accessor, {
				agentId: "default",
				actor: "operator",
				operations: [
					{ operation: "create_entity", payload: { name: "## Summary", entity_type: "project" } },
				],
			}),
		).toThrow("rejected entity label");

		// Gate threw before the entity INSERT; the stripped canonical must not exist.
		expect(entityCanonicalExists(db, "summary")).toBe(false);
	});
});
