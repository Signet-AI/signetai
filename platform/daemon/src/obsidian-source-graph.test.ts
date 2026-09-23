import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	buildObsidianMarkdownPathIndex,
	indexObsidianSourceStructure,
	purgeObsidianSourceFileStructure,
	purgeObsidianSourceStructure,
} from "./obsidian-source-graph";
import { txIngestEnvelope } from "./transactions";

describe("Obsidian source graph structure", () => {
	let dir = "";
	let vault = "";
	let prevSignetPath: string | undefined;
	let prevAgentId: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-obsidian-graph-"));
		vault = join(dir, "vault");
		mkdirSync(join(dir, "memory"), { recursive: true });
		mkdirSync(join(vault, "literature", "Arch-Linux"), { recursive: true });
		prevSignetPath = process.env.SIGNET_PATH;
		prevAgentId = process.env.SIGNET_AGENT_ID;
		process.env.SIGNET_PATH = dir;
		process.env.SIGNET_AGENT_ID = "obsidian-graph-agent";
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (prevSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = prevSignetPath;
		if (prevAgentId === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		else process.env.SIGNET_AGENT_ID = prevAgentId;
		rmSync(dir, { recursive: true, force: true });
	});

	it("maps vault folders, files, wikilinks, headings, and body claims into the existing graph", () => {
		const doc = join(vault, "literature", "Arch-Linux", "hyprland-desktop-shells.md");
		const linked = join(vault, "literature", "Arch-Linux", "quickshell.md");
		writeFileSync(
			doc,
			"---\ntags:\n  - linux\n  - desktop-shells\n---\n# Hyprland Desktop Shells\n\nHyprland and Quickshell are part of the Arch Linux desktop shell research context.\n\n## Constraints\n\nUse [[quickshell]] with [[Arch Linux]] and [[Wayland]].\n",
		);
		writeFileSync(linked, "# Quickshell\n\nQuickshell is a shell toolkit.\n");

		const result = indexObsidianSourceStructure({
			agentId: "obsidian-graph-agent",
			sourceId: "obsidian:test-vault",
			sourceName: "Test Vault",
			root: vault,
			filePath: doc,
			content: readFileSync(doc, "utf-8"),
		});

		expect(result.documentEntityId).toBeTruthy();
		expect(result.folderEntitiesTouched).toBeGreaterThanOrEqual(2);
		expect(result.documentEntitiesTouched).toBeGreaterThanOrEqual(1);
		expect(result.dependenciesTouched).toBeGreaterThanOrEqual(3);
		expect(result.aspectsTouched).toBeGreaterThanOrEqual(2);
		expect(result.attributesTouched).toBeGreaterThanOrEqual(2);

		const db = getDbAccessor();
		const rows = db.withReadDb((read) => {
			return {
				doc: read
					.prepare(
						`SELECT name, canonical_name, entity_type, source_path, source_kind, source_id
						 FROM entities WHERE agent_id = ? AND source_path = ?`,
					)
					.get("obsidian-graph-agent", doc) as Record<string, unknown>,
				folder: read
					.prepare(
						`SELECT name, canonical_name, entity_type, source_path
						 FROM entities WHERE agent_id = ? AND canonical_name = ?`,
					)
					.get("obsidian-graph-agent", "obsidian:obsidian:test-vault:folder:literature/Arch-Linux") as Record<
					string,
					unknown
				>,
				community: read
					.prepare("SELECT name, source_path FROM entity_communities WHERE agent_id = ? AND source_path = ?")
					.get("obsidian-graph-agent", join(vault, "literature", "Arch-Linux")) as Record<string, unknown>,
				aspects: read
					.prepare(
						`SELECT ea.name FROM entity_aspects ea
						 JOIN entities e ON e.id = ea.entity_id
						 WHERE e.source_path = ? ORDER BY ea.canonical_name`,
					)
					.all(doc) as Array<{ name: string }>,
				attrs: read
					.prepare(
						`SELECT content, source_path, group_key, claim_key FROM entity_attributes
						 WHERE agent_id = ? AND source_path = ? ORDER BY claim_key`,
					)
					.all("obsidian-graph-agent", doc) as Array<Record<string, unknown>>,
				links: read
					.prepare(
						`SELECT dependency_type, source_path, reason FROM entity_dependencies
						 WHERE agent_id = ? AND source_path = ? ORDER BY dependency_type, reason`,
					)
					.all("obsidian-graph-agent", doc) as Array<Record<string, unknown>>,
			};
		});

		expect(rows.doc.entity_type).toBe("source_document");
		expect(rows.doc.canonical_name).toBe(
			"obsidian:obsidian:test-vault:document:literature/Arch-Linux/hyprland-desktop-shells.md",
		);
		expect(rows.doc.source_kind).toBe("source_obsidian_markdown");
		expect(rows.doc.source_id).toBe("obsidian:test-vault");
		expect(rows.folder.entity_type).toBe("source_folder");
		expect(rows.folder.source_path).toBe(join(vault, "literature", "Arch-Linux"));
		expect(rows.community.name).toBe("literature/Arch-Linux");
		expect(rows.aspects.map((row) => row.name)).toContain("Hyprland Desktop Shells");
		expect(rows.aspects.map((row) => row.name)).toContain("Constraints");
		expect(rows.attrs.some((row) => String(row.content).includes("Hyprland and Quickshell"))).toBe(true);
		expect(rows.attrs.every((row) => row.source_path === doc)).toBe(true);
		expect(rows.attrs.some((row) => row.group_key === "literature_arch_linux")).toBe(true);
		expect(rows.links.some((row) => row.dependency_type === "contains")).toBe(true);
		expect(rows.links.some((row) => row.dependency_type === "wiki_link")).toBe(true);
		expect(rows.links.every((row) => row.source_path === doc)).toBe(true);
	});

	it("purges only graph structure owned by a disconnected Obsidian source", () => {
		const doc = join(vault, "literature", "Arch-Linux", "hyprland-desktop-shells.md");
		writeFileSync(doc, "# Hyprland\n\nLinks to [[quickshell]].\n");
		indexObsidianSourceStructure({
			agentId: "obsidian-graph-agent",
			sourceId: "obsidian:test-vault",
			sourceName: "Test Vault",
			root: vault,
			filePath: doc,
			content: readFileSync(doc, "utf-8"),
		});

		const purged = purgeObsidianSourceStructure({
			agentId: "obsidian-graph-agent",
			sourceId: "obsidian:test-vault",
			root: vault,
		});

		expect(purged.entities).toBeGreaterThan(0);
		const remaining = getDbAccessor().withReadDb((db) => ({
			entities: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND source_id = ?")
					.get("obsidian-graph-agent", "obsidian:test-vault") as { count: number }
			).count,
			attrs: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE agent_id = ? AND source_id = ?")
					.get("obsidian-graph-agent", "obsidian:test-vault") as { count: number }
			).count,
			deps: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entity_dependencies WHERE agent_id = ? AND source_id = ?")
					.get("obsidian-graph-agent", "obsidian:test-vault") as { count: number }
			).count,
			communities: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entity_communities WHERE agent_id = ? AND source_id = ?")
					.get("obsidian-graph-agent", "obsidian:test-vault") as { count: number }
			).count,
		}));
		expect(remaining).toEqual({ entities: 0, attrs: 0, deps: 0, communities: 0 });
	});

	it("resolves cross-folder wikilinks from a per-scan markdown path index", () => {
		const doc = join(vault, "literature", "Arch-Linux", "hyprland.md");
		const nestedTarget = join(vault, "literature", "Other", "Deep Target.md");
		mkdirSync(join(vault, "literature", "Other"), { recursive: true });
		writeFileSync(doc, "# Hyprland\n\nLinks to [[deep-target]].\n");
		writeFileSync(nestedTarget, "# Deep Target\n\nThis file exists elsewhere in the vault.\n");
		const markdownPathIndex = buildObsidianMarkdownPathIndex(vault, [doc, nestedTarget]);

		indexObsidianSourceStructure({
			agentId: "obsidian-graph-agent",
			sourceId: "obsidian:test-vault",
			sourceName: "Test Vault",
			root: vault,
			filePath: doc,
			content: readFileSync(doc, "utf-8"),
			markdownPathIndex,
		});

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT entity_type, source_path
						 FROM entities
						 WHERE agent_id = ?
						   AND canonical_name = ?`,
					)
					.get("obsidian-graph-agent", "obsidian:obsidian:test-vault:document:literature/Other/Deep Target.md") as
					| { entity_type: string; source_path: string }
					| undefined,
		);
		expect(row).toEqual({
			entity_type: "source_document",
			source_path: nestedTarget,
		});
	});

	it("refreshes a changed note by removing stale headings, claims, and wiki-link dependencies", () => {
		const doc = join(vault, "literature", "Arch-Linux", "mutable.md");
		writeFileSync(
			doc,
			"# Mutable\n\nThis original paragraph should disappear after re-indexing this source note.\n\n## Old Heading\n\nSee [[Old Target]].\n",
		);
		indexObsidianSourceStructure({
			agentId: "obsidian-graph-agent",
			sourceId: "obsidian:test-vault",
			sourceName: "Test Vault",
			root: vault,
			filePath: doc,
			content: readFileSync(doc, "utf-8"),
		});

		writeFileSync(
			doc,
			"# Mutable\n\nThis replacement paragraph should be the only active source claim after refresh.\n\n## New Heading\n\nSee [[New Target]].\n",
		);
		indexObsidianSourceStructure({
			agentId: "obsidian-graph-agent",
			sourceId: "obsidian:test-vault",
			sourceName: "Test Vault",
			root: vault,
			filePath: doc,
			content: readFileSync(doc, "utf-8"),
		});

		const rows = getDbAccessor().withReadDb((db) => ({
			aspects: db
				.prepare(
					`SELECT ea.name FROM entity_aspects ea
					 JOIN entities e ON e.id = ea.entity_id
					 WHERE e.agent_id = ? AND e.source_path = ? ORDER BY ea.name`,
				)
				.all("obsidian-graph-agent", doc) as Array<{ name: string }>,
			attrs: db
				.prepare("SELECT content FROM entity_attributes WHERE agent_id = ? AND source_path = ? ORDER BY content")
				.all("obsidian-graph-agent", doc) as Array<{ content: string }>,
			deps: db
				.prepare("SELECT reason FROM entity_dependencies WHERE agent_id = ? AND source_path = ? ORDER BY reason")
				.all("obsidian-graph-agent", doc) as Array<{ reason: string }>,
		}));

		expect(rows.aspects.map((row) => row.name)).toContain("New Heading");
		expect(rows.aspects.map((row) => row.name)).not.toContain("Old Heading");
		expect(rows.attrs.some((row) => row.content.includes("replacement paragraph"))).toBe(true);
		expect(rows.attrs.some((row) => row.content.includes("original paragraph"))).toBe(false);
		expect(rows.deps.some((row) => row.reason.includes("New Target"))).toBe(true);
		expect(rows.deps.some((row) => row.reason.includes("Old Target"))).toBe(false);
	});

	it("purges graph structure for a removed source file without dropping sibling notes", () => {
		const doc = join(vault, "literature", "Arch-Linux", "removed.md");
		const sibling = join(vault, "literature", "Arch-Linux", "sibling.md");
		writeFileSync(doc, "# Removed\n\nA removed note claim should leave the graph when the source file disappears.\n");
		writeFileSync(sibling, "# Sibling\n\nA sibling note claim should remain after another source file is purged.\n");
		for (const filePath of [doc, sibling]) {
			indexObsidianSourceStructure({
				agentId: "obsidian-graph-agent",
				sourceId: "obsidian:test-vault",
				sourceName: "Test Vault",
				root: vault,
				filePath,
				content: readFileSync(filePath, "utf-8"),
			});
		}
		getDbAccessor().withWriteTx((db) => {
			const aspect = db
				.prepare(
					`SELECT attr.aspect_id
					 FROM entity_attributes attr
					 WHERE attr.agent_id = ? AND attr.source_path = ? LIMIT 1`,
				)
				.get("obsidian-graph-agent", doc) as { aspect_id: string };
			txIngestEnvelope(db, {
				id: "removed-dreaming-claim",
				content: "The removed note contains this semantic claim.",
				normalizedContent: "the removed note contains this semantic claim.",
				contentHash: "semantic-attribute:removed-dreaming-claim",
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
				sourceId: "obsidian:test-vault",
				sourcePath: doc,
				agentId: "obsidian-graph-agent",
				visibility: "global",
				createdAt: new Date().toISOString(),
			});
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status,
				  group_key, claim_key, version, memory_id, created_at, updated_at, source_id, source_root, source_path)
				 VALUES (?, ?, ?, 'attribute', ?, ?, 0.9, 0.5, 'active', 'general', 'removed_dreaming_claim', 1, ?,
				         datetime('now'), datetime('now'), ?, 'dreaming', ?)`,
			).run(
				"removed-dreaming-claim",
				aspect.aspect_id,
				"obsidian-graph-agent",
				"The removed note contains this semantic claim.",
				"the removed note contains this semantic claim.",
				"removed-dreaming-claim",
				"obsidian:test-vault",
				doc,
			);
		});

		const purged = purgeObsidianSourceFileStructure({
			agentId: "obsidian-graph-agent",
			sourceId: "obsidian:test-vault",
			root: vault,
			filePath: doc,
		});

		expect(purged.entities).toBeGreaterThan(0);
		const remaining = getDbAccessor().withReadDb((db) => ({
			removedEntities: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND source_path = ?")
					.get("obsidian-graph-agent", doc) as { count: number }
			).count,
			removedAttrs: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE agent_id = ? AND source_path = ?")
					.get("obsidian-graph-agent", doc) as { count: number }
			).count,
			siblingEntities: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND source_path = ?")
					.get("obsidian-graph-agent", sibling) as { count: number }
			).count,
			siblingAttrs: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE agent_id = ? AND source_path = ?")
					.get("obsidian-graph-agent", sibling) as { count: number }
			).count,
			removedSemanticMemory: (
				db.prepare("SELECT is_deleted FROM memories WHERE id = ?").get("removed-dreaming-claim") as {
					is_deleted: number;
				}
			).is_deleted,
		}));
		expect(remaining.removedEntities).toBe(0);
		expect(remaining.removedAttrs).toBe(0);
		expect(remaining.siblingEntities).toBeGreaterThan(0);
		expect(remaining.siblingAttrs).toBeGreaterThan(0);
		expect(remaining.removedSemanticMemory).toBe(1);
	});

	it("keeps same-agent vaults with identical relative paths isolated by source id", () => {
		const vaultA = join(dir, "vault-a");
		const vaultB = join(dir, "vault-b");
		const docA = join(vaultA, "shared", "Index.md");
		const docB = join(vaultB, "shared", "Index.md");
		mkdirSync(join(vaultA, "shared"), { recursive: true });
		mkdirSync(join(vaultB, "shared"), { recursive: true });
		writeFileSync(docA, "# Index\n\nVault A source graph content has a distinct provenance root.\n");
		writeFileSync(docB, "# Index\n\nVault B source graph content has a distinct provenance root.\n");

		indexObsidianSourceStructure({
			agentId: "obsidian-graph-agent",
			sourceId: "obsidian:vault-a",
			sourceName: "Vault A",
			root: vaultA,
			filePath: docA,
			content: readFileSync(docA, "utf-8"),
		});
		indexObsidianSourceStructure({
			agentId: "obsidian-graph-agent",
			sourceId: "obsidian:vault-b",
			sourceName: "Vault B",
			root: vaultB,
			filePath: docB,
			content: readFileSync(docB, "utf-8"),
		});

		const before = getDbAccessor().withReadDb((db) => ({
			docs: db
				.prepare(
					`SELECT source_id, source_root, canonical_name FROM entities
					 WHERE agent_id = ? AND entity_type = 'source_document' AND canonical_name LIKE '%:document:shared/Index.md'
					 ORDER BY source_id`,
				)
				.all("obsidian-graph-agent") as Array<{ source_id: string; source_root: string; canonical_name: string }>,
		}));
		expect(before.docs).toHaveLength(2);
		expect(before.docs.map((row) => row.source_id)).toEqual(["obsidian:vault-a", "obsidian:vault-b"]);
		expect(new Set(before.docs.map((row) => row.canonical_name)).size).toBe(2);

		purgeObsidianSourceStructure({
			agentId: "obsidian-graph-agent",
			sourceId: "obsidian:vault-a",
			root: vaultA,
		});

		const after = getDbAccessor().withReadDb((db) => ({
			vaultA: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND source_id = ?")
					.get("obsidian-graph-agent", "obsidian:vault-a") as { count: number }
			).count,
			vaultB: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND source_id = ?")
					.get("obsidian-graph-agent", "obsidian:vault-b") as { count: number }
			).count,
		}));
		expect(after.vaultA).toBe(0);
		expect(after.vaultB).toBeGreaterThan(0);
	});

	it("purges Dreaming-derived semantic rows stamped with the source entry id on disconnect", () => {
		// Regression for #946: a Dreaming pass stamps claim values and links with
		// the configured Signet source entry id in source_id but the literal
		// source_root 'dreaming' (not the vault root). The Obsidian disconnect
		// purge must remove those derived rows alongside the vault-root topology,
		// mirroring purgeSourceOwnedRows (used by the GitHub/Discord providers).
		const root = join(dir, "dreaming-vault");
		mkdirSync(root, { recursive: true });
		const sourceId = "obsidian:dreaming-vault";

		// Stand up a source-owned Dreaming entity/aspect with a claim and link
		// stamped with the source entry id + source_root 'dreaming'.
		const db = getDbAccessor();
		db.withWriteTx((write) => {
			write
				.prepare(
					`INSERT INTO entities
					 (id, name, canonical_name, entity_type, agent_id, mentions, source_id, source_root, created_at, updated_at)
					 VALUES ('derived-entity', 'Derived', 'derived', 'project', 'obsidian-graph-agent', 0, ?, 'dreaming',
					 datetime('now'), datetime('now'))`,
				)
				.run(sourceId);
			write
				.prepare(
					`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
					 VALUES ('derived-aspect', 'derived-entity', 'obsidian-graph-agent', 'facts', 'facts', 0.5,
					 datetime('now'), datetime('now'))`,
				)
				.run();
			write
				.prepare(
					`INSERT INTO entity_attributes
					 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status,
					 group_key, claim_key, version, created_at, updated_at, source_id, source_kind, source_path, source_root)
					 VALUES ('derived-claim', 'derived-aspect', 'obsidian-graph-agent', 'attribute',
					 'dreaming-derived claim', 'dreaming-derived claim', 0.8, 0.5, 'active', 'general', 'target', 1,
					 datetime('now'), datetime('now'), ?, 'source_obsidian_markdown', 'dreaming-vault/note.md', 'dreaming')`,
				)
				.run(sourceId);
			write
				.prepare(
					`INSERT INTO entity_dependencies
					 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, reason,
					 created_at, updated_at, source_id, source_kind, source_path, source_root)
					 VALUES ('derived-link', 'derived-entity', 'derived-entity', 'obsidian-graph-agent', 'related_to',
					 0.7, 0.6, 'dreaming-derived link', datetime('now'), datetime('now'), ?,
					 'source_obsidian_markdown', 'dreaming-vault/note.md', 'dreaming')`,
				)
				.run(sourceId);
		});

		const purged = purgeObsidianSourceStructure({
			agentId: "obsidian-graph-agent",
			sourceId,
			root,
		});
		expect(purged.attributes).toBeGreaterThan(0);
		expect(purged.dependencies).toBeGreaterThan(0);

		const remaining = getDbAccessor().withReadDb((read) => ({
			entity: (
				read.prepare("SELECT COUNT(*) AS count FROM entities WHERE id = ?").get("derived-entity") as {
					count: number;
				}
			).count,
			claim: (
				read.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE id = ?").get("derived-claim") as {
					count: number;
				}
			).count,
			link: (
				read.prepare("SELECT COUNT(*) AS count FROM entity_dependencies WHERE id = ?").get("derived-link") as {
					count: number;
				}
			).count,
		}));
		expect(remaining.entity).toBe(0);
		expect(remaining.claim).toBe(0);
		expect(remaining.link).toBe(0);
	});

	it("preserves vault-root topology purge and user-owned contrast rows on disconnect", () => {
		// Disconnect must still purge the vault-root topology rows AND remove the
		// dreaming-rooted derived rows for that source, while keeping unrelated
		// user-owned rows and rows belonging to a different source.
		const root = join(dir, "disconnect-vault");
		mkdirSync(root, { recursive: true });
		const doc = join(root, "Note.md");
		writeFileSync(doc, "# Note\n\nA source topology claim that should be purged by disconnect.\n");
		indexObsidianSourceStructure({
			agentId: "obsidian-graph-agent",
			sourceId: "obsidian:disconnect-vault",
			sourceName: "Disconnect Vault",
			root,
			filePath: doc,
			content: readFileSync(doc, "utf-8"),
		});

		const db = getDbAccessor();
		// User-owned semantic claim on a separate entity with no source provenance
		// (operator-created, not source-owned): must survive the disconnect purge.
		db.withWriteTx((write) => {
			write
				.prepare(
					`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
					 VALUES ('user-entity', 'UserOwned', 'userowned', 'project', 'obsidian-graph-agent', 0,
					 datetime('now'), datetime('now'))`,
				)
				.run();
			write
				.prepare(
					`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
					 VALUES ('user-aspect', 'user-entity', 'obsidian-graph-agent', 'facts', 'facts', 0.5,
					 datetime('now'), datetime('now'))`,
				)
				.run();
			write
				.prepare(
					`INSERT INTO entity_attributes
					 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status,
					 group_key, claim_key, version, created_at, updated_at)
					 VALUES ('user-claim', 'user-aspect', 'obsidian-graph-agent', 'attribute',
					 'user-owned claim survives disconnect', 'user-owned claim survives disconnect', 0.9, 0.6, 'active',
					 'general', 'target', 1, datetime('now'), datetime('now'))`,
				)
				.run();
			// A Dreaming-derived claim from a DIFFERENT source: must survive.
			write
				.prepare(
					`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
					 VALUES ('other-entity', 'OtherSource', 'othersource', 'project', 'obsidian-graph-agent', 0,
					 datetime('now'), datetime('now'))`,
				)
				.run();
			write
				.prepare(
					`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
					 VALUES ('other-aspect', 'other-entity', 'obsidian-graph-agent', 'facts', 'facts', 0.5,
					 datetime('now'), datetime('now'))`,
				)
				.run();
			write
				.prepare(
					`INSERT INTO entity_attributes
					 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status,
					 group_key, claim_key, version, created_at, updated_at, source_id, source_root)
					 VALUES ('other-derived-claim', 'other-aspect', 'obsidian-graph-agent', 'attribute',
					 'other source dreaming claim survives', 'other source dreaming claim survives', 0.8, 0.5, 'active',
					 'general', 'target', 1, datetime('now'), datetime('now'), 'obsidian:other-vault', 'dreaming')`,
				)
				.run();
		});

		const purged = purgeObsidianSourceStructure({
			agentId: "obsidian-graph-agent",
			sourceId: "obsidian:disconnect-vault",
			root,
		});
		// Vault-root topology rows removed.
		expect(purged.entities).toBeGreaterThan(0);
		expect(purged.attributes).toBeGreaterThan(0);

		const remaining = getDbAccessor().withReadDb((read) => ({
			topologyEntities: (
				read
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND source_id = ?")
					.get("obsidian-graph-agent", "obsidian:disconnect-vault") as { count: number }
			).count,
			userClaim: (
				read.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE id = ?").get("user-claim") as {
					count: number;
				}
			).count,
			otherDerived: (
				read.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE id = ?").get("other-derived-claim") as {
					count: number;
				}
			).count,
		}));
		expect(remaining.topologyEntities).toBe(0);
		expect(remaining.userClaim).toBe(1);
		expect(remaining.otherDerived).toBe(1);
	});
});
