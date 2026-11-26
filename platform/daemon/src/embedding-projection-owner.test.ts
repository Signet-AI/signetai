import { expect, test } from "bun:test";
import { findSqliteVecExtension, syncEmbeddingCompartment } from "@signet/core";
import { currentClassificationFixture } from "./test-support/classification-fixture.test";
import { executeEmbeddingProjection } from "./embedding-projection-owner";
import { executeClassification } from "./classification-owner";
import type { ClassificationActor } from "./classifications";

test("new vectors inherit their memory label and profile rebuilds preserve shard isolation", () => {
	const db = currentClassificationFixture();
	const extension = findSqliteVecExtension();
	if (!extension) throw new Error("sqlite-vec required");
	db.loadExtension(extension);
	db.exec(
		"DROP TABLE IF EXISTS vec_embeddings;CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[3] distance_metric=cosine)",
	);
	const actor: ClassificationActor = {
		userId: "carol",
		compliance: true,
		local: false,
		groupIds: [],
		boundAgentId: null,
		allowedProjects: null,
		credential: "session:test",
	};
	const field = (value: unknown, name: string) => {
		if (typeof value === "object" && value !== null) {
			const result: unknown = Reflect.get(value, name);
			if (typeof result === "string") return result;
		}
		throw new Error("invalid result");
	};
	const id = field(
		executeClassification(db, {
			op: "create",
			actor,
			name: "HR",
			color: null,
			description: null,
			audience: [{ kind: "user", id: "alice" }],
			appliers: [],
		}),
		"id",
	);
	const jobId = field(
		executeClassification(db, {
			op: "enqueue",
			actor,
			id,
			target: { kind: "memory", id: "m", agentId: "default" },
			remove: false,
		}),
		"jobId",
	);
	executeClassification(db, { op: "execute", jobId });
	db.prepare(
		"INSERT INTO embeddings(id,content_hash,source_type,source_id,vector,dimensions,created_at,agent_id,chunk_text,compartment_id) VALUES('emb','hash','memory','m',?,3,'now','default','chunk',(SELECT compartment_id FROM memories WHERE id='m'))",
	).run(new Float32Array([1, 0, 0]));
	syncEmbeddingCompartment(db, "embeddings", "emb");
	const c = db.prepare("SELECT compartment_id FROM embeddings WHERE id='emb'").get()?.compartment_id;
	expect(c).toBeNumber();
	expect(db.prepare("SELECT count(*) n FROM vec_embeddings").get()).toEqual({ n: 0 });
	expect(
		db.prepare(`SELECT id FROM vec_embeddings__c${c} WHERE embedding MATCH ? AND k=1`).all(new Float32Array([1, 0, 0])),
	).toEqual([{ id: "emb" }]);
	db.prepare("UPDATE embeddings SET dimensions=4,vector=? WHERE id='emb'").run(new Float32Array([1, 0, 0, 0]));
	executeEmbeddingProjection(db, { store: "embeddings", projection: "vec_embeddings", ids: [], resetDimensions: 4 });
	executeEmbeddingProjection(db, { store: "embeddings", projection: "vec_embeddings", ids: ["emb"] });
	expect(db.prepare("SELECT count(*) n FROM vec_embeddings").get()).toEqual({ n: 0 });
	expect(
		db
			.prepare(`SELECT id FROM vec_embeddings__c${c} WHERE embedding MATCH ? AND k=1`)
			.all(new Float32Array([1, 0, 0, 0])),
	).toEqual([{ id: "emb" }]);
	db.close();
});
