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
function installWriteGuards(db: MigrationDb): void {
	for (const table of [
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
				.map((r) => r.name),
		);
		if (!columns.has("agent_id")) continue;
		const sessions = ["session_key", "session_id"].filter((c) => columns.has(c)).map((c) => `new.${c}`);
		const sources = ["source_id", "source_ref"].filter((c) => columns.has(c)).map((c) => `new.${c}`);
		if (table === "memories") sessions.push("new.source_id");
		const memory =
			table === "memories"
				? "new.id"
				: table === "memory_hints"
					? "new.memory_id"
					: table.startsWith("embeddings")
						? "CASE WHEN new.source_type='memory' THEN new.source_id END"
						: "NULL";
		const match = [
			"a.target_kind='agent'",
			`(a.target_kind='memory' AND a.target_id=${memory})`,
			...sessions.map(
				(s) =>
					`(a.target_kind='session' AND (a.target_id=${s} OR a.target_id='session:'||${s} OR 'session:'||a.target_id=${s}))`,
			),
			...sources.map(
				(s) =>
					`(a.target_kind='source' AND (a.target_id=${s} OR substr(${s},1,length(a.target_id)+1)=a.target_id||':'))`,
			),
		];
		const required = [
			`SELECT a.classification_id FROM classification_assignments a WHERE a.agent_id=new.agent_id AND (${match.join(" OR ")})`,
		];
		if (table === "memory_hints" || table.startsWith("embeddings"))
			required.push(
				`SELECT cm.classification_id FROM memories p JOIN compartment_members cm ON cm.compartment_id=p.compartment_id WHERE p.agent_id=new.agent_id AND p.id=${memory}`,
			);
		for (const event of ["INSERT", "UPDATE"])
			db.exec(
				`DROP TRIGGER IF EXISTS ${table}_compartment_${event.toLowerCase()};CREATE TRIGGER ${table}_compartment_${event.toLowerCase()} BEFORE ${event} ON ${table} BEGIN ${table === "session_checkpoints" && event === "INSERT" ? "SELECT RAISE(ABORT,'agent_required') WHERE new.agent_id IS NULL;" : ""} SELECT RAISE(ABORT,'compartment_required') WHERE EXISTS(SELECT 1 FROM (${required.join(" UNION ")}) required WHERE NOT EXISTS(SELECT 1 FROM compartment_members cm WHERE cm.compartment_id=new.compartment_id AND cm.classification_id=required.classification_id));END`,
			);
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
	installWriteGuards(db);
	backfillEvidenceCitations(db);
	rebuildBaseCompartmentFts(db);
	if (exists(db, "memories_fts")) createMemoriesFts(db);
}
