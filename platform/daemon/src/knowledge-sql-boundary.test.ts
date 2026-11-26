import { afterEach, beforeEach, expect, test } from "bun:test";
import { COMPARTMENT_TABLES } from "@signet/core";
import ts from "typescript";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDbAccessor, getDbAccessor, closeDbAccessor } from "./db-accessor";
import { knowledgeReadDb, scopedKnowledgeStatement } from "./knowledge-graph-hygiene";
import type { ReadScope } from "./read-scope";
const scope: ReadScope = { reach: { kind: "all" }, compartments: [], projects: null };
let dir = "";
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "signet-knowledge-sql-"));
	initDbAccessor(join(dir, "test.db"));
	await getDbAccessor().withWriteTxAsync((db) =>
		db.exec(
			"INSERT INTO compartments(id,key) VALUES(9,'private'); INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('public','public','default','now','now'); INSERT INTO memories(id,content,agent_id,compartment_id,created_at,updated_at) VALUES('hidden','hidden','default',9,'now','now'); INSERT INTO derived_memory_sources(derived_memory_id,source_kind,source_id,agent_id,created_at) VALUES('public','memory','hidden','default','now'); INSERT INTO evidence_citations VALUES('memory','public','default','memory','hidden'); INSERT INTO dreaming_attention(id,agent_id,kind,subject_ref,compartment_id) VALUES('hidden-attention','default','hygiene','hidden',9); INSERT INTO dreaming_state(agent_id,tokens_since_last_pass) VALUES('default',99999) ON CONFLICT(agent_id) DO UPDATE SET tokens_since_last_pass=99999",
		),
	);
});
afterEach(async () => {
	await closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
});
test("knowledge prepare rejects uncovered comma joins, schema-qualified tables and subqueries", () => {
	for (const sql of [
		"SELECT e.id FROM entities e, embeddings x",
		"SELECT * FROM (memory_jobs)",
		"SELECT e.id FROM entities e JOIN (memory_jobs) j ON 1=1",
		"SELECT * FROM (entities), (memory_jobs)",
		"SELECT * FROM ((memory_jobs))",
		"SELECT * FROM (entities JOIN memory_jobs ON 1=1)",
		"SELECT * FROM entities_fts",
		"SELECT * FROM main.entities_fts",
		"SELECT * FROM entities_fts__c9",
		"SELECT id FROM main.entities",
		'SELECT id FROM "main" . "entities"',
		"SELECT id FROM entities WHERE EXISTS(SELECT 1 FROM session_checkpoints)",
	]) {
		expect(() => knowledgeReadDb(scope).prepare(sql)).toThrow(/scoped_sql_/);
	}
});
test("lineage, citations, attention and global Dreaming state cannot escape the scoped owner", async () => {
	const db = knowledgeReadDb(scope);
	for (const table of ["derived_memory_sources", "evidence_citations", "dreaming_attention", "dreaming_state"]) {
		expect(await db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
	}
	const audience = knowledgeReadDb({ ...scope, compartments: [9] });
	expect(await audience.prepare("SELECT source_id FROM derived_memory_sources").all()).toEqual([
		{ source_id: "hidden" },
	]);
	expect(await audience.prepare("SELECT id FROM dreaming_attention").all()).toEqual([{ id: "hidden-attention" }]);
});
test("every module SQL statement is either shadowed or rejected by the scope boundary", () => {
	const files = [
		"knowledge-graph.ts",
		"knowledge-expansion.ts",
		"graph-impact.ts",
		"ontology-assertions.ts",
		"ontology-claim-evidence.ts",
		"ontology-claim-trace.ts",
		"ontology-contradictions.ts",
		"ontology-evidence.ts",
		"ontology-link-evidence.ts",
		"ontology-proposals.ts",
		"pipeline/graph-traversal.ts",
	];
	const statements: string[] = [];
	for (const file of files) {
		const source = ts.createSourceFile(
			file,
			readFileSync(join(import.meta.dir, file), "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		const visit = (node: ts.Node) => {
			if (ts.isStringLiteralLike(node) && /\bSELECT\b[\s\S]*\bFROM\b/i.test(node.text)) statements.push(node.text);
			if (ts.isTemplateExpression(node)) {
				const text =
					node.head.text + node.templateSpans.map((span) => " __dynamic_sql__ " + span.literal.text).join("");
				if (/\bSELECT\b[\s\S]*\bFROM\b/i.test(text)) statements.push(text);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	expect(statements.length).toBeGreaterThan(50);
	const protectedTables = [
		...COMPARTMENT_TABLES,
		"derived_memory_sources",
		"evidence_citations",
		"dreaming_attention",
		"dreaming_state",
	];
	for (const sql of statements) {
		let compiled: ReturnType<typeof scopedKnowledgeStatement> | undefined;
		try {
			compiled = scopedKnowledgeStatement({ sql }, scope);
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).toContain("scoped_sql_");
			continue;
		}
		const code = sql.replace(/'(?:''|[^'])*'/g, "");
		for (const table of protectedTables) {
			if (new RegExp(`\\b${table}\\b`, "i").test(code))
				expect(compiled.sql).toMatch(new RegExp(`\\b${table}\\s+AS\\s+(?:NOT\\s+MATERIALIZED\\s*)?\\(`, "i"));
		}
	}
});
