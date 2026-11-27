import { expect, test } from "bun:test";
import { compartmentFor } from "../../core/src/compartment-shards";
import { currentClassificationFixture } from "./test-support/classification-fixture.test";
import { linkDerivedMemorySourcesInTx } from "./derived-memory-provenance";
import { txAnswerReflection, txCreateDailyReflections } from "./reflection-owner";
import { txInsertMemoryTemporalEdges } from "./temporal-edges";

function fixture() {
	const db = currentClassificationFixture();
	db.exec("INSERT INTO classifications(id,name) VALUES('cls_a','A'),('cls_b','B')");
	const a = compartmentFor(db, ["cls_a"]);
	const b = compartmentFor(db, ["cls_b"]);
	db.prepare("UPDATE memories SET compartment_id=? WHERE id='m'").run(a);
	db.prepare(
		"INSERT INTO memories(id,content,agent_id,compartment_id,created_at,updated_at) VALUES('derived','derivedsecret','default',?,'now','now')",
	).run(b);
	return { db, a, b };
}

test("linking derived evidence persists citations and unions the parent label atomically", () => {
	const { db, b } = fixture();
	db.prepare(
		"INSERT INTO memory_hints(id,memory_id,agent_id,hint,compartment_id) VALUES('hint','derived','default','derivedsecret',?)",
	).run(b);
	db.prepare(
		"INSERT INTO embeddings(id,content_hash,vector,dimensions,source_type,source_id,chunk_text,agent_id,compartment_id,created_at) VALUES('emb','hash',?,3,'memory','derived','derivedsecret','default',?,'now')",
	).run(new Uint8Array(new Float32Array([1, 0, 0]).buffer), b);
	db.transaction(() =>
		linkDerivedMemorySourcesInTx(db, {
			agentId: "default",
			derivedMemoryId: "derived",
			sources: [{ sourceKind: "memory", sourceId: "m" }],
			createdAt: "now",
		}),
	)();
	expect(
		db
			.prepare(
				"SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='memory' AND derived_id='derived'",
			)
			.all(),
	).toEqual([{ evidence_kind: "memory", evidence_id: "m" }]);
	expect(
		db.prepare("SELECT key FROM compartments WHERE id=(SELECT compartment_id FROM memories WHERE id='derived')").get(),
	).toEqual({ key: "cls_a,cls_b" });
	expect(db.prepare("SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH 'derivedsecret'").get()).toEqual({
		n: 0,
	});
	expect(
		db.prepare("SELECT compartment_id FROM derived_memory_sources WHERE derived_memory_id='derived'").get(),
	).toEqual(db.prepare("SELECT compartment_id FROM memories WHERE id='derived'").get());
	expect(db.prepare("SELECT compartment_id FROM memory_hints WHERE id='hint'").get()).toEqual(
		db.prepare("SELECT compartment_id FROM memories WHERE id='derived'").get(),
	);
	expect(db.prepare("SELECT compartment_id FROM embeddings WHERE id='emb'").get()).toEqual(
		db.prepare("SELECT compartment_id FROM memories WHERE id='derived'").get(),
	);
	expect(() =>
		db.transaction(() =>
			linkDerivedMemorySourcesInTx(db, {
				agentId: "default",
				derivedMemoryId: "derived",
				sources: [{ sourceKind: "memory", sourceId: "absent" }],
				createdAt: "now",
			}),
		)(),
	).toThrow();
	expect(db.prepare("SELECT count(*) n FROM derived_memory_sources WHERE source_id='absent'").get()).toEqual({ n: 0 });
	db.close();
});

test("temporal edges inherit their classified memory before insertion", () => {
	const { db, a } = fixture();
	db.transaction(() =>
		txInsertMemoryTemporalEdges({
			db,
			agentId: "default",
			memoryId: "m",
			now: "now",
			inputs: [{ facet: "observed", startAt: "2026-11-25", endAt: null, provenance: "test" }],
		}),
	)();
	expect(db.prepare("SELECT compartment_id FROM temporal_edges WHERE subject_id='m'").get()).toEqual({
		compartment_id: a,
	});
	db.close();
});

test("reflection answers inherit the brief evidence label", () => {
	const { db, a } = fixture();
	db.prepare(
		"INSERT INTO daily_reflections(id,agent_id,date,summary,patterns,memory_ids,summary_ids,model,created_at,compartment_id) VALUES('r','default','2026-11-25','secret','[]','[\"m\"]','[]','test','now',?)",
	).run(a);
	db.exec("INSERT INTO evidence_citations VALUES('reflection','r','default','memory','m')");
	db.transaction(() =>
		txAnswerReflection(db, {
			id: "r",
			sourceAgentId: "default",
			agentId: "default",
			memoryId: "answer",
			answer: "response",
			now: "now",
			author: { userId: "alice", credential: "session:alice" },
		}),
	)();
	expect(db.prepare("SELECT compartment_id,author_user_id FROM memories WHERE id='answer'").get()).toEqual({
		compartment_id: a,
		author_user_id: "alice",
	});
	expect(
		db
			.prepare(
				"SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='memory' AND derived_id='answer'",
			)
			.all(),
	).toEqual([{ evidence_kind: "memory", evidence_id: "m" }]);
	db.close();
});

test("contradictions outside passes copy both attribute labels and citations", async () => {
	const { recordOntologyContradictionsForAttributeInTx } = await import("./ontology-contradictions");
	const { db, a, b } = fixture();
	db.exec(
		"INSERT INTO entity_aspects(id,entity_id,agent_id,name,canonical_name) VALUES('aspect','e','default','mode','mode')",
	);
	for (const [id, content, compartment] of [
		["left", "Runtime mode is enabled by default.", a],
		["right", "Runtime mode is disabled by default.", b],
	] as const) {
		db.prepare(
			"INSERT INTO entity_attributes(id,aspect_id,agent_id,kind,content,normalized_content,claim_key,compartment_id) VALUES(?,'aspect','default','attribute',?,?,'mode',?)",
		).run(id, content, content, compartment);
	}
	const ids = db.transaction(() =>
		recordOntologyContradictionsForAttributeInTx(db, { agentId: "default", attributeId: "right" }),
	)();
	expect(() =>
		db.transaction(() =>
			recordOntologyContradictionsForAttributeInTx(db, {
				agentId: "default",
				attributeId: "right",
				partition: { agentId: "default", compartmentId: null },
			}),
		)(),
	).toThrow("compartment_mismatch");
	expect(ids).toHaveLength(1);
	expect(
		db
			.prepare("SELECT key FROM compartments WHERE id=(SELECT compartment_id FROM ontology_contradictions WHERE id=?)")
			.get(ids[0]),
	).toEqual({ key: "cls_a,cls_b" });
	expect(
		db
			.prepare(
				"SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='contradiction' AND derived_id=? ORDER BY evidence_id",
			)
			.all(ids[0]),
	).toEqual([
		{ evidence_kind: "attribute", evidence_id: "left" },
		{ evidence_kind: "attribute", evidence_id: "right" },
	]);
	db.close();
});

test("reflection creation unions every evidence label and rolls back foreign evidence", () => {
	const { db, b } = fixture();
	db.prepare(
		"INSERT INTO daily_reflections(id,agent_id,date,summary,patterns,memory_ids,summary_ids,created_at,compartment_id) VALUES('prior','default','2026-11-24','Previous private brief','[]','[\"derived\"]','[]','now',?)",
	).run(b);
	db.exec("INSERT INTO evidence_citations VALUES('reflection','prior','default','memory','derived')");
	const input = {
		agentId: "default",
		date: "2026-11-25",
		model: "test",
		now: "now",
		memoryIds: ["m"],
		priorReflectionIds: ["prior"],
		summaryIds: [],
		insights: [{ id: "brief", summary: "A private brief", patterns: [], contentKey: "private brief" }],
	};
	expect(db.transaction(() => txCreateDailyReflections(db, input))()).toEqual(["brief"]);
	expect(
		db
			.prepare("SELECT key FROM compartments WHERE id=(SELECT compartment_id FROM daily_reflections WHERE id='brief')")
			.get(),
	).toEqual({ key: "cls_a,cls_b" });
	expect(
		db
			.prepare(
				"SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='reflection' AND derived_id='brief' ORDER BY evidence_id",
			)
			.all(),
	).toEqual([
		{ evidence_kind: "memory", evidence_id: "derived" },
		{ evidence_kind: "memory", evidence_id: "m" },
	]);
	db.exec(
		"INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('foreign','foreign secret','other','now','now')",
	);
	expect(() =>
		db.transaction(() =>
			txCreateDailyReflections(db, {
				...input,
				memoryIds: ["m", "foreign"],
				insights: [{ ...input.insights[0], id: "denied" }],
			}),
		)(),
	).toThrow("evidence_missing");
	expect(db.prepare("SELECT count(*) n FROM daily_reflections WHERE id='denied'").get()).toEqual({ n: 0 });
	db.close();
});

test("community repair copies inherit cited evidence and retain citation edges", async () => {
	const { classificationFixture } = await import("./test-support/classification-fixture.test");
	const { up } = await import("../../core/src/migrations/178-write-inheritance");
	const { persistCommunities } = await import("./pipeline/community-detection");
	const { UndirectedGraph } = await import("graphology");
	const { compartmentFor } = await import("../../core/src/compartment-shards");
	const db = classificationFixture();
	up(db);
	db.exec("INSERT INTO classifications(id,name) VALUES('cls_cluster','Cluster')");
	const compartment = compartmentFor(db, ["cls_cluster"]);
	db.prepare("UPDATE memories SET compartment_id=? WHERE id='m'").run(compartment);
	const graph = new UndirectedGraph();
	graph.addNode("e", { name: "Private entity", mentions: 1 });
	const groups = db.transaction(() => persistCommunities(db, "default", new Map([["e", 0]]), graph))();
	expect(db.prepare("SELECT compartment_id FROM entity_communities WHERE id=?").get(groups[0]?.id)).toEqual({
		compartment_id: compartment,
	});
	expect(
		db
			.prepare(
				"SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='community' AND derived_id=?",
			)
			.all(groups[0]?.id),
	).toEqual([{ evidence_kind: "memory", evidence_id: "m" }]);
	db.close();
});
