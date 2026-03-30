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
		procedural: { ...DEFAULT_PIPELINE_V2.procedural, enrichOnInstall: false },
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
			null,
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
