import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor } from "../db-accessor";
import { getDreamingQualityReport } from "./dreaming-quality";

function wrapDb(db: Database): DbAccessor {
	return {
		withReadDb<T>(fn: (db: Database) => T): T {
			return fn(db);
		},
		withReadDbAsync<T>(fn: (db: Database) => Promise<T>): Promise<T> {
			return fn(db);
		},
		withWriteTx<T>(fn: (db: Database) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const value = fn(db);
				db.exec("COMMIT");
				return value;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		withWriteTxAsync<T>(fn: (db: Database) => T): Promise<T> {
			db.exec("BEGIN IMMEDIATE");
			try {
				const value = fn(db);
				db.exec("COMMIT");
				return Promise.resolve(value);
			} catch (error) {
				db.exec("ROLLBACK");
				return Promise.reject(error);
			}
		},
	} as unknown as DbAccessor;
}

describe("Dreaming quality report", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = wrapDb(db);
	});

	afterEach(() => db.close());

	it("measures resolved episodic citations and rejects source topology from entity garbage counts", async () => {
		const now = new Date().toISOString();
		const quote = "Signet stores source evidence before deriving semantic state.";
		db.prepare(
			`INSERT INTO memories (id, content, type, agent_id, is_deleted, created_at, updated_at, updated_by)
			 VALUES ('memory-evidence', ?, 'fact', 'agent-a', 0, ?, ?, 'test')`,
		).run(quote, now, now);
		db.exec(`
			INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			VALUES
				('ent-signet', 'Signet', 'signet', 'project', 'agent-a', 1, '${now}', '${now}'),
				('ent-signet-possessive', 'Signet''s', 'signet''s', 'project', 'agent-a', 1, '${now}', '${now}'),
				('ent-source', 'Source note', 'source note', 'source_document', 'agent-a', 1, '${now}', '${now}'),
				('ent-unknown', 'Loose note', 'loose note', 'unknown', 'agent-a', 1, '${now}', '${now}');
			INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			VALUES
				('asp-signet', 'ent-signet', 'agent-a', 'architecture', 'architecture', 1, '${now}', '${now}'),
				('asp-unknown', 'ent-unknown', 'agent-a', 'Details', 'details', 1, '${now}', '${now}'),
				('asp-profile', 'ent-unknown', 'agent-a', 'Profile', 'profile', 1, '${now}', '${now}');
		`);
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, group_key, claim_key, proposal_evidence, created_at, updated_at)
			 VALUES
			 ('attr-cited', 'asp-signet', 'agent-a', 'memory-evidence', 'attribute', ?, ?, 1, 1, 'active', 'architecture', 'evidence_first', ?, ?, ?),
			 ('attr-uncited', 'asp-signet', 'agent-a', 'memory-evidence', 'attribute', 'An untraceable claim.', 'an untraceable claim', 1, 1, 'active', 'architecture', 'untraceable', '[]', ?, ?)`,
		).run(quote, quote.toLowerCase(), JSON.stringify([{ memory_id: "memory-evidence", quote }]), now, now, now, now);

		const report = await getDreamingQualityReport(accessor, "agent-a");
		expect(report.citationCoverage).toEqual({
			totalClaimValues: 2,
			valuesWithResolvedEpisodicQuote: 1,
			unaddressableClaimValues: 0,
			unresolvedClaimPaths: 0,
			rate: 0.5,
		});
		expect(report.graphGarbageRate).toMatchObject({
			totalEntities: 3,
			garbageEntities: 1,
			rate: 1 / 3,
			examples: [{ id: "ent-signet-possessive", name: "Signet's", reason: "possessive_duplicate" }],
		});
		expect(report.structureQuality).toEqual({
			totalEntities: 3,
			unknownEntityTypes: 1,
			unknownEntityTypeRate: 1 / 3,
			totalAspects: 3,
			profileAspects: 1,
			profileAspectRate: 1 / 3,
			genericAspects: 2,
			genericAspectRate: 2 / 3,
		});
	});
});
