import { createMemoriesFts } from "../fts-schema";
import { rebuildBaseCompartmentFts } from "../compartment-shards";
import type { MigrationDb } from "./contract";

export const COMPARTMENT_TABLES = [
	"memories",
	"embeddings",
	"embeddings_staging",
	"memory_hints",
	"memory_artifacts",
	"session_transcripts",
	"session_summaries",
	"session_checkpoints",
	"documents",
	"entities",
	"entity_aspects",
	"entity_attributes",
	"entity_dependencies",
	"epistemic_assertions",
	"ontology_proposals",
	"ontology_contradictions",
	"entity_communities",
	"temporal_edges",
	"daily_reflections",
	"dreaming_passes",
	"dreaming_tool_calls",
	"dreaming_history_nodes",
	"dreaming_attention",
	"memory_head_entries",
	"memory_head_revision_entries",
	"memory_search_telemetry",
	"session_recall_events",
	"cross_agent_messages",
] as const;
function exists(db: MigrationDb, table: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) != null;
}
function citation(db: MigrationDb, agent: string, row: Record<string, unknown>): { kind: string; id: string } | null {
	const ref = typeof row.ref === "string" ? row.ref.trim() : "";
	const match = /^(memory|transcript|artifact|summary):(.+)$/.exec(ref);
	if (match?.[1] && match[2]) return { kind: match[1], id: match[2] };
	if (typeof row.memory_id === "string" && row.memory_id.trim()) return { kind: "memory", id: row.memory_id.trim() };
	const sourceId = typeof row.source_id === "string" ? row.source_id.trim() : "";
	const sourcePath = typeof row.source_path === "string" ? row.source_path.trim() : "";
	const kind = row.source_kind;

	if (sourcePath) return { kind: "artifact", id: sourcePath };
	const candidates = [sourceId, ref].flatMap((value) =>
		value
			? [
					value,
					value.replace(/^transcript:/, ""),
					value.replace(/^session:/, ""),
					`transcript:${value}`,
					`session:${value}`,
				]
			: [],
	);
	for (const value of candidates) {
		const transcript = exists(db, "session_transcripts")
			? db.prepare("SELECT session_key FROM session_transcripts WHERE agent_id=? AND session_key=?").get(agent, value)
			: undefined;
		if (typeof transcript?.session_key === "string") return { kind: "transcript", id: transcript.session_key };
		const artifact = exists(db, "memory_artifacts")
			? db
					.prepare(
						"SELECT source_path FROM memory_artifacts WHERE agent_id=? AND (source_path=? OR source_node_id=? OR session_id=? OR session_key=? OR session_token=?) ORDER BY captured_at DESC LIMIT 1",
					)
					.get(agent, value, value, value, value, value)
			: undefined;
		if (typeof artifact?.source_path === "string") return { kind: "artifact", id: artifact.source_path };
		for (const [table, key, kind] of [
			["memories", "id", "memory"],
			["session_summaries", "id", "summary"],
		]) {
			if (
				table &&
				key &&
				kind &&
				exists(db, table) &&
				db.prepare(`SELECT 1 FROM ${table} WHERE agent_id=? AND ${key}=?`).get(agent, value)
			)
				return { kind, id: value };
		}
	}
	if (typeof kind === "string" && ["memory", "transcript", "artifact", "summary"].includes(kind) && sourceId)
		return { kind, id: sourceId };
	return null;
}
export function backfillEvidenceCitations(db: MigrationDb): void {
	for (const [table, kind] of [
		["entity_attributes", "attribute"],
		["entity_dependencies", "dependency"],
		["entities", "entity"],
		["entity_aspects", "aspect"],
	]) {
		if (!table || !kind || !exists(db, table)) continue;
		if (
			!db
				.prepare(`PRAGMA table_info(${table})`)
				.all()
				.some((r) => r.name === "proposal_evidence")
		)
			continue;
		const rows = db
			.prepare(`SELECT t.id,t.agent_id,
   CASE WHEN j.type='text' THEN j.value ELSE json_extract(j.value,'$.source_ref') END ref,
   CASE WHEN j.type='object' THEN json_extract(j.value,'$.memory_id') END memory_id,
   CASE WHEN j.type='object' THEN COALESCE(json_extract(j.value,'$.source_kind'),CASE WHEN COALESCE(json_extract(j.value,'$.transcript_id'),json_extract(j.value,'$.session_key')) IS NOT NULL THEN 'transcript' END) END source_kind,
   CASE WHEN j.type='object' THEN COALESCE(json_extract(j.value,'$.source_id'),json_extract(j.value,'$.transcript_id'),json_extract(j.value,'$.session_key'),json_extract(j.value,'$.session_id'),json_extract(j.value,'$.source')) END source_id,
   CASE WHEN j.type='object' THEN json_extract(j.value,'$.source_path') END source_path
   FROM ${table} t,json_each(CASE WHEN json_valid(t.proposal_evidence) THEN CASE WHEN json_type(t.proposal_evidence)='array' THEN t.proposal_evidence ELSE '[]' END ELSE '[]' END) j WHERE j.type IN ('object','text')`)
			.all();
		for (const row of rows) {
			if (typeof row.agent_id !== "string" || typeof row.id !== "string") continue;
			const ref = citation(db, row.agent_id, row);
			if (ref)
				db.prepare(
					"INSERT OR IGNORE INTO evidence_citations(derived_kind,derived_id,agent_id,evidence_kind,evidence_id) VALUES (?,?,?,?,?)",
				).run(kind, row.id, row.agent_id, ref.kind, ref.id);
		}
	}
	for (const [table, id, kind, source] of [
		["derived_memory_sources", "derived_memory_id", "source_kind", "source_id"],
		["aggregate_memory_sources", "aggregate_memory_id", "'memory'", "source_memory_id"],
		["aggregate_evidence_sources", "aggregate_memory_id", "source_kind", "source_id"],
	]) {
		if (table && exists(db, table))
			db.exec(
				`INSERT OR IGNORE INTO evidence_citations(derived_kind,derived_id,agent_id,evidence_kind,evidence_id) SELECT 'memory',${id},agent_id,${kind},${source} FROM ${table} WHERE ${kind} IN ('memory','transcript','artifact','summary') AND typeof(${source})='text' AND length(${source})>0`,
			);
	}
}
export function installWriteGuards(db: MigrationDb): void {
	for (const table of [
		"cross_agent_messages",
		"memories",
		"memory_artifacts",
		"session_transcripts",
		"session_summaries",
		"session_checkpoints",
		"documents",
		"memory_hints",
		"embeddings",
		"embeddings_staging",
	]) {
		if (!exists(db, table)) continue;
		const columns = new Set(
			db
				.prepare(`PRAGMA table_info(${table})`)
				.all()
				.map((row) => row.name),
		);
		const ownerColumn = table === "cross_agent_messages" ? "from_agent_id" : "agent_id";
		if (!columns.has(ownerColumn)) continue;
		const sessions = ["session_key", "session_id", "from_session_key"]
			.filter((column) => columns.has(column))
			.map((column) => `new.${column}`);
		const sources = ["source_id", "source_ref"]
			.filter((column) => columns.has(column))
			.map((column) => `new.${column}`);
		if (table === "memories" && columns.has("source_id")) sessions.push("new.source_id");
		const memory =
			table === "memories"
				? "new.id"
				: table === "memory_hints"
					? "new.memory_id"
					: table.startsWith("embeddings")
						? "CASE WHEN new.source_type='memory' THEN new.source_id END"
						: "NULL";
		const agent = table.startsWith("embeddings")
			? `COALESCE(new.agent_id,(SELECT agent_id FROM memories WHERE id=${memory}))`
			: `new.${ownerColumn}`;
		const lookup = (kind: string, targets: string, owner = agent) =>
			`SELECT a.classification_id FROM classification_assignments a WHERE a.agent_id=${owner} AND a.target_kind='${kind}' AND a.target_id IN (${targets})`;
		const sessionTargets = (session: string) =>
			`${session},'session:'||${session},CASE WHEN substr(${session},1,8)='session:' THEN substr(${session},9) END`;
		const sourceTargets = (source: string) =>
			`WITH RECURSIVE positions(pos) AS (SELECT instr(${source},':') UNION ALL SELECT pos+instr(substr(${source},pos+1),':') FROM positions WHERE pos>0 AND instr(substr(${source},pos+1),':')>0) SELECT ${source} UNION SELECT substr(${source},1,pos-1) FROM positions WHERE pos>0`;
		const required = [
			lookup("agent", agent),
			lookup("memory", memory),
			...sessions.map((session) => lookup("session", sessionTargets(session))),
			...sources.map((source) => lookup("source", sourceTargets(source))),
		];
		if (table === "session_checkpoints") {
			const owners =
				"SELECT agent_id FROM session_transcripts WHERE session_key=new.session_key UNION SELECT agent_id FROM session_claims WHERE session_key=new.session_key";
			for (const [kind, targets] of [
				["agent", "o.agent_id"],
				["session", sessionTargets("new.session_key")],
			] as const)
				required.push(
					`SELECT a.classification_id FROM (${owners}) o JOIN classification_assignments a ON a.agent_id=o.agent_id AND a.target_kind='${kind}' AND a.target_id IN (${targets}) WHERE new.agent_id IS NULL`,
				);
			required.push(
				"SELECT a.classification_id FROM session_transcripts t JOIN classification_assignments a ON a.agent_id=t.agent_id AND a.target_kind='source' AND a.target_id=t.source_id WHERE new.agent_id IS NULL AND t.session_key=new.session_key",
			);
		}
		if (table === "memory_hints" || table.startsWith("embeddings"))
			required.push(
				`SELECT cm.classification_id FROM memories p JOIN compartment_members cm ON cm.compartment_id=p.compartment_id WHERE p.id=${memory} AND (new.agent_id IS NULL OR p.agent_id=new.agent_id)`,
			);
		const scopeColumns = [
			"compartment_id",
			"from_agent_id",
			"from_session_key",
			"agent_id",
			"session_key",
			"session_id",
			"source_id",
			"source_ref",
			"source_type",
			"memory_id",
			"id",
		].filter((column) => columns.has(column));
		for (const event of ["INSERT", "UPDATE"]) {
			const update = event === "UPDATE" ? ` OF ${scopeColumns.join(",")}` : "";
			const changed =
				event === "UPDATE"
					? ` WHEN ${scopeColumns.map((column) => `old.${column} IS NOT new.${column}`).join(" OR ")}`
					: "";
			db.exec(
				`DROP TRIGGER IF EXISTS ${table}_compartment_${event.toLowerCase()};CREATE TRIGGER ${table}_compartment_${event.toLowerCase()} BEFORE ${event}${update} ON ${table}${changed} BEGIN ${table === "session_checkpoints" && event === "INSERT" ? "SELECT RAISE(ABORT,'agent_required') WHERE new.agent_id IS NULL;" : ""} SELECT RAISE(ABORT,'compartment_required') WHERE EXISTS(SELECT 1 FROM (${required.join(" UNION ")}) required WHERE NOT EXISTS(SELECT 1 FROM compartment_members cm WHERE cm.compartment_id=new.compartment_id AND cm.classification_id=required.classification_id));END`,
			);
		}
	}
}
export function up(db: MigrationDb): void {
	const legacyCitations = db.prepare("SELECT sql FROM sqlite_master WHERE name='evidence_citations'").get();
	const upgradeCitations = typeof legacyCitations?.sql === "string" && !legacyCitations.sql.includes("'contradiction'");
	if (upgradeCitations) db.exec("ALTER TABLE evidence_citations RENAME TO evidence_citations_177_legacy");
	if (
		exists(db, "session_checkpoints") &&
		!db.prepare("SELECT 1 FROM pragma_table_info('session_checkpoints') WHERE name='agent_id'").get()
	) {
		db.exec("ALTER TABLE session_checkpoints ADD COLUMN agent_id TEXT");
		const owners = [
			exists(db, "session_transcripts")
				? "SELECT session_key,agent_id FROM session_transcripts WHERE agent_id IS NOT NULL"
				: null,
			exists(db, "session_claims")
				? "SELECT session_key,agent_id FROM session_claims WHERE agent_id IS NOT NULL"
				: null,
		].filter((v) => v !== null);
		if (owners.length)
			db.exec(
				`WITH owners AS (${owners.join(" UNION ")}) UPDATE session_checkpoints SET agent_id=(SELECT MIN(agent_id) FROM owners WHERE owners.session_key=session_checkpoints.session_key) WHERE (SELECT COUNT(DISTINCT agent_id) FROM owners WHERE owners.session_key=session_checkpoints.session_key)=1`,
			);
		db.exec("DROP INDEX IF EXISTS idx_session_checkpoints_compartment");
	}
	db.exec(`
 CREATE TABLE IF NOT EXISTS classifications(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,color TEXT,description TEXT,created_by TEXT,created_at TEXT,updated_at TEXT,archived_at TEXT);
 CREATE TABLE IF NOT EXISTS classification_audience(classification_id TEXT NOT NULL REFERENCES classifications(id) ON DELETE CASCADE,principal_kind TEXT NOT NULL CHECK(principal_kind IN ('user','group')),principal_id TEXT NOT NULL,PRIMARY KEY(classification_id,principal_kind,principal_id));
 CREATE TABLE IF NOT EXISTS classification_appliers(classification_id TEXT NOT NULL REFERENCES classifications(id) ON DELETE CASCADE,principal_kind TEXT NOT NULL CHECK(principal_kind IN ('user','group')),principal_id TEXT NOT NULL,PRIMARY KEY(classification_id,principal_kind,principal_id));
 CREATE TABLE IF NOT EXISTS compartments(id INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT UNIQUE NOT NULL,created_at TEXT);
 CREATE TABLE IF NOT EXISTS compartment_members(compartment_id INTEGER NOT NULL REFERENCES compartments(id),classification_id TEXT NOT NULL REFERENCES classifications(id),PRIMARY KEY(compartment_id,classification_id));
 CREATE TABLE IF NOT EXISTS classification_assignments(target_kind TEXT NOT NULL CHECK(target_kind IN ('memory','session','source','agent')),target_id TEXT NOT NULL,agent_id TEXT NOT NULL,classification_id TEXT NOT NULL REFERENCES classifications(id),applied_by TEXT,applied_at TEXT,PRIMARY KEY(target_kind,target_id,agent_id,classification_id));
 CREATE INDEX IF NOT EXISTS idx_classification_assignments_agent ON classification_assignments(agent_id,target_kind,target_id);
 CREATE TABLE IF NOT EXISTS evidence_citations(derived_kind TEXT NOT NULL CHECK(derived_kind IN ('attribute','memory','dependency','entity','aspect','assertion','head_entry','reflection','contradiction','head_revision','proposal','telemetry')),derived_id TEXT NOT NULL,agent_id TEXT NOT NULL,evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('memory','transcript','artifact','summary','attribute')),evidence_id TEXT NOT NULL,PRIMARY KEY(derived_kind,derived_id,evidence_kind,evidence_id));
 CREATE INDEX IF NOT EXISTS idx_evidence_citations_source ON evidence_citations(agent_id,evidence_kind,evidence_id);
 CREATE TABLE IF NOT EXISTS classification_access_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
 INSERT OR IGNORE INTO classification_access_version VALUES(1,0);
 `);
	if (upgradeCitations)
		db.exec(
			"INSERT INTO evidence_citations SELECT * FROM evidence_citations_177_legacy;DROP TABLE evidence_citations_177_legacy;CREATE INDEX IF NOT EXISTS idx_evidence_citations_source ON evidence_citations(agent_id,evidence_kind,evidence_id)",
		);
	for (const table of COMPARTMENT_TABLES) {
		if (!exists(db, table)) continue;
		const columns = db.prepare(`PRAGMA table_info(${table})`).all();
		if (!columns.some((r) => r.name === "compartment_id"))
			db.exec(`ALTER TABLE ${table} ADD COLUMN compartment_id INTEGER REFERENCES compartments(id)`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_${table}_compartment ON ${table}(${columns.some((r) => r.name === "agent_id") ? "agent_id," : ""}compartment_id)`,
		);
	}
	for (const table of [
		"classification_audience",
		"classification_appliers",
		"classifications",
		"compartment_members",
		"group_members",
		"users",
		"groups",
	]) {
		if (!exists(db, table)) continue;
		for (const event of table === "users" ? ["INSERT", "DELETE"] : ["INSERT", "UPDATE", "DELETE"])
			db.exec(
				`CREATE TRIGGER IF NOT EXISTS ${table}_classification_access_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE classification_access_version SET version=version+1 WHERE id=1; END`,
			);
	}
	if (exists(db, "users"))
		db.exec(
			`DROP TRIGGER IF EXISTS users_classification_access_update;CREATE TRIGGER users_classification_access_update AFTER UPDATE OF role,status,compliance ON users WHEN old.role IS NOT new.role OR old.status IS NOT new.status OR old.compliance IS NOT new.compliance BEGIN UPDATE classification_access_version SET version=version+1 WHERE id=1; END`,
		);
	for (const store of ["embeddings", "embeddings_staging"])
		if (
			exists(db, store) &&
			!db.prepare(`SELECT 1 FROM pragma_table_info('${store}') WHERE name='projection_compartment_id'`).get()
		)
			db.exec(
				`ALTER TABLE ${store} ADD COLUMN projection_compartment_id INTEGER;UPDATE ${store} SET projection_compartment_id=compartment_id`,
			);
	if (exists(db, "org_jobs"))
		db.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_job_agent ON org_jobs(CASE WHEN json_valid(params_json) THEN json_extract(params_json,'$.target.agentId') END) WHERE status='running' AND kind IN ('classify','unclassify')",
		);
	if (exists(db, "memory_head_revision_entries"))
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_head_revision_citation ON memory_head_revision_entries(agent_id,json_array(revision,entry_id))",
		);
	if (exists(db, "session_recall_events"))
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_session_recall_citation ON session_recall_events(agent_id,json_array(session_key,context_epoch,item_kind,item_id))",
		);
	for (const [table, kind, key] of [
		["memories", "memory", "id"],
		["session_transcripts", "session", "session_key"],
	] as const)
		if (exists(db, table))
			db.exec(
				`CREATE TRIGGER IF NOT EXISTS ${table}_classification_cascade AFTER DELETE ON ${table} BEGIN DELETE FROM classification_assignments WHERE target_kind='${kind}' AND target_id=old.${key} AND agent_id=old.agent_id;END`,
			);
	if (exists(db, "org_jobs"))
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_classification_visibility ON org_jobs(kind,status) WHERE kind='classify' AND status IN ('pending','running','failed')",
		);
	installEvidencePurgeLifecycle(db);
	installWriteGuards(db);
	backfillEvidenceCitations(db);
	rebuildBaseCompartmentFts(db);
	if (exists(db, "memories_fts")) createMemoriesFts(db);
}

export function configureEvidencePurgeConnection(db: MigrationDb): void {
	db.exec("PRAGMA recursive_triggers=ON");
}

export function installEvidencePurgeLifecycle(db: MigrationDb): void {
	configureEvidencePurgeConnection(db);
	const derived = [
		["entity", "entities", "id"],
		["attribute", "entity_attributes", "id"],
		["dependency", "entity_dependencies", "id"],
		["aspect", "entity_aspects", "id"],
		["assertion", "epistemic_assertions", "id"],
		["memory", "memories", "id"],
		["reflection", "daily_reflections", "id"],
		["proposal", "ontology_proposals", "id"],
		["contradiction", "ontology_contradictions", "id"],
		["community", "entity_communities", "id"],
		["head_entry", "memory_head_entries", "entry_id"],
		["head_revision", "memory_head_revision_entries", "json_array(revision,entry_id)"],
		["telemetry", "memory_search_telemetry", "id"],
		["telemetry", "session_recall_events", "json_array(session_key,context_epoch,item_kind,item_id)"],
	] as const;
	for (const [table, kind, key] of [
		["memories", "memory", "id"],
		["session_transcripts", "transcript", "session_key"],
		["memory_artifacts", "artifact", "source_path"],
		["session_summaries", "summary", "id"],
		["entity_attributes", "attribute", "id"],
	] as const) {
		if (!exists(db, table)) continue;
		const affected = `SELECT derived_kind,derived_id FROM evidence_citations WHERE agent_id=old.agent_id AND evidence_kind='${kind}' AND evidence_id=old.${key}`;
		const deletes = derived
			.filter(([, target]) => exists(db, target))
			.map(
				([derivedKind, target, targetKey]) =>
					`DELETE FROM ${target} WHERE agent_id=old.agent_id ${target === "entities" && db.prepare("SELECT 1 FROM pragma_table_info('entities') WHERE name='person_user_id'").get() ? "AND person_user_id IS NULL" : ""} AND ${targetKey} IN (SELECT derived_id FROM (${affected}) WHERE derived_kind='${derivedKind}') AND NOT EXISTS(SELECT 1 FROM evidence_citations c WHERE c.agent_id=old.agent_id AND c.derived_kind='${derivedKind}' AND c.derived_id=${targetKey.startsWith("json_array") ? targetKey.replace(/\b(revision|entry_id|session_key|context_epoch|item_kind|item_id)\b/g, `${target}.$1`) : `${target}.${targetKey}`} AND NOT(c.evidence_kind='${kind}' AND c.evidence_id=old.${key}));`,
			)
			.join("");
		const enqueue = exists(db, "org_jobs")
			? `UPDATE org_jobs SET status='pending',progress_json=NULL,error=NULL,finished_at=NULL WHERE kind='recompute' AND status IN ('pending','running') AND json_extract(params_json,'$.agentId')=old.agent_id AND EXISTS(${affected}); INSERT INTO org_jobs(id,kind,status,params_json,created_at) SELECT 'job_recompute_'||lower(hex(randomblob(16))),'recompute','pending',json_object('agentId',old.agent_id),datetime('now') WHERE EXISTS(${affected}) AND NOT EXISTS(SELECT 1 FROM org_jobs WHERE kind='recompute' AND status IN ('pending','running') AND json_extract(params_json,'$.agentId')=old.agent_id);`
			: "";
		db.exec(
			`DROP TRIGGER IF EXISTS ${table}_evidence_purge; CREATE TRIGGER ${table}_evidence_purge AFTER DELETE ON ${table} BEGIN ${enqueue}${deletes} DELETE FROM evidence_citations WHERE agent_id=old.agent_id AND evidence_kind='${kind}' AND evidence_id=old.${key}; END`,
		);
	}
	for (const [kind, table, key] of derived) {
		if (!exists(db, table)) continue;
		const oldKey = key.startsWith("json_array")
			? key
					.replaceAll("revision", "old.revision")
					.replaceAll("entry_id", "old.entry_id")
					.replaceAll("session_key", "old.session_key")
					.replaceAll("context_epoch", "old.context_epoch")
					.replaceAll("item_kind", "old.item_kind")
					.replaceAll("item_id", "old.item_id")
			: `old.${key}`;
		db.exec(
			`DROP TRIGGER IF EXISTS ${table}_citation_purge; CREATE TRIGGER ${table}_citation_purge AFTER DELETE ON ${table} BEGIN DELETE FROM evidence_citations WHERE derived_kind='${kind}' AND agent_id=old.agent_id AND derived_id=${oldKey}; END`,
		);
	}
}
