import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { compartmentFor } from "@signet/core";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor, initDbAccessorAsync } from "./db-accessor";
import type { DbOwnerJobHandle, DbOwnerRequest, DbOwnerSubmitOptions } from "./db-owner-client";
import { getDbOwner } from "./db-owner-runtime";
import { matchPromptEntities as providerMatchPromptEntities, promptPhraseSpan } from "./prompt-entity-context";

async function matchPromptEntities(path: string, agentId: string, prompt: string) {
	return providerMatchPromptEntities(path, agentId, prompt, undefined, {
		reach: { kind: "own", agentId },
		compartments: "all",
		projects: null,
	});
}

let dir = "";
let prev: string | undefined;

const DB_PATH = (): string => join(dir, "memory", "memories.db");

const localScope = (agentId: string): ReadScope => ({
	reach: { kind: "own", agentId },
	compartments: "all",
	projects: null,
});

const matchLocal = (agentId: string, message: string) =>
	matchPromptEntities(DB_PATH(), agentId, message, undefined, localScope(agentId));

function linkMentions(entityId: string, agentId: string, count: number, compartment: number | null = null): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		for (let index = 0; index < count; index += 1) {
			const memoryId = `mem-${entityId}-${compartment ?? "open"}-${index}`;
			db.prepare(
				`INSERT INTO memories (id, content, type, agent_id, compartment_id, is_deleted, created_at, updated_at, updated_by)
				 VALUES (?, ?, 'fact', ?, ?, 0, ?, ?, 'test')`,
			).run(memoryId, `about ${memoryId}`, agentId, compartment, now, now);
			db.prepare("INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES (?, ?)").run(memoryId, entityId);
		}
	});
}

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
	linkMentions("ent-nicholai", "default", 10);
	linkMentions("ent-signet", "default", 10);
	linkMentions("ent-other-agent", "other-agent", 10);
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

	it("reports the exact readable mention count beyond the former sampling cap", async () => {
		await getDbAccessor().withWriteTxAsync((db) =>
			db
				.prepare(
					"INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,mentions,created_at,updated_at) VALUES ('ent-bulk','Bulk Atlas','bulk atlas','project','default',0,'now','now')",
				)
				.run(),
		);
		linkMentions("ent-bulk", "default", 1201);
		const matches = await matchLocal("default", "Tell me about Bulk Atlas");
		expect(matches.find((match) => match.entityId === "ent-bulk")?.mentions).toBe(1201);
	});

	it("returns every directly named entity for the agent", async () => {
		const matches = await matchLocal("default", "Tell me about Nicholai and the Signet project");
		expect(matches.map((match) => match.entityName).sort()).toEqual(["Nicholai", "Signet"]);
	});

	it("resolves active aliases to the canonical entity", async () => {
		const matches = await matchLocal("default", "How is SignetAI doing?");
		expect(matches.map((match) => [match.entityName, match.matchSource])).toEqual([["Signet", "alias"]]);
	});

	it("scopes the entity scan by compartment, reach and project before matching", async () => {
		const now = new Date().toISOString();
		const hr = getDbAccessor().withWriteTx((db) => {
			db.prepare("INSERT INTO classifications (id, name, created_at, updated_at) VALUES ('cls_hr', 'HR', ?, ?)").run(
				now,
				now,
			);
			const compartment = compartmentFor(db, ["cls_hr"]) ?? 0;
			db.prepare(
				"INSERT OR IGNORE INTO agents (id, name, read_policy, created_at, updated_at) VALUES ('other-agent', 'other-agent', 'isolated', ?, ?)",
			).run(now, now);
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, compartment_id, created_at, updated_at)
				 VALUES ('ent-zephyr', 'Zephyr', 'zephyr', 'person', 'default', 10, ?, ?, ?)`,
			).run(compartment, now, now);
			db.prepare(
				`INSERT INTO entity_aliases
				 (id, entity_id, agent_id, alias, canonical_alias, confidence, source, status, created_at, updated_at)
				 VALUES ('alias-zeph', 'ent-zephyr', 'default', 'Zed Morrow', 'zed morrow', 1, 'test', 'active', ?, ?)`,
			).run(now, now);
			return compartment;
		});
		linkMentions("ent-zephyr", "default", 10);
		const outside: ReadScope = { reach: { kind: "own", agentId: "default" }, compartments: [], projects: null };
		const names = async (message: string, scope: ReadScope) =>
			(await matchPromptEntities(DB_PATH(), "default", message, undefined, scope)).map((match) => match.entityName);

		expect(await names("Tell me about Zephyr and Nicholai", outside)).toEqual(["Nicholai"]);
		expect(await names("What did Zed Morrow decide?", outside)).toEqual([]);
		expect(await names("Tell me about Zephyr", { ...outside, compartments: [hr] })).toEqual(["Zephyr"]);
		expect(await names("What did Zed Morrow decide?", { ...outside, compartments: [hr] })).toEqual(["Zephyr"]);
		expect(await names("What is Compass?", { ...outside, reach: { kind: "all" } })).toEqual(["Compass"]);
		expect(
			await names("What is Compass?", {
				reach: { kind: "shared", agentId: "default" },
				compartments: "all",
				projects: null,
			}),
		).toEqual([]);
		expect(await names("Tell me about Nicholai", { ...outside, projects: ["atlas"] })).toEqual([]);
	});

	it("keeps outsider matches byte-identical when hidden mentions bump the global counter", async () => {
		const now = new Date().toISOString();
		const hr = getDbAccessor().withWriteTx((db) => {
			db.prepare("INSERT INTO classifications (id, name, created_at, updated_at) VALUES ('cls_hr', 'HR', ?, ?)").run(
				now,
				now,
			);
			const compartment = compartmentFor(db, ["cls_hr"]) ?? 0;
			const entity = db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', 'default', 0, ?, ?)`,
			);
			entity.run("ent-atlas", "Atlas Deploy", "atlas deploy", now, now);
			entity.run("ent-deploybot", "Deploy Bot", "deploy bot", now, now);
			db.prepare(
				`INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, status)
				 VALUES ('alias-atlas-bot', 'ent-deploybot', 'default', 'Atlas Deploy', 'atlas deploy', 'active')`,
			).run();
			return compartment;
		});
		const hide = (memoryId: string, entityId: string): void => {
			getDbAccessor().withWriteTx((db) => {
				db.prepare(
					`INSERT INTO memories (id, content, type, agent_id, compartment_id, is_deleted, created_at, updated_at, updated_by)
					 VALUES (?, ?, 'fact', 'default', ?, 0, ?, ?, 'test')`,
				).run(memoryId, `hidden ${memoryId}`, hr, now, now);
				db.prepare("INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES (?, ?)").run(memoryId, entityId);
				db.prepare(
					"UPDATE entities SET mentions = (SELECT COUNT(*) FROM memory_entity_mentions WHERE entity_id = ?) WHERE id = ?",
				).run(entityId, entityId);
			});
		};
		const outsider: ReadScope = { reach: { kind: "own", agentId: "default" }, compartments: [], projects: null };
		const audience: ReadScope = { ...outsider, compartments: [hr] };
		const message = "What changed in Atlas Deploy?";
		const read = async (scope: ReadScope) => await matchPromptEntities(DB_PATH(), "default", message, undefined, scope);
		const before = JSON.stringify(await read(outsider));
		expect(JSON.parse(before)).toEqual([
			{
				entityId: "ent-atlas",
				entityName: "Atlas Deploy",
				entityType: "project",
				matchedText: "atlas deploy",
				matchSource: "name",
				mentions: 0,
			},
		]);
		hide("mem-hidden-atlas", "ent-atlas");
		expect(JSON.stringify(await read(outsider))).toBe(before);
		expect((await read(audience)).map((match) => [match.entityId, match.mentions])).toEqual([["ent-atlas", 1]]);
		hide("mem-hidden-bot-1", "ent-deploybot");
		hide("mem-hidden-bot-2", "ent-deploybot");
		expect(JSON.stringify(await read(outsider))).toBe(before);
		expect((await read(audience)).map((match) => [match.entityId, match.mentions, match.matchSource])).toEqual([
			["ent-deploybot", 2, "alias"],
		]);
	});

	it("uses the global mention counter only for reach all with every compartment", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET mentions = 25 WHERE id = 'ent-nicholai'").run();
		});
		const all: ReadScope = { reach: { kind: "all" }, compartments: "all", projects: null };
		const message = "Tell me about Nicholai";
		const counts = async (scope: ReadScope) =>
			(await matchPromptEntities(DB_PATH(), "default", message, undefined, scope)).map((match) => match.mentions);
		expect(await counts(all)).toEqual([25]);
		expect(await counts(localScope("default"))).toEqual([10]);
		expect(await counts({ ...all, compartments: [] })).toEqual([10]);
		expect(await counts({ ...all, projects: ["atlas"] })).toEqual([]);
	});

	it("counts readable mentions through the entity mention index", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (id, content, type, agent_id, is_deleted, created_at, updated_at, updated_by)
				 VALUES ('mem-nicholai', 'about nicholai', 'fact', 'default', 0, ?, ?, 'test')`,
			).run(now, now);
			db.prepare(
				"INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES ('mem-nicholai', 'ent-nicholai')",
			).run();
		});
		const owner = await getDbOwner(DB_PATH());
		const submit = owner.submit.bind(owner);
		const statements: Array<{ readonly sql: string; readonly params: readonly unknown[] }> = [];
		owner.submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
			if (options.operation === "user-prompt-submit.entity-mentions" && request.kind === "query") {
				statements.push({ sql: request.statement.sql, params: request.statement.params ?? [] });
			}
			return submit<Result>(request, options);
		};
		const matches = await matchLocal("default", "Tell me about Nicholai").finally(() => {
			owner.submit = submit;
		});
		expect(matches.map((match) => [match.entityName, match.mentions])).toEqual([["Nicholai", 11]]);
		expect(statements.length).toBe(1);
		const plan = getDbAccessor().withReadDb((db) =>
			statements.flatMap((statement) =>
				db
					.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
					.all(
						...statement.params.flatMap((param) =>
							typeof param === "string" || typeof param === "number" ? [param] : [],
						),
					)
					.flatMap((row) => (typeof row === "object" && row !== null && "detail" in row ? [String(row.detail)] : [])),
			),
		);
		expect(plan.some((detail) => detail.includes("idx_memory_entity_mentions_entity_memory"))).toBe(true);
		expect(plan.filter((detail) => /SCAN (memory_entity_mentions|memories|m|rm)\b/.test(detail))).toEqual([]);
	});

	it("rejects calls that omit the read scope", async () => {
		await expect(
			Reflect.apply(matchPromptEntities, undefined, [DB_PATH(), "default", "Tell me about Nicholai"]),
		).rejects.toThrow("readScope is required");
	});

	it("never matches another agent's entities", async () => {
		expect(await matchLocal("default", "What is Compass?")).toEqual([]);
		const other = await matchLocal("other-agent", "What is Compass?");
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
		linkMentions("ent-zephyr", "default", 1);
		const matches = await matchLocal("default", "What is the status of Zephyrline?");
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
		const matches = await matchLocal("default", "Is Quillonbridge shipping this week?");
		expect(matches.map((match) => match.entityName)).toEqual(["Quillonbridge"]);
		const longName = `Long Project 7 ${"descriptive words ".repeat(34)}`.trim();
		expect(await matchLocal("default", `What is ${longName}?`)).toEqual([]);
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
		const matches = await matchLocal("default", "Where is Lanternfield now?").finally(() => {
			owner.submit = submit;
		});
		expect(matches.map((match) => match.entityName)).toEqual(["Lanternfield"]);
		expect(reads).toBeGreaterThanOrEqual(40);
		expect(reads).toBeLessThanOrEqual(42);
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
		const matches = await matchLocal("default", "What did harborlight599 ship?").finally(() => {
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
			5,
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
		linkMentions("ent-nightharbor", "default", 1);
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
		const matches = await matchLocal("default", "Is nightharbor still docked?").finally(() => {
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
		const byName = await matchLocal("default", "Is Lantern Quay open?");
		const byAlias = await matchLocal("default", "Is quaylighthouse open?");
		expect(byName.map((match) => [match.entityName, match.matchSource])).toEqual([["Lantern Quay", "name"]]);
		expect(byAlias.map((match) => [match.entityName, match.matchSource])).toEqual([["Lantern Quay", "alias"]]);
	});

	it("keeps alias pages under the owner result limit when every text needs JSON escaping", async () => {
		const now = new Date().toISOString();
		const control = "\u0001".repeat(250);
		getDbAccessor().withWriteTx((db) => {
			const entity = db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', 'default', 1, ?, ?)`,
			);
			const alias = db.prepare(
				`INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, status)
				 VALUES (?, ?, 'default', ?, ?, 'active')`,
			);
			entity.run(`ent-${control}`, `Anchor${control}`, `anchor${control}`, now, now);
			for (let index = 0; index < 400; index += 1) {
				const text = `${String(index).padStart(3, "0")}${control}`;
				alias.run(`alias-escape-${index}`, `ent-${control}`, text, text);
			}
			entity.run("ent-saltmarsh", "Saltmarsh Project", "saltmarsh project", now, now);
			alias.run("alias-saltmarsh", "ent-saltmarsh", "saltmarshbeacon", "saltmarshbeacon");
		});
		const matches = await matchLocal("default", "Is saltmarshbeacon lit?");
		expect(matches.map((match) => [match.entityName, match.matchSource])).toEqual([["Saltmarsh Project", "alias"]]);
	});

	it("ignores entity and alias values stored as blobs", async () => {
		const now = new Date().toISOString();
		const blob = (seed: number): Uint8Array => new Uint8Array(256).fill(65 + (seed % 26));
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', 'default', 1, ?, ?)`,
			).run(blob(0), blob(1), blob(2), now, now);
			const alias = db.prepare(
				`INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, status)
				 VALUES (?, ?, 'default', ?, ?, 'active')`,
			);
			for (let index = 0; index < 160; index += 1) {
				const value = new Uint8Array(256).fill(65 + (index % 26));
				value[0] = index;
				alias.run(`alias-blob-${index}`, blob(0), value, value);
			}
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('ent-marrow', 'Marrow Project', 'marrow project', 'project', 'default', 1, ?, ?)`,
			).run(now, now);
			alias.run("alias-marrow", "ent-marrow", "marrowbeacon", "marrowbeacon");
		});
		linkMentions("ent-marrow", "default", 1);
		const matches = await matchLocal("default", "Is marrowbeacon lit?");
		expect(matches.map((match) => [match.entityName, match.matchSource])).toEqual([["Marrow Project", "alias"]]);
	});

	it("does not fail on oversized entity ids or non-numeric mention counts", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			const insert = db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', 'default', ?, ?, ?)`,
			);
			insert.run("x".repeat(1_100_000), "Anchor Point", "anchor point", 1, now, now);
			insert.run("ent-tidewater", "Tidewater", "tidewater", "9".repeat(1_100_000), now, now);
			insert.run("ent-kestrel", "Kestrelmoor", "kestrelmoor", 3, now, now);
		});
		linkMentions("ent-kestrel", "default", 3);
		linkMentions("ent-tidewater", "default", 2);
		const kestrel = await matchLocal("default", "Did Kestrelmoor ship?");
		const tidewater = await matchLocal("default", "Did Tidewater ship?");
		expect(kestrel.map((match) => match.entityName)).toEqual(["Kestrelmoor"]);
		expect(tidewater.map((match) => match.entityName)).toEqual(["Tidewater"]);
		const all: ReadScope = { reach: { kind: "all" }, compartments: "all", projects: null };
		const global = await matchPromptEntities(DB_PATH(), "default", "Did Tidewater ship?", undefined, all);
		expect(global.map((match) => match.entityName)).toEqual(["Tidewater"]);
	});

	it("still matches aliases when the active alias index is missing", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('ent-fen', 'Fen Project', 'fen project', 'project', 'default', 1, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, status)
				 VALUES ('alias-fen', 'ent-fen', 'default', 'fenlighthouse', 'fenlighthouse', 'active')`,
			).run();
			db.exec("DROP INDEX idx_entity_aliases_active_unique");
		});
		const matches = await matchLocal("default", "Is fenlighthouse open?");
		expect(matches.map((match) => [match.entityName, match.matchSource])).toEqual([["Fen Project", "alias"]]);
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
