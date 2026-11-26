import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { OrgDaemon } from "./daemon";
import { ensureCompartmentShards } from "../../../platform/core/src/compartment-shards";
import { findSqliteVecExtension } from "../../../platform/core/dist/index";
import { browser, record, request, success, text, type Credential } from "./http";

function parameter(value: unknown): string | number | null {
	if (typeof value === "string" || typeof value === "number" || value === null) return value;
	throw new Error("Invalid fixture parameter");
}

function seed(daemon: OrgDaemon, hidden: boolean): void {
	if (daemon.child) throw new Error("Offline fixture requires a stopped daemon");
	const db = new Database(join(daemon.workspace, "data/signet.db"));
	try {
		const extension = findSqliteVecExtension();
		if (!extension) throw new Error("fixture sqlite-vec unavailable");
		db.loadExtension(extension);
		const label = hidden ? 1 : null;
		const id = hidden ? "hidden" : "public";
		const now = hidden ? "2090-01-02T00:00:00.000Z" : "2090-01-01T00:00:00.000Z";
		db.transaction(() => {
			if (hidden) {
				db.exec(
					"INSERT INTO classifications(id,name) VALUES('cls_hr','HR'); INSERT INTO compartments(id,key) VALUES(1,'cls_hr'); INSERT INTO compartment_members VALUES(1,'cls_hr')",
				);
				ensureCompartmentShards(
					{
						exec: (sql) => db.exec(sql),
						prepare: (sql) => {
							const statement = db.prepare<Record<string, unknown>, (string | number | null)[]>(sql);
							return {
								run: (...args) => {
									statement.run(...args.map(parameter));
								},
								get: (...args) => statement.get(...args.map(parameter)) ?? undefined,
								all: (...args) => statement.all(...args.map(parameter)),
							};
						},
					},
					1,
					0,
				);
			}
			db.prepare(
				"INSERT INTO daily_reflections(id,agent_id,date,summary,patterns,memory_ids,summary_ids,created_at,compartment_id) VALUES(?,'default',? ,?,'[]','[]','[]',?,?)",
			).run(id, new Date().toISOString().slice(0, 10), `${id} reflection`, now, label);
			db.prepare(
				"INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at,compartment_id) VALUES(?,?,?,'project','default',?,?,?)",
			).run(`${id}-entity`, hidden ? "Signet hidden" : "Signet", hidden ? "signet hidden" : "signet", now, now, label);
			db.prepare(
				"INSERT INTO entity_aspects(id,entity_id,agent_id,name,canonical_name,created_at,updated_at,compartment_id) VALUES(?,?,'default','Details','details',?,?,?)",
			).run(`${id}-aspect`, `${id}-entity`, now, now, label);
			db.prepare(
				"INSERT INTO entity_attributes(id,aspect_id,agent_id,kind,content,normalized_content,status,created_at,updated_at,compartment_id) VALUES(?,?,'default','attribute',?,?,'active',?,?,?)",
			).run(`${id}-attribute`, "public-aspect", `${id} fact`, `${id} fact`, now, now, label);
			db.prepare(
				"INSERT INTO dreaming_passes(id,agent_id,mode,status,summary,tokens_consumed,completed_at,compartment_id) VALUES(?,'default','incremental','completed',?,?,?,?)",
			).run(`${id}-pass`, `${id} summary`, hidden ? 10000 : 1, now, label);
		})();
	} finally {
		db.close();
	}
}

async function mcp(daemon: OrgDaemon, credential: Credential, name: string, args: object): Promise<unknown> {
	const response = await request(daemon.origin, "/mcp", credential, "POST", {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name, arguments: args },
	});
	expect(response.status).toBe(200);
	const result = record(response.body).result;
	expect(record(result).isError).not.toBe(true);
	return result;
}

test("real organization reads and MCP preserve hidden-row noninterference across owner restarts", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const claim = await request(daemon.origin, "/api/org/claim", {}, "POST", {
			setupToken: await daemon.setupToken(),
			organizationName: "L3 read proof",
			admin: { username: "admin", displayName: "Admin", password: "disposable L3 read proof password" },
		});
		const claimed = success(claim, "claim L3 fixture");
		const admin = browser(claim);
		success(
			await request(daemon.origin, "/api/org/settings", admin, "PATCH", { agentModel: "single" }),
			"enable organization Dreaming store",
		);
		const userId = text(record(claimed.user).id);
		await daemon.stop();
		seed(daemon, false);
		await daemon.start();
		const paths = [
			"/api/reflections?limit=1",
			"/api/reflections/today?limit=1",
			"/api/knowledge/navigation/entities?limit=1",
			"/api/knowledge/navigation/tree?entity=Signet",
			"/api/knowledge/stats",
			"/api/knowledge/communities",
			"/api/dream/status",
		];
		const snapshot = async () => {
			const rows: unknown[] = [];
			for (const path of paths) {
				const reply = await request(daemon.origin, path, admin);
				expect(reply.status).toBe(200);
				rows.push(reply.body);
			}
			rows.push(await mcp(daemon, admin, "knowledge_list_entities", { limit: 1 }));
			rows.push(await mcp(daemon, admin, "knowledge_tree", { entity: "Signet" }));
			return JSON.stringify(rows);
		};
		const before = await snapshot();
		await daemon.stop();
		seed(daemon, true);
		await daemon.start();
		expect(await snapshot()).toBe(before);
		await daemon.stop();
		const db = new Database(join(daemon.workspace, "data/signet.db"));
		try {
			db.exec(
				"UPDATE daily_reflections SET summary='hidden edited' WHERE id='hidden'; UPDATE entities SET description='hidden edited' WHERE id='hidden-entity'; UPDATE entity_attributes SET content='hidden edited' WHERE id='hidden-attribute'; UPDATE dreaming_passes SET tokens_consumed=99999 WHERE id='hidden-pass'",
			);
		} finally {
			db.close();
		}
		await daemon.start();
		expect(await snapshot()).toBe(before);
		const hidden = await request(daemon.origin, "/api/knowledge/entities/hidden-entity", admin);
		const missing = await request(daemon.origin, "/api/knowledge/entities/missing-entity", admin);
		expect(hidden.status).toBe(404);
		expect(hidden.body).toEqual(missing.body);
		await daemon.stop();
		const audience = new Database(join(daemon.workspace, "data/signet.db"));
		try {
			audience.prepare("INSERT INTO classification_audience VALUES('cls_hr','user',?)").run(userId);
		} finally {
			audience.close();
		}
		await daemon.start();
		expect(
			JSON.stringify(success(await request(daemon.origin, "/api/reflections?limit=1", admin), "audience reflection")),
		).toContain("hidden edited");
		expect(
			JSON.stringify(await mcp(daemon, admin, "knowledge_list_entities", { query: "hidden", limit: 1 })),
		).toContain("hidden-entity");
	} finally {
		await daemon.dispose();
	}
}, 180_000);
