import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DreamingConfig } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { runDreamingAgentPass } from "./pipeline/dreaming";
import { indexSourceArtifactStructure, purgeSourceArtifactStructure } from "./source-artifact-graph";
import { purgeSourceOwnedRows } from "./source-purge";
import { txIngestEnvelope } from "./transactions";

const DREAMING_CONFIG: DreamingConfig = {
	tokenThreshold: 1,
	maxInterval: 6 * 60 * 60 * 1_000,
	maxInputTokens: 32_000,
	maxOutputTokens: 1_000,
	timeout: 30_000,
	backfillOnFirstRun: true,
};

describe("source artifact graph structure", () => {
	let dir = "";
	let previousSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-source-artifact-graph-"));
		previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	it("projects provider artifacts into source-owned graph rows without creating memories", () => {
		const result = indexSourceArtifactStructure({
			agentId: "default",
			sourceId: "discord:test",
			sourceKind: "source_discord_message",
			sourceRoot: "discord://source/discord:test",
			sourceParentPath: "discord://guild/123/channel/456",
			sourcePath: "discord://guild/123/channel/456/message/789",
			displayName: "Message 789",
			content:
				"# Message 789\n\nAuthor: alice\n\nSignet Discord source parity should preserve provider provenance for graph claims.\n\n## Attachments\n\nThe attachment metadata remains source-backed and purgeable by source id.\n",
		});

		expect(result.documentEntityId).toBeTruthy();
		expect(result.entitiesTouched).toBeGreaterThanOrEqual(3);
		expect(result.dependenciesTouched).toBe(1);
		expect(result.aspectsTouched).toBe(2);
		expect(result.attributesTouched).toBeGreaterThanOrEqual(2);

		const rows = getDbAccessor().withReadDb((db) => ({
			memories: (db.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number }).count,
			doc: db
				.prepare(
					`SELECT entity_type, source_id, source_kind, source_path
					 FROM entities
					 WHERE agent_id = ? AND source_path = ?`,
				)
				.get("default", "discord://guild/123/channel/456/message/789") as Record<string, unknown>,
			attrs: db
				.prepare(
					`SELECT content, memory_id, source_id, source_kind, source_path
					 FROM entity_attributes
					 WHERE agent_id = ? AND source_path = ?
					 ORDER BY claim_key`,
				)
				.all("default", "discord://guild/123/channel/456/message/789") as Array<Record<string, unknown>>,
			deps: db
				.prepare(
					`SELECT dependency_type, source_id, source_path
					 FROM entity_dependencies
					 WHERE agent_id = ? AND source_path = ?`,
				)
				.all("default", "discord://guild/123/channel/456/message/789") as Array<Record<string, unknown>>,
		}));

		expect(rows.memories).toBe(0);
		expect(rows.doc.entity_type).toBe("source_document");
		expect(rows.doc.source_id).toBe("discord:test");
		expect(rows.doc.source_kind).toBe("source_discord_message");
		expect(rows.attrs.length).toBeGreaterThanOrEqual(2);
		expect(rows.attrs.every((row) => row.memory_id === null)).toBe(true);
		expect(rows.attrs.every((row) => row.source_id === "discord:test")).toBe(true);
		expect(rows.attrs.some((row) => String(row.content).includes("provider provenance"))).toBe(true);
		expect(rows.deps).toEqual([
			{
				dependency_type: "contains",
				source_id: "discord:test",
				source_path: "discord://guild/123/channel/456/message/789",
			},
		]);
	});

	it("refreshes and purges graph rows by source artifact path", () => {
		const base = {
			agentId: "default",
			sourceId: "github:test",
			sourceKind: "source_github_issue",
			sourceRoot: "github://repos/Signet-AI/signetai",
			sourceParentPath: "github://Signet-AI/signetai",
			sourcePath: "github://Signet-AI/signetai/issues/12",
			displayName: "Index GitHub",
		};
		indexSourceArtifactStructure({
			...base,
			content: "# Index GitHub\n\nThis original source-backed issue claim should disappear after refresh.\n",
		});
		indexSourceArtifactStructure({
			...base,
			content: "# Index GitHub\n\nThis replacement source-backed issue claim should stay active after refresh.\n",
		});

		const attrs = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT content FROM entity_attributes WHERE agent_id = ? AND source_path = ?")
					.all("default", base.sourcePath) as Array<{ content: string }>,
		);
		expect(attrs.some((row) => row.content.includes("replacement"))).toBe(true);
		expect(attrs.some((row) => row.content.includes("original"))).toBe(false);

		const purged = purgeSourceArtifactStructure({
			agentId: "default",
			sourceId: base.sourceId,
			sourcePath: base.sourcePath,
		});
		expect(purged.entities).toBeGreaterThan(0);

		const counts = getDbAccessor().withReadDb((db) => ({
			entities: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND source_path = ?")
					.get("default", base.sourcePath) as { count: number }
			).count,
			attrs: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE agent_id = ? AND source_path = ?")
					.get("default", base.sourcePath) as { count: number }
			).count,
			deps: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entity_dependencies WHERE agent_id = ? AND source_path = ?")
					.get("default", base.sourcePath) as { count: number }
			).count,
		}));
		expect(counts).toEqual({ entities: 0, attrs: 0, deps: 0 });
	});

	it("purges source-owned aspects during whole-source removal", () => {
		indexSourceArtifactStructure({
			agentId: "default",
			sourceId: "github:test",
			sourceKind: "source_github_doc",
			sourceRoot: "github://repos/Signet-AI/signetai",
			sourcePath: "github://Signet-AI/signetai/docs/README.md",
			displayName: "README",
			content: "# README\n\nThis source document has a claim that creates an aspect row.\n",
		});

		const purged = purgeSourceOwnedRows({ agentId: "default", sourceId: "github:test" });
		expect(purged).toBeGreaterThan(0);
		const counts = getDbAccessor().withReadDb((db) => ({
			entities: (
				db.prepare("SELECT COUNT(*) AS count FROM entities WHERE source_id = ?").get("github:test") as {
					count: number;
				}
			).count,
			aspects: (db.prepare("SELECT COUNT(*) AS count FROM entity_aspects").get() as { count: number }).count,
			attrs: (
				db.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE source_id = ?").get("github:test") as {
					count: number;
				}
			).count,
		}));
		expect(counts).toEqual({ entities: 0, aspects: 0, attrs: 0 });
	});

	it("purges dreaming-derived claim values stamped with the source entry id", () => {
		// A Dreaming-derived entity_attribute carries the configured Signet source
		// entry id in source_id (the purge key), not the episodic node identity.
		const db = getDbAccessor();
		db.withWriteTx((write) => {
			write
				.prepare(
					`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
					 VALUES ('derived-entity', 'Derived', 'derived', 'project', 'default', 0, datetime('now'), datetime('now'))`,
				)
				.run();
			txIngestEnvelope(write, {
				id: "derived-claim",
				content: "dreaming-derived claim",
				normalizedContent: "dreaming-derived claim",
				contentHash: "semantic-attribute:derived-claim",
				who: "dreaming",
				why: "Derived semantic attribute",
				project: null,
				importance: 0.5,
				type: "semantic",
				tags: "semantic,attribute",
				pinned: 0,
				extractionStatus: "completed",
				updatedBy: "dreaming",
				memoryKind: null,
				sourceType: "dreaming",
				sourceId: "obsidian:signet",
				sourcePath: "vault/derived.md",
				agentId: "default",
				visibility: "global",
				createdAt: new Date().toISOString(),
			});
			write
				.prepare(
					`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
					 VALUES ('derived-aspect', 'derived-entity', 'default', 'facts', 'facts', 0.5, datetime('now'), datetime('now'))`,
				)
				.run();
			write
				.prepare(
					`INSERT INTO entity_attributes
					 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status,
					  group_key, claim_key, version, created_at, updated_at, source_id, source_root)
					 VALUES ('derived-claim', 'derived-aspect', 'default', 'attribute', 'dreaming-derived claim', 'dreaming-derived claim',
					  0.8, 0.5, 'active', 'general', 'target', 1, datetime('now'), datetime('now'), 'obsidian:signet', 'dreaming')`,
				)
				.run();
			write.prepare("UPDATE entity_attributes SET memory_id = ? WHERE id = ?").run("derived-claim", "derived-claim");
			write
				.prepare(
					`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
					 VALUES ('other-entity', 'Other', 'other', 'project', 'default', 0, datetime('now'), datetime('now'))`,
				)
				.run();
			write
				.prepare(
					`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
					 VALUES ('other-aspect', 'other-entity', 'default', 'facts', 'facts', 0.5, datetime('now'), datetime('now'))`,
				)
				.run();
			write
				.prepare(
					`INSERT INTO entity_attributes
					 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status,
					  group_key, claim_key, version, created_at, updated_at, source_id)
					 VALUES ('other-claim', 'other-aspect', 'default', 'attribute', 'unrelated claim', 'unrelated claim',
					  0.8, 0.5, 'active', 'general', 'target', 1, datetime('now'), datetime('now'), 'other:source')`,
				)
				.run();
		});

		const purged = purgeSourceOwnedRows({ agentId: "default", sourceId: "obsidian:signet" });
		expect(purged).toBeGreaterThan(0);
		const counts = getDbAccessor().withReadDb((read) => ({
			derived: (
				read.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE id = ?").get("derived-claim") as {
					count: number;
				}
			).count,
			other: (
				read.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE id = ?").get("other-claim") as {
					count: number;
				}
			).count,
			semanticMemory: (
				read.prepare("SELECT is_deleted FROM memories WHERE id = ?").get("derived-claim") as { is_deleted: number }
			).is_deleted,
		}));
		expect(counts).toEqual({ derived: 0, other: 1, semanticMemory: 1 });
	});

	it("stamps source-backed Dreaming writes with the purge key end to end", async () => {
		const quote = "Nightly drift detection protects the edge fleet.";
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, source_id, source_node_id,
				  session_id, session_token, captured_at, content, updated_at, is_deleted)
				 VALUES ('default', 'sources/nightly.md', 'nightly-sha', 'source_obsidian_markdown',
				  'obsidian:nightly', 'note-node-1', 'source-session', 'source-token',
				  datetime('now'), ?, datetime('now'), 0)`,
			).run(quote);
		});

		const result = await runDreamingAgentPass(
			getDbAccessor(),
			{
				async run(input) {
					const apply = input.tools.find((tool) => tool.name === "apply_ontology_ops");
					if (!apply) throw new Error("Missing apply_ontology_ops");
					await apply.execute(
						"source-owned-call",
						{
							agentId: "default",
							operations: [
								{
									operation: "create_entity",
									payload: { name: "Nightly Drift Detection", type: "workflow" },
									reason: "The source names a durable operational workflow.",
									evidence: [
										{
											source_ref: "artifact:sources/nightly.md",
											source_kind: "source_obsidian_markdown",
											source_id: "note-node-1",
											source_path: "sources/nightly.md",
											quote,
										},
									],
								},
							],
						},
						undefined,
						undefined,
						{} as never,
					);
					return { summary: "Applied source-owned Dreaming entity" };
				},
			},
			DREAMING_CONFIG,
			dir,
			"default",
			["default"],
			"incremental",
		);

		expect(result).toMatchObject({ applied: 1, failed: 0 });
		const derived = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					`SELECT source_id, source_kind, source_path, source_root
					 FROM entities WHERE agent_id = 'default' AND name = 'Nightly Drift Detection'`,
				)
				.get(),
		);
		expect(derived).toEqual({
			source_id: "obsidian:nightly",
			source_kind: "source_obsidian_markdown",
			source_path: "sources/nightly.md",
			source_root: "dreaming",
		});

		purgeSourceOwnedRows({ agentId: "default", sourceId: "obsidian:nightly" });
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS count FROM entities WHERE name = ?").get("Nightly Drift Detection") as {
						count: number;
					},
			).count,
		).toBe(0);
	});
});
