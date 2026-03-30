import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { DEFAULT_PIPELINE_V2, type EmbeddingConfig, type PipelineV2Config } from "../memory-config";
import type { LlmProvider } from "./provider";
import { installSkillNode, skillEmbeddingHash } from "./skill-graph";
import { reconcileOnce } from "./skill-reconciler";

function setup(): { root: string; db: string } {
	const root = join(tmpdir(), `signet-skill-reconciler-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return { root, db: join(root, "memories.db") };
}

function cfg(): PipelineV2Config {
	return {
		...DEFAULT_PIPELINE_V2,
		graph: { ...DEFAULT_PIPELINE_V2.graph, enabled: false },
		procedural: { ...DEFAULT_PIPELINE_V2.procedural, enrichOnInstall: true },
	};
}

function provider(raw: string): LlmProvider {
	return {
		name: "mock",
		async available() {
			return true;
		},
		async generate() {
			return raw;
		},
	};
}

const emb: EmbeddingConfig = {
	model: "test",
	dimensions: 3,
	provider: "ollama",
	base_url: "http://127.0.0.1:11434",
};

let root = "";
let db = "";

afterEach(() => {
	closeDbAccessor();
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
	db = "";
});

describe("reconcileOnce", () => {
	it("does not loop forever after install-time enrichment changes the embedding text", async () => {
		const paths = setup();
		root = paths.root;
		db = paths.db;
		initDbAccessor(db);

		const skill = "loop-skill";
		const dir = join(root, "skills", skill);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			`---
name: ${skill}
description: tiny
---
this skill helps with reconciliation loop debugging and metadata enrichment.`,
		);

		const raw = {
			name: skill,
			description: "tiny",
		} as const;

		const result = await installSkillNode(
			{
				frontmatter: raw,
				body: "this skill helps with reconciliation loop debugging and metadata enrichment.",
				source: "reconciler",
				fsPath: join(dir, "SKILL.md"),
			},
			getDbAccessor(),
			cfg(),
			emb,
			async () => [0.1, 0.2, 0.3],
			provider(
				'{"description":"debug a reconciliation loop in signet and inspect skill metadata drift","triggers":["debug skill reconcile loop","inspect skill metadata drift"],"tags":["debugging","skills"]}',
			),
		);

		const row = getDbAccessor().withReadDb(
			(dbh) =>
				dbh
					.prepare("SELECT content_hash, chunk_text FROM embeddings WHERE source_type = 'skill' AND source_id = ?")
					.get(result.entityId) as
					| {
							content_hash: string;
							chunk_text: string;
					  }
					| undefined,
		);

		expect(row?.content_hash).toBe(skillEmbeddingHash(result.entityId, raw));
		expect(row?.chunk_text).toContain("debug a reconciliation loop");

		const pass = await reconcileOnce({
			accessor: getDbAccessor(),
			pipelineConfig: cfg(),
			embeddingConfig: emb,
			fetchEmbedding: async () => {
				throw new Error("reconcileOnce should not reinstall unchanged enriched skills");
			},
			getProvider: () => null,
			agentsDir: root,
		});

		expect(pass).toEqual({ installed: 0, updated: 0, removed: 0 });
	});

	it("updates skill metadata when a non-embedding frontmatter field changes on disk", async () => {
		const paths = setup();
		root = paths.root;
		db = paths.db;
		initDbAccessor(db);

		const skill = "meta-skill";
		const dir = join(root, "skills", skill);
		const file = join(dir, "SKILL.md");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			file,
			`---
name: ${skill}
description: metadata drift test
version: 1.0.0
author: nicholai
---
this skill helps verify metadata reconciliation.`,
		);

		const raw = {
			name: skill,
			description: "metadata drift test",
			version: "1.0.0",
			author: "nicholai",
		} as const;

		const first = await installSkillNode(
			{
				frontmatter: raw,
				body: "this skill helps verify metadata reconciliation.",
				source: "reconciler",
				fsPath: file,
			},
			getDbAccessor(),
			cfg(),
			emb,
			async () => [0.1, 0.2, 0.3],
			null,
		);

		expect(
			getDbAccessor().withReadDb(
				(dbh) =>
					dbh
						.prepare("SELECT content_hash FROM embeddings WHERE source_type = 'skill' AND source_id = ?")
						.get(first.entityId) as { content_hash: string } | undefined,
			)?.content_hash,
		).toBe(skillEmbeddingHash(first.entityId, raw));

		writeFileSync(
			file,
			`---
name: ${skill}
description: metadata drift test
version: 1.0.1
author: nicholai
---
this skill helps verify metadata reconciliation.`,
		);

		let calls = 0;
		const pass = await reconcileOnce({
			accessor: getDbAccessor(),
			pipelineConfig: cfg(),
			embeddingConfig: emb,
			fetchEmbedding: async () => {
				calls++;
				return [0.4, 0.5, 0.6];
			},
			getProvider: () => null,
			agentsDir: root,
		});

		expect(pass).toEqual({ installed: 0, updated: 1, removed: 0 });
		expect(calls).toBe(1);
		expect(
			getDbAccessor().withReadDb(
				(dbh) =>
					dbh
						.prepare(
							"SELECT content_hash FROM embeddings WHERE source_type = 'skill' AND source_id = ?",
						)
						.get(first.entityId) as { content_hash: string } | undefined,
					)?.content_hash,
		).toBe(
			skillEmbeddingHash(first.entityId, {
				...raw,
				version: "1.0.1",
			}),
		);
	});
});
