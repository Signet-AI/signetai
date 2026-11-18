import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor, initDbAccessorAsync } from "./db-accessor";
import { matchPromptEntities, promptPhraseSpan } from "./prompt-entity-context";

let dir = "";
let prev: string | undefined;

const DB_PATH = (): string => join(dir, "memory", "memories.db");

function seedEntities(): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		for (const [id, name, canonical, type, agentId] of [
			["ent-nicholai", "Nicholai", "nicholai", "person", "default"],
			["ent-signet", "Signet", "signet", "project", "default"],
			["ent-other-agent", "Compass", "compass", "project", "other-agent"],
		] as const) {
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 10, ?, ?)`,
			).run(id, name, canonical, type, agentId, now, now);
		}
		db.prepare(
			`INSERT INTO entity_aliases
			 (id, entity_id, agent_id, alias, canonical_alias, confidence, source, status, created_at, updated_at)
			 VALUES ('alias-signetai', 'ent-signet', 'default', 'SignetAI', 'signetai', 1, 'test', 'active', ?, ?)`,
		).run(now, now);
	});
}

describe("matchPromptEntities", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-prompt-entity-context-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "memory:\n  pipelineV2:\n    enabled: false\n");
		process.env.SIGNET_PATH = dir;
		await initDbAccessorAsync(DB_PATH(), { agentsDir: dir });
	});

	beforeEach(async () => {
		await closeDbAccessor();
		for (const file of readdirSync(join(dir, "memory"))) {
			if (file.startsWith("memories.db")) rmSync(join(dir, "memory", file), { force: true });
		}
		initDbAccessor(DB_PATH(), { agentsDir: dir });
		seedEntities();
	});

	afterEach(async () => {
		await closeDbAccessor();
	});

	afterAll(async () => {
		await closeDbAccessor();
		if (prev === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = prev;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns every directly named entity for the agent", async () => {
		const matches = await matchPromptEntities(DB_PATH(), "default", "Tell me about Nicholai and the Signet project");
		expect(matches.map((match) => match.entityName).sort()).toEqual(["Nicholai", "Signet"]);
	});

	it("resolves active aliases to the canonical entity", async () => {
		const matches = await matchPromptEntities(DB_PATH(), "default", "How is SignetAI doing?");
		expect(matches.map((match) => [match.entityName, match.matchSource])).toEqual([["Signet", "alias"]]);
	});

	it("never matches another agent's entities", async () => {
		expect(await matchPromptEntities(DB_PATH(), "default", "What is Compass?")).toEqual([]);
		const other = await matchPromptEntities(DB_PATH(), "other-agent", "What is Compass?");
		expect(other.map((match) => match.entityName)).toEqual(["Compass"]);
	});

	describe("promptPhraseSpan matches precomputed prompt terms", () => {
		const promptTerms = ["tell", "me", "about", "nicholai", "and", "the", "signet", "project"];

		it("locates an exact entity phrase", () => {
			expect(promptPhraseSpan(promptTerms, "Nicholai")).toEqual({ start: 3, end: 4 });
			expect(promptPhraseSpan(promptTerms, "Signet")).toEqual({ start: 6, end: 7 });
		});

		it("normalizes possessive forms before matching", () => {
			expect(promptPhraseSpan(promptTerms, "Nicholai's")).toEqual({ start: 3, end: 4 });
		});

		it("matches a pluralized prompt term for a singular phrase", () => {
			expect(promptPhraseSpan(["i", "love", "signets"], "signet")).toEqual({ start: 2, end: 3 });
		});

		it("rejects absent, too-short, and over-long phrases", () => {
			expect(promptPhraseSpan(promptTerms, "zebra")).toBeNull();
			expect(promptPhraseSpan(promptTerms, "ok")).toBeNull();
			expect(promptPhraseSpan(promptTerms, "nicholai and the signet project plus extra")).toBeNull();
		});
	});
});
