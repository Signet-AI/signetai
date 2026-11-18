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

	it("shrinks oversized owner pages instead of failing on long entity names", async () => {
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

	it("pages entities with their aliases without a per-page sort", async () => {
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
			for (let index = 0; index < 2_500; index += 1) {
				entity.run(`ent-alias-${index}`, `Aliased Project ${index}`, `aliased project ${index}`, now, now);
				alias.run(`alias-${index}`, `ent-alias-${index}`, `harborlight${index}`, `harborlight${index}`);
			}
		});
		const owner = await getDbOwner(DB_PATH());
		const submit = owner.submit.bind(owner);
		const statements: Array<{ readonly sql: string; readonly params: readonly unknown[] }> = [];
		owner.submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
			if (options.operation === "user-prompt-submit.entities" && request.kind === "query") {
				statements.push({ sql: request.statement.sql, params: request.statement.params ?? [] });
			}
			return submit<Result>(request, options);
		};
		const matches = await matchPromptEntities(DB_PATH(), "default", "What did harborlight2499 ship?").finally(() => {
			owner.submit = submit;
		});
		expect(matches.map((match) => [match.entityName, match.matchSource])).toEqual([["Aliased Project 2499", "alias"]]);
		expect(statements.length).toBeGreaterThan(1);
		const statement = statements[0];
		if (!statement) throw new Error("Expected the entity page query");
		const plan = getDbAccessor().withReadDb((db) =>
			db
				.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
				.all(...(statement.params as Array<string | number>))
				.map((row) => String((row as { detail: string }).detail)),
		);
		expect(plan.some((detail) => detail.includes("TEMP B-TREE"))).toBe(false);
	});

	it("returns to full pages after skipping one oversized row", async () => {
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
			if (options.operation.startsWith("user-prompt-submit.entities")) reads += 1;
			return submit<Result>(request, options);
		};
		const matches = await matchPromptEntities(DB_PATH(), "default", "Where is Lanternfield now?").finally(() => {
			owner.submit = submit;
		});
		expect(matches.map((match) => match.entityName)).toEqual(["Lanternfield"]);
		expect(reads).toBeLessThan(40);
	});

	it("keeps paging when the page boundary entity is replaced between pages", async () => {
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
			for (let index = 0; index < 1_500; index += 1) {
				entity.run(`ent-churn-${index}`, `Churn Project ${index}`, `churn project ${index}`, now, now);
				alias.run(`alias-churn-${index}`, `ent-churn-${index}`, `churnalias${index}`, `churnalias${index}`);
			}
			entity.run("ent-nightharbor", "Night Harbor", "night harbor", now, now);
			alias.run("alias-nightharbor", "ent-nightharbor", "nightharbor", "nightharbor");
		});
		const owner = await getDbOwner(DB_PATH());
		const submit = owner.submit.bind(owner);
		let pages = 0;
		owner.submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
			const handle = submit<Result>(request, options);
			if (options.operation !== "user-prompt-submit.entities") return handle;
			pages += 1;
			if (pages !== 1) return handle;
			return {
				...handle,
				result: handle.result.then((value) => {
					const rows = value as unknown as Array<{ readonly cursor: number }>;
					const boundary = rows.at(-1)?.cursor;
					getDbAccessor().withWriteTx((db) => {
						const id = db.prepare("SELECT id FROM entities WHERE rowid = ?").get(boundary) as { id: string };
						db.prepare(
							"UPDATE entity_aliases SET alias = 'zzzz replacement', canonical_alias = 'zzzz replacement' WHERE entity_id = ?",
						).run(id.id);
						db.prepare("DELETE FROM entities WHERE rowid = ?").run(boundary);
						db.prepare(
							`INSERT INTO entities (rowid, id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
							 VALUES (?, 'ent-replacement', 'Zzzz Replacement', 'zzzz replacement', 'project', 'default', 1, datetime('now'), datetime('now'))`,
						).run(boundary);
					});
					return value;
				}),
			};
		};
		const matches = await matchPromptEntities(DB_PATH(), "default", "Is nightharbor still docked?").finally(() => {
			owner.submit = submit;
		});
		expect(pages).toBeGreaterThan(1);
		expect(matches.map((match) => [match.entityName, match.matchSource])).toEqual([["Night Harbor", "alias"]]);
	});

	it("does not scan other agents' aliases when paging", async () => {
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
			entity.run("ent-other", "Other Project", "other project", "other-agent", now, now);
			for (let index = 0; index < 20_000; index += 1) {
				alias.run(`alias-other-${index}`, "ent-other", "other-agent", `otheralias${index}`, `otheralias${index}`);
			}
			entity.run("ent-mine", "Lantern Quay", "lantern quay", "default", now, now);
			alias.run("alias-mine", "ent-mine", "default", "quaylighthouse", "quaylighthouse");
		});
		const owner = await getDbOwner(DB_PATH());
		const submit = owner.submit.bind(owner);
		const statements: Array<{ readonly sql: string; readonly params: readonly unknown[] }> = [];
		owner.submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
			if (/^user-prompt-submit\.entit(ies|y-names|y-aliases)$/.test(options.operation) && request.kind === "query") {
				statements.push({ sql: request.statement.sql, params: request.statement.params ?? [] });
			}
			return submit<Result>(request, options);
		};
		const matches = await matchPromptEntities(DB_PATH(), "default", "Is quaylighthouse still docked?").finally(() => {
			owner.submit = submit;
		});
		expect(matches.map((match) => [match.entityName, match.matchSource])).toEqual([["Lantern Quay", "alias"]]);
		expect(statements.length).toBeGreaterThan(0);
		const plans = getDbAccessor().withReadDb((db) =>
			statements.map((statement) =>
				db
					.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
					.all(...(statement.params as Array<string | number>))
					.map((row) => String((row as { detail: string }).detail)),
			),
		);
		for (const plan of plans) {
			expect(plan.filter((detail) => /SCAN|PRIMARY KEY/.test(detail))).toEqual([]);
			expect(plan.some((detail) => detail.includes("agent_id=?"))).toBe(true);
		}
	});

	it("skips an entity whose aliases alone exceed the owner result limit", async () => {
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
			entity.run("ent-huge-alias", "Huge Alias Owner", "huge alias owner", now, now);
			alias.run("alias-huge", "ent-huge-alias", "a".repeat(1_048_676), "a".repeat(1_048_676));
			entity.run("ent-beacon", "Beacon Project", "beacon project", now, now);
			alias.run("alias-beacon", "ent-beacon", "beaconharbor", "beaconharbor");
		});
		const matches = await matchPromptEntities(DB_PATH(), "default", "Has beaconharbor shipped?");
		expect(matches.map((match) => [match.entityName, match.matchSource])).toEqual([["Beacon Project", "alias"]]);
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
