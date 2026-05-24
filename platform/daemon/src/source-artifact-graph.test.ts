import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { indexSourceArtifactStructure, purgeSourceArtifactStructure } from "./source-artifact-graph";
import { purgeSourceOwnedRows } from "./source-purge";

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
});
