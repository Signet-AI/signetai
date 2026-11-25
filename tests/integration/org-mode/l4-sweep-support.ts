import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findSqliteVecExtension } from "../../../platform/core/src/database";
import { compartmentForWrite } from "../../../platform/core/src/compartment-shards";
import { OrgDaemon } from "./daemon";
import { browser, id, record, request, success, text, type Credential, until } from "./http";

export class WriteSweep {
	readonly failures: string[] = [];
	readonly results: string[] = [];
	readonly embeddingServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ embedding: [1, ...Array.from({ length: 767 }, () => 0)], prompt_eval_count: 5 }),
	});
	get sourceId(): string {
		return `obsidian:${createHash("sha256").update(join(this.daemon.root, "vault")).digest("hex").slice(0, 16)}`;
	}
	async dispose(): Promise<void> {
		try {
			await this.daemon.dispose();
		} finally {
			this.embeddingServer.stop(true);
		}
	}
	constructor(
		readonly daemon: OrgDaemon,
		readonly credential: Credential,
		readonly userId: string,
		readonly agentId: string,
	) {}
	static async create(): Promise<WriteSweep> {
		const daemon = await OrgDaemon.create();
		try {
			const claim = await request(daemon.origin, "/api/org/claim", {}, "POST", {
				setupToken: await daemon.setupToken(),
				organizationName: "L4 sweep",
				admin: { username: "sweep", displayName: "Sweep", password: "isolated sweep password only" },
			});
			success(claim, "claim");
			const credential = browser(claim);
			const who = success(await request(daemon.origin, "/api/auth/whoami", credential), "whoami");
			const userId = id(who.user);
			const agentId = text(record(who.agents).defaultWrite);
			assert.notEqual(agentId, "default");
			return new WriteSweep(daemon, credential, userId, agentId);
		} catch (error) {
			await daemon.dispose();
			throw error;
		}
	}
	read<T>(read: (db: Database) => T): T {
		const db = new Database(join(this.daemon.workspace, "data/signet.db"), { readonly: true });
		const extension = findSqliteVecExtension();
		assert(extension);
		db.loadExtension(extension);
		try {
			return read(db);
		} finally {
			db.close();
		}
	}
	async seed(): Promise<void> {
		await this.daemon.stop();
		const db = new Database(join(this.daemon.workspace, "data/signet.db"));
		try {
			const extension = findSqliteVecExtension();
			assert(extension);
			db.loadExtension(extension);
			for (const suffix of ["agent", "session", "source"]) {
				db.query("INSERT INTO classifications(id,name) VALUES(?,?)").run(`cls_l4_${suffix}`, `L4 ${suffix}`);
				db.query("INSERT INTO classification_audience VALUES(?,'user',?)").run(`cls_l4_${suffix}`, this.userId);
				db.query("INSERT INTO classification_assignments VALUES(?,?,?,?,?,?)").run(
					suffix,
					suffix === "agent" ? this.agentId : suffix === "session" ? "l4-session" : this.sourceId,
					this.agentId,
					`cls_l4_${suffix}`,
					this.userId,
					new Date().toISOString(),
				);
			}
			db.query("INSERT INTO classifications(id,name) VALUES('cls_forbidden','Forbidden destination')").run();
			db.query(
				"INSERT INTO classification_assignments VALUES('session','forbidden-session',?,'cls_forbidden',?,'now')",
			).run(this.agentId, this.userId);
			db.query("INSERT INTO classification_assignments VALUES('source',?,?,'cls_forbidden',?,'now')").run(
				`obsidian:${createHash("sha256").update(join(this.daemon.root, "forbidden-vault")).digest("hex").slice(0, 16)}`,
				this.agentId,
				this.userId,
			);
			db.query("DELETE FROM embedding_index_state").run();
		} finally {
			db.close();
		}
		const configPath = join(this.daemon.workspace, "agent.yaml");
		const config = await readFile(configPath, "utf8");
		await writeFile(
			configPath,
			config
				.replace(
					"provider: none",
					`provider: ollama\n  model: l4-fixture\n  dimensions: 768\n  base_url: http://127.0.0.1:${this.embeddingServer.port}`,
				)
				.replace(
					"pipelineV2:\n    enabled: false",
					"pipelineV2:\n    enabled: true\n    telemetry:\n      retentionDays: 1\n    hints:\n      enabled: false\n    semanticContradictionEnabled: false",
				),
		);
		const { initDbAccessor, getDbAccessor, closeDbAccessor } = await import("../../../platform/daemon/src/db-accessor");
		initDbAccessor(join(this.daemon.workspace, "data/signet.db"), { agentsDir: this.daemon.workspace });
		try {
			await getDbAccessor().withWriteTxAsync((db) => {
				db.prepare("INSERT INTO classification_assignments VALUES('session','l4-stop',?,'cls_l4_session',?,?)").run(
					this.agentId,
					this.userId,
					new Date().toISOString(),
				);
				db.prepare("INSERT INTO classification_assignments VALUES('session','l4-shutdown',?,'cls_l4_session',?,?)").run(
					this.agentId,
					this.userId,
					new Date().toISOString(),
				);
				const agentCompartment = compartmentForWrite(db, { agentId: this.agentId });
				db.prepare(
					"INSERT INTO memories(id,agent_id,author_user_id,content,created_at,updated_at,compartment_id) VALUES('l4-retention-parent',?,?,'Telemetry evidence','now','now',?)",
				).run(this.agentId, this.userId, agentCompartment);
				db.prepare(
					"INSERT INTO session_recall_events(session_key,agent_id,context_epoch,item_kind,item_id,surface,mode,created_at,compartment_id) VALUES('l4-expired-telemetry',?,0,'memory','l4-retention-parent','hook','automatic',?,?)",
				).run(this.agentId, new Date(Date.now() - 10 * 86400000).toISOString(), agentCompartment);
				db.prepare("INSERT INTO evidence_citations VALUES('telemetry',?,?, 'memory','l4-retention-parent')").run(
					JSON.stringify(["l4-expired-telemetry", 0, "memory", "l4-retention-parent"]),
					this.agentId,
				);
				const compartment = compartmentForWrite(db, { agentId: this.agentId, sessionKey: "l4-session" });
				db.prepare(
					"INSERT INTO daily_reflections(id,agent_id,date,summary,question,created_at,compartment_id) VALUES('l4-reflection',?,'2026-11-25','Evidence review','What changed?',?,?)",
				).run(this.agentId, new Date().toISOString(), compartment);
			});
		} finally {
			await closeDbAccessor();
		}

		await this.daemon.start();
		await until(
			async () => /document-worker.*Worker started/.test(this.daemon.stdout + this.daemon.stderr),
			"document worker readiness",
			60_000,
		);
	}
	async post(path: string, body: object): Promise<Record<string, unknown>> {
		const reply = await request(
			this.daemon.origin,
			path,
			this.credential,
			"POST",
			body,
			"sessionKey" in body && typeof body.sessionKey === "string" ? { "x-signet-session-key": body.sessionKey } : {},
		);
		assert(reply.status >= 200 && reply.status < 300, `${path}: ${reply.status} ${JSON.stringify(reply.body)}`);
		return record(reply.body);
	}
	async check(name: string, run: () => Promise<void>): Promise<void> {
		try {
			await run();
			this.results.push(name);
			console.log(JSON.stringify({ surface: name, outcome: "pass" }));
		} catch (error) {
			this.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
			console.log(JSON.stringify({ surface: name, outcome: "fail", error: this.failures.at(-1) }));
		}
	}
	assertRows(table: string, where: string, params: string[], labels: string[], authorColumn?: string): number {
		assert(/^[a-z_]+$/.test(table));
		return this.read((db) => {
			const rows = db
				.query<Record<string, unknown>, string[]>(`SELECT rowid,* FROM ${table} WHERE ${where}`)
				.all(...params);
			assert(rows.length > 0, `${table}: no durable evidence rows`);
			for (const row of rows) {
				assert.equal(
					table === "cross_agent_messages" ? row.from_agent_id : row.agent_id,
					this.agentId,
					`${table}: wrong agent`,
				);
				if (authorColumn) assert.equal(row[authorColumn], this.userId, `${table}: wrong principal author`);
				assert.equal(typeof row.compartment_id, "number", `${table}: unclassified row`);
				const actual = db
					.query<{ classification_id: string }, [number]>(
						"SELECT classification_id FROM compartment_members WHERE compartment_id=? ORDER BY classification_id",
					)
					.all(Number(row.compartment_id))
					.map((entry) => entry.classification_id);
				assert.deepEqual(actual, [...labels].sort(), `${table}: wrong compartment union`);
				const fts =
					table === "session_transcripts"
						? "session_transcripts_fts"
						: table === "memory_artifacts"
							? "memory_artifacts_fts"
							: null;
				if (fts) {
					assert.equal(
						db.query(`SELECT rowid FROM ${fts} WHERE ${fts} MATCH 'L4' AND rowid=?`).get(Number(row.rowid)),
						null,
						`${table}: classified evidence in base FTS`,
					);
					const shard = `${fts}__c${Number(row.compartment_id)}`;
					assert(
						db.query(`SELECT rowid FROM ${shard} WHERE ${shard} MATCH 'L4' AND rowid=?`).get(Number(row.rowid)),
						`${table}: evidence missing from shard`,
					);
				}
			}
			return rows.length;
		});
	}
	assertAllChildren(): void {
		this.read((db) => {
			let checked = 0;
			for (const table of ["memory_hints", "embeddings", "embeddings_staging"]) {
				const rows = db
					.query<Record<string, unknown>, [string]>(`SELECT rowid,* FROM ${table} WHERE agent_id=?`)
					.all(this.agentId);
				for (const row of rows) {
					const sourceId = text(table === "memory_hints" ? row.memory_id : row.source_id);
					let parent: Record<string, unknown> | null = null;
					for (const [parentTable, key] of [
						["memories", "id"],
						["memory_artifacts", "source_path"],
						["session_transcripts", "session_key"],
						["entities", "id"],
					]) {
						const candidate = db
							.query<Record<string, unknown>, [string, string]>(
								`SELECT compartment_id FROM ${parentTable} WHERE agent_id=? AND ${key}=?`,
							)
							.get(this.agentId, sourceId);
						if (candidate) {
							parent = candidate;
							break;
						}
					}
					if (!parent && ["source_chunk", "obsidian_chunk"].includes(text(row.source_type))) {
						parent = db
							.query<Record<string, unknown>, [string, string]>(
								"SELECT compartment_id FROM memory_artifacts WHERE agent_id=? AND substr(?,1,length(source_id||':'||source_external_id)+1)=source_id||':'||source_external_id||'#'",
							)
							.get(this.agentId, sourceId);
					}
					assert(parent, `${table}: orphan child ${sourceId}`);
					assert.equal(typeof parent.compartment_id, "number");
					assert.equal(row.compartment_id, parent.compartment_id, `${table}: child failed to inherit parent label`);
					const compartment = Number(parent.compartment_id);
					if (table === "memory_hints") {
						assert.equal(
							db
								.query("SELECT rowid FROM memory_hints_fts WHERE memory_hints_fts MATCH 'L4' AND rowid=?")
								.get(Number(row.rowid)),
							null,
						);
						assert(
							db
								.query(
									`SELECT rowid FROM memory_hints_fts__c${compartment} WHERE memory_hints_fts__c${compartment} MATCH 'L4' AND rowid=?`,
								)
								.get(Number(row.rowid)),
						);
					} else {
						const base = table === "embeddings" ? "vec_embeddings" : "vec_embeddings_staging";
						assert.equal(
							db.query(`SELECT id FROM ${base} WHERE id=?`).get(text(row.id)),
							null,
							`${table}: child leaked into base vector index`,
						);
						assert(
							db.query(`SELECT id FROM ${base}__c${compartment} WHERE id=?`).get(text(row.id)),
							`${table}: child absent from vector shard`,
						);
					}
					checked++;
				}
			}
			assert(checked >= 8, "child audit requires real persisted hints and vectors");
			console.log(JSON.stringify({ childRowsChecked: checked }));
		});
	}

	assertMemory(memoryId: string, labels: string[], requireChildren = false): void {
		this.assertRows("memories", "id=?", [memoryId], labels, "author_user_id");
		this.read((db) => {
			const memory = db
				.query<{ rowid: number; compartment_id: number }, [string]>(
					"SELECT rowid,compartment_id FROM memories WHERE id=?",
				)
				.get(memoryId);
			assert(memory);
			assert.equal(
				db.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'L4' AND rowid=?").get(memory.rowid),
				null,
				"classified memory in base FTS",
			);
			assert(
				db
					.query(
						`SELECT rowid FROM memories_fts__c${memory.compartment_id} WHERE memories_fts__c${memory.compartment_id} MATCH 'L4' AND rowid=?`,
					)
					.get(memory.rowid),
				"memory absent from compartment FTS",
			);
			for (const table of ["memory_hints", "embeddings", "embeddings_staging"]) {
				const parentKey = table === "memory_hints" ? "memory_id" : "source_id";
				const children = db
					.query<Record<string, unknown>, [string]>(`SELECT rowid,* FROM ${table} WHERE ${parentKey}=?`)
					.all(memoryId);
				if (requireChildren && table !== "embeddings_staging")
					assert(children.length > 0, `${table}: expected real child rows`);
				for (const child of children) {
					assert.equal(child.agent_id, this.agentId);
					assert.equal(child.compartment_id, memory.compartment_id, `${table}: child label`);
					if (table === "memory_hints") {
						assert.equal(
							db
								.query("SELECT rowid FROM memory_hints_fts WHERE memory_hints_fts MATCH 'L4' AND rowid=?")
								.get(Number(child.rowid)),
							null,
						);
						assert(
							db
								.query(
									`SELECT rowid FROM memory_hints_fts__c${memory.compartment_id} WHERE memory_hints_fts__c${memory.compartment_id} MATCH 'L4' AND rowid=?`,
								)
								.get(Number(child.rowid)),
						);
					} else {
						const base = table === "embeddings" ? "vec_embeddings" : "vec_embeddings_staging";
						const childId = text(child.id);
						assert.equal(db.query(`SELECT id FROM ${base} WHERE id=?`).get(childId), null);
						assert(db.query(`SELECT id FROM ${base}__c${memory.compartment_id} WHERE id=?`).get(childId));
					}
				}
			}
		});
	}
}
