import { getSyncDbAccessor } from "../../legacy-sync/db-accessor-sync";
import { expect, test } from "bun:test";
import { compartmentFor } from "@signet/core";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { createEmbeddingReranker } from "./reranker-embedding";

test("cached hidden embeddings cannot change a caller's reranking scores", async () => {
	const directory = mkdtempSync(join(tmpdir(), "signet-rerank-scope-"));
	const previous = process.env.SIGNET_PATH;
	process.env.SIGNET_PATH = directory;
	try {
		mkdirSync(join(directory, "memory"));
		initDbAccessor(join(directory, "memory", "memories.db"));
		const label = getSyncDbAccessor().withWriteTx((db) => {
			db.exec(
				"INSERT INTO classifications(id,name) VALUES ('cls_rerank','Rerank secret'); INSERT INTO memories(id,content,type,agent_id,created_at,updated_at,updated_by) VALUES ('rerank-visible','Atlas','fact','default','now','now','test')",
			);
			const c = compartmentFor(db, ["cls_rerank"]);
			db.prepare(
				"INSERT INTO memories(id,content,type,agent_id,compartment_id,created_at,updated_at,updated_by) VALUES ('rerank-hidden','Atlas secret','fact','default',?,'now','now','test')",
			).run(c);
			return c;
		});
		const scope = { reach: { kind: "own" as const, agentId: "default" }, compartments: [], projects: null };
		const candidates = [
			{ id: "rerank-visible", content: "Atlas", score: 0.8 },
			{ id: "rerank-hidden", content: "Atlas", score: 0.6 },
		];
		const config = { topN: 2, timeoutMs: 5000, model: "" };
		const rerank = createEmbeddingReranker(getDbAccessor(), new Float32Array([1, 0, 0]), scope);
		const before = await rerank("Atlas", candidates, config);
		getSyncDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					"INSERT INTO embeddings(id,content_hash,vector,dimensions,source_type,source_id,chunk_text,agent_id,compartment_id,created_at) VALUES ('rerank-vector','rerank-hash',?,3,'memory','rerank-hidden','Atlas secret','default',?,'now')",
				)
				.run(new Float32Array([1, 0, 0]), label),
		);
		expect(await rerank("Atlas", candidates, config)).toEqual(before);
		const audience = createEmbeddingReranker(getDbAccessor(), new Float32Array([1, 0, 0]), {
			...scope,
			compartments: label === null ? [] : [label],
		});
		expect(
			(await audience("Atlas", candidates, config)).find((row) => row.id === "rerank-hidden")?.score,
		).toBeGreaterThan(0.6);
	} finally {
		await closeDbAccessor();
		if (previous === undefined) delete process.env.SIGNET_PATH;
		else process.env.SIGNET_PATH = previous;
		rmSync(directory, { recursive: true, force: true });
	}
}, 30000);
