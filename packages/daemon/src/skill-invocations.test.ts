import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "../../core/src/migrations";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { recordSkillInvocation } from "./skill-invocations";

function seedSkill(db: Database, input: { id: string; name: string; agentId: string }): void {
	db.prepare(
		`INSERT INTO entities
		 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
		 VALUES (?, ?, ?, 'skill', ?, 0, datetime('now'), datetime('now'))`,
	).run(input.id, input.name, input.name.toLowerCase(), input.agentId);

	db.prepare(
		`INSERT INTO skill_meta
		 (entity_id, agent_id, source, installed_at, fs_path)
		 VALUES (?, ?, 'signet', datetime('now'), ?)`,
	).run(input.id, input.agentId, `/tmp/skills/${input.name}/SKILL.md`);
}

describe("recordSkillInvocation", () => {
	let db: Database;
	let path: string;

	beforeEach(() => {
		path = join("/tmp", `signet-skill-invocations-${crypto.randomUUID()}.db`);
		initDbAccessor(path);
		db = new Database(path);
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
		closeDbAccessor();
		rmSync(path, { force: true });
	});

	it("records usage under the provided agent and updates matching skill metadata", () => {
		seedSkill(db, { id: "skill-a", name: "web-search", agentId: "agent-a" });

		recordSkillInvocation({
			skillName: "web-search",
			agentId: "agent-a",
			source: "scheduler",
			latencyMs: 123,
			success: true,
		});

		const row = db.prepare("SELECT agent_id, skill_name FROM skill_invocations").get() as
			| { agent_id: string; skill_name: string }
			| undefined;
		expect(row).toEqual({
			agent_id: "agent-a",
			skill_name: "web-search",
		});

		const meta = db.prepare("SELECT use_count, last_used_at FROM skill_meta WHERE agent_id = ?").get("agent-a") as
			| { use_count: number; last_used_at: string | null }
			| undefined;
		expect(meta?.use_count).toBe(1);
		expect(meta?.last_used_at).not.toBeNull();
	});

	it("keeps historical rows even when skill metadata is missing", () => {
		recordSkillInvocation({
			skillName: "browser-use",
			agentId: "agent-b",
			source: "scheduler",
			latencyMs: 50,
			success: true,
		});

		const row = db.prepare("SELECT agent_id, skill_name FROM skill_invocations").get() as
			| { agent_id: string; skill_name: string }
			| undefined;
		expect(row).toEqual({
			agent_id: "agent-b",
			skill_name: "browser-use",
		});
	});
});
