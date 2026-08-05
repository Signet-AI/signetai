import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { DEFAULT_PIPELINE_V2, type EmbeddingConfig, type PipelineV2Config } from "../memory-config";
import { installSkillNode, skillEmbeddingHash } from "./skill-graph";

function dbPath(): string {
	const dir = join(tmpdir(), `signet-skill-graph-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "memories.db");
}

function cfg(): PipelineV2Config {
	return {
		...DEFAULT_PIPELINE_V2,
		graph: { ...DEFAULT_PIPELINE_V2.graph, enabled: false },
	};
}

function graphEnabledCfg(): PipelineV2Config {
	return {
		...DEFAULT_PIPELINE_V2,
		graph: { ...DEFAULT_PIPELINE_V2.graph, enabled: true },
	};
}

const emb: EmbeddingConfig = {
	model: "test",
	dimensions: 768,
	provider: "ollama",
	base_url: "http://127.0.0.1:11434",
};

let path = "";

afterEach(() => {
	closeDbAccessor();
	if (path) {
		rmSync(path, { force: true });
		rmSync(`${path}-wal`, { force: true });
		rmSync(`${path}-shm`, { force: true });
	}
	path = "";
});

describe("installSkillNode", () => {
	it("upserts skill_meta when a duplicate entity_id row already exists", async () => {
		path = dbPath();
		initDbAccessor(path);
		const now = new Date().toISOString();
		const id = "skill:default:astro-portfolio-site";

		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO skill_meta
				 (entity_id, agent_id, source, role, installed_at, fs_path, enriched)
				 VALUES (?, 'default', 'reconciler', 'utility', ?, ?, 0)`,
			).run(id, now, "/tmp/skills/astro-portfolio-site/SKILL.md");
		});

		await installSkillNode(
			{
				frontmatter: {
					name: "astro-portfolio-site",
					description: "Build Astro portfolio websites from brand assets.",
				},
				body: "Skill body",
				source: "reconciler",
				fsPath: "/tmp/skills/astro-portfolio-site/SKILL.md",
			},
			getDbAccessor(),
			cfg(),
			emb,
			async () => null,
		);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT entity_id, uninstalled_at FROM skill_meta WHERE entity_id = ?").get(id) as
					| { entity_id: string; uninstalled_at: string | null }
					| undefined,
		);
		expect(row?.entity_id).toBe(id);
		expect(row?.uninstalled_at).toBeNull();
	});

	it("scopes skill embedding hashes by entity id", () => {
		const frontmatter = {
			name: "shared-skill",
			description: "same metadata",
			version: "1.0.0",
		} as const;
		expect(skillEmbeddingHash("skill:default:shared-skill", frontmatter)).not.toBe(
			skillEmbeddingHash("skill:other:shared-skill", frontmatter),
		);
	});
});

describe("installSkillNode semantic-writer cutover (#946)", () => {
	// A SKILL.md body long enough that the retired extractor would have run
	// (the old guard required body.trim().length >= 20). Mentions entities the
	// extractingProvider would return.
	const BODY =
		"This skill builds Astro portfolio websites and deploys them to GitHub Pages. " +
		"It reads brand assets and scaffolds the project from a template.";

	it("performs no LLM semantic extraction even with graph + provider available", async () => {
		path = dbPath();
		initDbAccessor(path);

		const result = await installSkillNode(
			{
				frontmatter: {
					name: "astro-portfolio-site",
					description: "Build Astro portfolio websites from brand assets.",
				},
				body: BODY,
				source: "reconciler",
				fsPath: "/tmp/skills/astro-portfolio-site/SKILL.md",
			},
			getDbAccessor(),
			graphEnabledCfg(),
			emb,
			async () => null,
		);

		// The result contract no longer reports extracted entities.
		expect("entitiesExtracted" in result).toBe(false);

		const accessor = getDbAccessor();

		// Only the single native skill entity exists — no extracted semantic entities.
		const entities = accessor.withReadDb(
			(db) =>
				db.prepare("SELECT id, name, entity_type FROM entities WHERE agent_id = 'default'").all() as Array<{
					id: string;
					name: string;
					entity_type: string;
				}>,
		);
		expect(entities).toHaveLength(1);
		expect(entities[0]?.entity_type).toBe("skill");
		expect(entities[0]?.name).toBe("astro-portfolio-site");

		// No relations authored by skill install (cross-skill links are owned by
		// the audited Dreaming apply path).
		const relationCount = accessor.withReadDb(
			(db) =>
				db
					.prepare("SELECT COUNT(*) AS n FROM relations WHERE source_entity_id = ? OR target_entity_id = ?")
					.get(result.entityId, result.entityId) as { n: number },
		);
		expect(relationCount.n).toBe(0);

		// No mention links created from the body.
		const mentionCount = accessor.withReadDb(
			(db) =>
				db.prepare("SELECT COUNT(*) AS n FROM memory_entity_mentions WHERE entity_id = ?").get(result.entityId) as {
					n: number;
				},
		);
		expect(mentionCount.n).toBe(0);
	});

	it("retained skill entity has correct source topology and provenance", async () => {
		path = dbPath();
		initDbAccessor(path);

		const result = await installSkillNode(
			{
				frontmatter: {
					name: "source-native-skill",
					description: "A skill that ships its own SKILL.md frontmatter.",
					version: "2.1.0",
					author: "Signet",
					role: "workflow",
				},
				body: BODY,
				source: "installed",
				fsPath: "/tmp/skills/source-native-skill/SKILL.md",
			},
			getDbAccessor(),
			graphEnabledCfg(),
			emb,
			async () => null,
		);

		const accessor = getDbAccessor();

		// Source topology: the skill node itself is native, written directly with
		// entity_type = 'skill'.
		const entity = accessor.withReadDb(
			(db) =>
				db.prepare("SELECT entity_type, description FROM entities WHERE id = ?").get(result.entityId) as {
					entity_type: string;
					description: string | null;
				},
		);
		expect(entity.entity_type).toBe("skill");
		expect(entity.description).toBe("A skill that ships its own SKILL.md frontmatter.");

		// Provenance: skill_meta carries the install source, version, and role.
		const meta = accessor.withReadDb(
			(db) =>
				db
					.prepare("SELECT source, version, author, role, enriched, fs_path FROM skill_meta WHERE entity_id = ?")
					.get(result.entityId) as {
					source: string;
					version: string | null;
					author: string | null;
					role: string;
					enriched: number;
					fs_path: string;
				},
		);
		expect(meta.source).toBe("installed");
		expect(meta.version).toBe("2.1.0");
		expect(meta.author).toBe("Signet");
		expect(meta.role).toBe("workflow");
		expect(meta.enriched).toBe(0);
		expect(meta.fs_path).toBe("/tmp/skills/source-native-skill/SKILL.md");
	});
});
