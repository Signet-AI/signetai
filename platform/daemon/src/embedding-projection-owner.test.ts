import { expect, test } from "bun:test";
import { findSqliteVecExtension, syncEmbeddingCompartment, vectorSearchWithMetadata } from "@signet/core";
import { currentClassificationFixture } from "./test-support/classification-fixture.test";
import { executeEmbeddingProjection } from "./embedding-projection-owner";
import { embeddingProfileFingerprint } from "./embedding-profile";
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

test.each(["promoted", "rebuild"] as const)(
	"projection repair resolves the canonical embedding store after %s",
	(mode: "promoted" | "rebuild") => {
		const db = currentClassificationFixture();
		try {
			const extension = findSqliteVecExtension();
			if (!extension) throw new Error("sqlite-vec required");
			db.loadExtension(extension);
			const projection = mode === "promoted" ? "vec_embeddings_staging" : "vec_embeddings";
			const store = mode === "promoted" ? "embeddings" : "embeddings_staging";
			const wrongStore = store === "embeddings" ? "embeddings_staging" : "embeddings";
			const cfg = {
				provider: "ollama",
				model: "fixture-model",
				dimensions: 3,
				base_url: "http://127.0.0.1:1",
			} as const;
			const profile = {
				fingerprint: embeddingProfileFingerprint(cfg),
				provider: cfg.provider,
				model: cfg.model,
				dimensions: 3,
				baseUrl: cfg.base_url,
				projectionSlot: mode === "promoted" ? "staging" : "active",
			};
			db.prepare(
				"INSERT INTO embedding_index_state(id,active_profile_json,state,staging_profile_json,created_at,updated_at) VALUES(1,?,?,?,'now','now')",
			).run(
				JSON.stringify(profile),
				mode === "rebuild" ? "building" : "ready",
				mode === "rebuild" ? JSON.stringify({ ...profile, projectionSlot: "staging", projectionRebuild: true }) : null,
			);
			db.exec(
				`CREATE VIRTUAL TABLE ${projection} USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[3] distance_metric=cosine)`,
			);
			db.prepare(
				`INSERT INTO ${store}(id,content_hash,source_type,source_id,vector,dimensions,created_at,agent_id,chunk_text) VALUES('legacy','hash','memory','m',?,3,'now','default','chunk')`,
			).run(new Float32Array([1, 0, 0]));
			db.prepare("UPDATE vector_shard_repairs SET phase='pending',active_generation=0 WHERE projection=?").run(
				projection,
			);
			let phase = "pending";
			for (let i = 0; i < 10 && phase !== "ready"; i++)
				phase =
					executeEmbeddingProjection(db, { projection, store: wrongStore, ids: [], repair: true }).phase ?? "missing";
			expect(phase).toBe("ready");
			expect(db.query("SELECT embedding_id FROM vector_shard_members WHERE projection=?").all(projection)).toEqual([
				{ embedding_id: "legacy" },
			]);
			expect(
				vectorSearchWithMetadata(db, new Float32Array([1, 0, 0]), {
					limit: 1,
					readScope: { reach: { kind: "own", agentId: "default" }, projects: null, compartments: "all" },
				}).results.map((r) => r.id),
			).toEqual(["m"]);
		} finally {
			db.close();
		}
	},
);

test("projection owner resumes metadata-only upgrade repair and keeps the legacy projection", () => {
	const db = currentClassificationFixture();
	try {
		const extension = findSqliteVecExtension();
		if (!extension) throw new Error("sqlite-vec required");
		db.loadExtension(extension);
		db.exec(
			"DROP TABLE IF EXISTS vec_embeddings;CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[3] distance_metric=cosine);UPDATE vector_shard_repairs SET phase='pending',active_generation=0 WHERE projection='vec_embeddings'",
		);
		db.prepare(
			"INSERT INTO embeddings(id,content_hash,source_type,source_id,vector,dimensions,created_at,agent_id,chunk_text) VALUES('legacy','hash','memory','m',?,3,'now','default','chunk')",
		).run(new Float32Array([1, 0, 0]));
		executeEmbeddingProjection(db, { store: "embeddings", projection: "vec_embeddings", ids: ["legacy"] });
		let phase = "pending";
		for (let i = 0; i < 10 && phase !== "ready"; i++) {
			const result = executeEmbeddingProjection(db, {
				store: "embeddings",
				projection: "vec_embeddings",
				ids: [],
				repair: true,
			});
			if (!("phase" in result) || typeof result.phase !== "string") throw new Error("repair phase missing");
			phase = result.phase;
		}
		expect(phase).toBe("ready");
		expect(db.query("SELECT embedding_id FROM vector_shard_members WHERE projection='vec_embeddings'").all()).toEqual([
			{ embedding_id: "legacy" },
		]);
		expect(db.query("SELECT id FROM vec_embeddings").all()).toEqual([{ id: "legacy" }]);
	} finally {
		db.close();
	}
});
