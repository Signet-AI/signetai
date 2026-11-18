import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor, initDbAccessorAsync } from "./db-accessor";
import type { DbOwnerJobHandle, DbOwnerRequest, DbOwnerSubmitOptions } from "./db-owner-client";
import { getDbOwner } from "./db-owner-runtime";
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

	it("pages the owner scan so a large ontology still matches", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			const insert = db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', 'default', 1, ?, ?)`,
			);
			for (let index = 0; index < 7_000; index += 1) {
				const name = `Filler Project Number ${index} With A Deliberately Long Descriptive Name`;
				insert.run(`ent-filler-${index}`, name, name.toLowerCase(), now, now);
			}
			insert.run("ent-zephyr", "Zephyrline", "zephyrline", now, now);
		});
		const matches = await matchPromptEntities(DB_PATH(), "default", "What is the status of Zephyrline?");
		expect(matches.map((match) => match.entityName)).toEqual(["Zephyrline"]);
	});

	it("skips over-long entity names without failing the page", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			const insert = db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', 'default', 1, ?, ?)`,
			);
			for (let index = 0; index < 1_000; index += 1) {
				const name = `Long Project ${index} ${"descriptive words ".repeat(34)}`.trim();
				insert.run(`ent-long-${index}`, name, name.toLowerCase(), now, now);
			}
			insert.run("ent-quillon", "Quillonbridge", "quillonbridge", now, now);
		});
		const matches = await matchPromptEntities(DB_PATH(), "default", "Is Quillonbridge shipping this week?");
		expect(matches.map((match) => match.entityName)).toEqual(["Quillonbridge"]);
	});

	it("reads full pages past a name larger than the owner result limit", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			const insert = db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', 'default', 1, ?, ?)`,
			);
			const huge = `Oversized ${"x".repeat(1_100_000)}`;
			insert.run("ent-huge", huge, huge.toLowerCase(), now, now);
			for (let index = 0; index < 5_000; index += 1) {
				insert.run(`ent-normal-${index}`, `Normal Project ${index}`, `normal project ${index}`, now, now);
			}
			insert.run("ent-target", "Lanternfield", "lanternfield", now, now);
		});
		const owner = await getDbOwner(DB_PATH());
		const submit = owner.submit.bind(owner);
		let reads = 0;
		owner.submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
			if (options.operation === "user-prompt-submit.entity-names") reads += 1;
			return submit<Result>(request, options);
		};
		const matches = await matchPromptEntities(DB_PATH(), "default", "Where is Lanternfield now?").finally(() => {
			owner.submit = submit;
		});
		expect(matches.map((match) => match.entityName)).toEqual(["Lanternfield"]);
		expect(reads).toBeGreaterThanOrEqual(20);
		expect(reads).toBeLessThanOrEqual(22);
	});

	it("pages through agent-scoped index seeks without sorting or scanning other agents", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			const entity = db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', ?, 1, ?, ?)`,
			);
			const alias = db.prepare(
				`INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, status)
				 VALUES (?, ?, ?, ?, ?, 'active')`,
			);
			entity.run("ent-foreign", "Foreign Project", "foreign project", "other-agent", now, now);
			for (let index = 0; index < 20_000; index += 1) {
				alias.run(`alias-foreign-${index}`, "ent-foreign", "other-agent", `foreign${index}`, `foreign${index}`);
			}
			for (let index = 0; index < 600; index += 1) {
				entity.run(`ent-alias-${index}`, `Aliased Project ${index}`, `aliased project ${index}`, "default", now, now);
				alias.run(`alias-${index}`, `ent-alias-${index}`, "default", `harborlight${index}`, `harborlight${index}`);
			}
		});
		const owner = await getDbOwner(DB_PATH());
		const submit = owner.submit.bind(owner);
		const statements: Array<{ readonly operation: string; readonly sql: string; readonly params: readonly unknown[] }> =
			[];
		owner.submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
			if (/^user-prompt-submit\.entit(ies|y-names|y-aliases)$/.test(options.operation) && request.kind === "query") {
				statements.push({
					operation: options.operation,
					sql: request.statement.sql,
					params: request.statement.params ?? [],
				});
			}
			return submit<Result>(request, options);
		};
		const matches = await matchPromptEntities(DB_PATH(), "default", "What did harborlight599 ship?").finally(() => {
			owner.submit = submit;
		});
		expect(matches.map((match) => [match.entityName, match.matchSource])).toEqual([["Aliased Project 599", "alias"]]);
		const plans = getDbAccessor().withReadDb((db) =>
			statements.map((statement) =>
				db
					.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
					.all(...(statement.params as Array<string | number>))
					.map((row) => String((row as { detail: string }).detail)),
			),
		);
		for (const plan of plans) {
			expect(plan.filter((detail) => /SCAN|PRIMARY KEY|TEMP B-TREE/.test(detail))).toEqual([]);
			expect(plan.some((detail) => detail.includes("agent_id=?"))).toBe(true);
		}
		expect(statements.filter((statement) => statement.operation === "user-prompt-submit.entity-aliases").length).toBe(
			3,
		);
	});

	it("keeps paging aliases when the page boundary alias is replaced between pages", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			const entity = db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', 'default', 1, ?, ?)`,
			);
			const alias = db.prepare(
				`INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, status)
				 VALUES (?, ?, 'default', ?, ?, 'active')`,
			);
			for (let index = 0; index < 1_200; index += 1) {
				const key = `churnalias${String(index).padStart(4, "0")}`;
				entity.run(`ent-churn-${index}`, `Churn Project ${index}`, `churn project ${index}`, now, now);
				alias.run(`alias-churn-${index}`, `ent-churn-${index}`, key, key);
			}
			entity.run("ent-nightharbor", "Night Harbor", "night harbor", now, now);
			alias.run("alias-nightharbor", "ent-nightharbor", "nightharbor", "nightharbor");
		});
		const owner = await getDbOwner(DB_PATH());
		const submit = owner.submit.bind(owner);
		let pages = 0;
		owner.submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
			const handle = submit<Result>(request, options);
			if (options.operation !== "user-prompt-submit.entity-aliases") return handle;
			pages += 1;
			if (pages !== 1) return handle;
			return {
				...handle,
				result: handle.result.then((value) => {
					const rows = value as unknown as Array<{ readonly matched_text: string }>;
					const boundary = rows.at(-1)?.matched_text;
					getDbAccessor().withWriteTx((db) => {
						const row = db
							.prepare("SELECT rowid FROM entity_aliases WHERE agent_id = 'default' AND alias = ?")
							.get(boundary) as { rowid: number };
						db.prepare("DELETE FROM entity_aliases WHERE rowid = ?").run(row.rowid);
						db.prepare(
							`INSERT INTO entity_aliases (rowid, id, entity_id, agent_id, alias, canonical_alias, status)
							 VALUES (?, 'alias-replacement', 'ent-churn-0', 'default', 'zzzz replacement', 'zzzz replacement', 'active')`,
						).run(row.rowid);
					});
					return value;
				}),
			};
		};
		const matches = await matchPromptEntities(DB_PATH(), "default", "Is nightharbor still docked?").finally(() => {
			owner.submit = submit;
		});
		expect(matches.map((match) => [match.entityName, match.matchSource])).toEqual([["Night Harbor", "alias"]]);
		expect(pages).toBeGreaterThan(1);
	});

	it("keeps an entity's name and short aliases when it also has many long aliases", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('ent-quay', 'Lantern Quay', 'lantern quay', 'project', 'default', 1, ?, ?)`,
			).run(now, now);
			const alias = db.prepare(
				`INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, status)
				 VALUES (?, 'ent-quay', 'default', ?, ?, 'active')`,
			);
			for (let index = 0; index < 1_200; index += 1) {
				const text = `${index} ${"long alias words ".repeat(52)}`.trim();
				alias.run(`alias-long-${index}`, text, text.toLowerCase());
			}
			alias.run("alias-short", "quaylighthouse", "quaylighthouse");
			alias.run("alias-huge", "a".repeat(1_048_676), "a".repeat(1_048_676));
		});
		const byName = await matchPromptEntities(DB_PATH(), "default", "Is Lantern Quay open?");
		const byAlias = await matchPromptEntities(DB_PATH(), "default", "Is quaylighthouse open?");
		expect(byName.map((match) => [match.entityName, match.matchSource])).toEqual([["Lantern Quay", "name"]]);
		expect(byAlias.map((match) => [match.entityName, match.matchSource])).toEqual([["Lantern Quay", "alias"]]);
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
