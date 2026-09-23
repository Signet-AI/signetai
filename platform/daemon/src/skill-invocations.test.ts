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

	afterEach(async () => {
		db.close();
		await closeDbAccessor();
		rmSync(path, { force: true });
	});

	it("does not inflate use_count on a deduped re-insert (idempotent harness re-scan)", () => {
		seedSkill(db, { id: "skill-ws", name: "web-search", agentId: "agent-scan" });

		const base = {
			skillName: "web-search",
			agentId: "agent-scan",
			source: "agent" as const,
			latencyMs: 10,
			success: true,
			harness: "claude-code",
			sessionId: "sess-abc",
			toolUseId: "tool-use-1",
		};

		// First call — should insert one row and bump use_count to 1.
		recordSkillInvocation(base);
		// Second identical call — dedupe index drops it; use_count must NOT increase.
		recordSkillInvocation(base);

		const invCount = (
			db
				.prepare(
					"SELECT COUNT(*) AS cnt FROM skill_invocations WHERE skill_name = ? AND agent_id = ? AND tool_use_id = ?",
				)
				.get("web-search", "agent-scan", "tool-use-1") as { cnt: number }
		).cnt;
		expect(invCount).toBe(1);

		const meta = db.prepare("SELECT use_count FROM skill_meta WHERE agent_id = ?").get("agent-scan") as
			| { use_count: number }
			| undefined;
		expect(meta?.use_count).toBe(1);

		// A genuinely new toolUseId counts as a new invocation.
		recordSkillInvocation({ ...base, toolUseId: "tool-use-2" });

		const metaAfter = db.prepare("SELECT use_count FROM skill_meta WHERE agent_id = ?").get("agent-scan") as
			| { use_count: number }
			| undefined;
		expect(metaAfter?.use_count).toBe(2);
	});

	it("deduplicates harness invocations per agent", () => {
		const base = {
			skillName: "web-search",
			source: "agent" as const,
			latencyMs: 10,
			success: true,
			harness: "claude-code",
			sessionId: "sess-shared",
			toolUseId: "tool-use-shared",
		};

		recordSkillInvocation({ ...base, agentId: "agent-one" });
		recordSkillInvocation({ ...base, agentId: "agent-two" });

		const invCount = (
			db
				.prepare("SELECT COUNT(*) AS cnt FROM skill_invocations WHERE session_id = ? AND tool_use_id = ?")
				.get("sess-shared", "tool-use-shared") as { cnt: number }
		).cnt;
		expect(invCount).toBe(2);
	});
});
