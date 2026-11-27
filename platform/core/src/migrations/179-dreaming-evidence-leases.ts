import type { MigrationDb } from "./contract";
import { compartmentFor } from "../compartment-shards";

function partitionDreamingHistory(db: MigrationDb): void {
	if (
		db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_dreaming_history_nodes_partition'")
			.get()
	)
		return;
	db.exec(`
		CREATE TABLE dreaming_history_nodes_v179 (
			agent_id TEXT NOT NULL, scope_key TEXT NOT NULL, level INTEGER NOT NULL, idx INTEGER NOT NULL,
			pass_id TEXT, text TEXT NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER,
			created_at TEXT NOT NULL DEFAULT (datetime('now')), compartment_id INTEGER
		);
		INSERT INTO dreaming_history_nodes_v179
			(agent_id,scope_key,level,idx,pass_id,text,tokens_input,tokens_output,tokens_cache_read,created_at,compartment_id)
		SELECT agent_id,scope_key,level,idx,pass_id,text,tokens_input,tokens_output,tokens_cache_read,created_at,compartment_id
		FROM dreaming_history_nodes;
		DROP TABLE dreaming_history_nodes;
		ALTER TABLE dreaming_history_nodes_v179 RENAME TO dreaming_history_nodes;
		CREATE UNIQUE INDEX idx_dreaming_history_nodes_partition
		ON dreaming_history_nodes(agent_id,scope_key,COALESCE(compartment_id,0),level,idx);
		CREATE UNIQUE INDEX idx_dreaming_history_nodes_pass ON dreaming_history_nodes(pass_id) WHERE pass_id IS NOT NULL;
		CREATE INDEX idx_dreaming_history_nodes_compartment ON dreaming_history_nodes(agent_id,compartment_id);
	`);
}

function partitionOntologyKeys(db: MigrationDb): void {
	const dependencyIndex = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_entity_deps_unique'").get()?.sql;
	if (typeof dependencyIndex !== "string" || !dependencyIndex.includes("compartment_id"))
		db.exec(
			"DROP INDEX IF EXISTS idx_entity_deps_unique; CREATE UNIQUE INDEX idx_entity_deps_unique ON entity_dependencies(source_entity_id,target_entity_id,dependency_type,agent_id,COALESCE(compartment_id,0));",
		);

	for (const [table, key, index] of [
		["entities", "agent_id,name", "idx_entities_partition_name"],
		["entity_aspects", "entity_id,canonical_name", "idx_entity_aspects_partition_name"],
	] as const) {
		if (db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(index)) continue;
		if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys === 1)
			throw new Error("Migration 179 requires foreign keys disabled before its transaction");
		const original = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
		if (typeof original !== "string") throw new Error(`Missing ontology table: ${table}`);
		const attached = db
			.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL")
			.all(table);
		const columns = db
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.map((row) => {
				if (typeof row.name !== "string") throw new Error("Invalid ontology column");
				return '"' + row.name.replaceAll('"', '""') + '"';
			})
			.join(",");
		const replacement = table + "_v179";
		const schema = original
			.replace(
				/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/i,
				`CREATE TABLE ${replacement}`,
			)
			.replace(/,\s*UNIQUE\s*\(\s*(?:agent_id\s*,\s*name|entity_id\s*,\s*canonical_name)\s*\)/i, "");
		if (schema === original) throw new Error("Ontology partition key was not replaced");
		const legacyAlter = db.prepare("PRAGMA legacy_alter_table").get()?.legacy_alter_table;
		db.exec("PRAGMA legacy_alter_table=ON");
		try {
			db.exec(schema);
			db.exec(
				`INSERT INTO ${replacement}(rowid,${columns}) SELECT rowid,${columns} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${replacement} RENAME TO ${table};`,
			);
		} finally {
			if (legacyAlter !== 1) db.exec("PRAGMA legacy_alter_table=OFF");
		}
		for (const row of attached) if (typeof row.sql === "string") db.exec(row.sql);
		db.exec(
			`CREATE UNIQUE INDEX ${index} ON ${table}(${key},COALESCE(compartment_id,0))${table === "entities" ? " WHERE person_user_id IS NULL" : ""};`,
		);
	}
	const entityIndex = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_entities_partition_name'").get()?.sql;
	if (typeof entityIndex !== "string" || !entityIndex.includes("WHERE person_user_id IS NULL"))
		db.exec(
			"DROP INDEX IF EXISTS idx_entities_partition_name; CREATE UNIQUE INDEX idx_entities_partition_name ON entities(agent_id,name,COALESCE(compartment_id,0)) WHERE person_user_id IS NULL;",
		);
}

function installPersonIdentityOwner(db: MigrationDb): void {
	db.exec(`CREATE VIEW IF NOT EXISTS person_identity_grants AS
		SELECT a.id AS agent_id,u.id AS user_id,u.display_name || ' (' || u.username || ')' AS name
		FROM agents a JOIN users u ON u.status='active'
		WHERE a.archived_at IS NULL AND (
			a.kind='organization' OR (a.kind='personal' AND a.owner_user_id=u.id)
			OR (a.kind='team' AND EXISTS(SELECT 1 FROM group_members m JOIN groups g ON g.id=m.group_id
				WHERE m.user_id=u.id AND m.group_id=a.owner_group_id))
			OR (a.kind='legacy' AND (u.role='admin' OR EXISTS(SELECT 1 FROM api_keys k
				WHERE k.user_id=u.id AND k.agent_id=a.id AND k.revoked_at IS NULL
				AND (k.expires_at IS NULL OR k.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')))))
		)`);
	const project = (scope: string): string => `
		INSERT INTO entities(id,agent_id,person_user_id,name,canonical_name,entity_type,compartment_id,status,created_at,updated_at)
		SELECT 'person_' || hex(randomblob(16)),agent_id,user_id,name,'person:' || user_id,'person',NULL,'active',datetime('now'),datetime('now')
		FROM person_identity_grants WHERE ${scope}
		ON CONFLICT(agent_id,person_user_id) WHERE person_user_id IS NOT NULL DO UPDATE SET
		name=excluded.name,canonical_name=excluded.canonical_name,entity_type='person',compartment_id=NULL,status='active',
		archived_at=NULL,archived_by=NULL,archive_reason=NULL,proposal_id=NULL,proposal_evidence='[]',dreaming_pass_id=NULL,
		updated_at=datetime('now') WHERE entities.name != excluded.name OR entities.canonical_name IS NOT excluded.canonical_name
		OR entities.entity_type != 'person' OR entities.compartment_id IS NOT NULL OR entities.status != 'active'
		OR entities.proposal_id IS NOT NULL OR entities.proposal_evidence != '[]' OR entities.dreaming_pass_id IS NOT NULL;
		UPDATE entities SET status='archived',archived_at=datetime('now'),archived_by='identity-owner',archive_reason='act_as_revoked',updated_at=datetime('now')
		WHERE person_user_id IS NOT NULL AND status != 'archived'
		AND EXISTS(SELECT 1 FROM (SELECT agent_id,person_user_id AS user_id) WHERE ${scope})
		AND NOT EXISTS(SELECT 1 FROM person_identity_grants p WHERE p.agent_id=entities.agent_id AND p.user_id=entities.person_user_id);
	`;
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='identity_person_users_insert'").get()) {
		db.exec(`DELETE FROM evidence_citations WHERE derived_kind='entity' AND derived_id IN (SELECT id FROM entities WHERE person_user_id IS NOT NULL);
			UPDATE entities SET compartment_id=NULL,proposal_id=NULL,proposal_evidence='[]',dreaming_pass_id=NULL,
			name=COALESCE((SELECT display_name || ' (' || username || ')' FROM users WHERE id=person_user_id),'Unknown user (' || person_user_id || ')'),
			canonical_name='person:' || person_user_id,entity_type='person',description=NULL,embedding=NULL,mentions=0,
			pinned=0,pinned_at=NULL,last_synthesized_at=NULL,community_id=NULL,source_id=NULL,source_kind=NULL,source_path=NULL,source_root=NULL
			WHERE person_user_id IS NOT NULL;`);
	}
	db.exec(project("1"));
	for (const [table, key, predicate, columns] of [
		["users", "id", "user_id", "id,username,display_name,role,status"],
		["agents", "id", "agent_id", "id,kind,owner_user_id,owner_group_id,archived_at"],
		["group_members", "user_id", "user_id", "group_id,user_id"],
		["api_keys", "user_id", "user_id", "user_id,agent_id,revoked_at,expires_at"],
		["groups", "id", "agent_id IN (SELECT id FROM agents WHERE owner_group_id", "id"],
	] as const) {
		for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
			const refs =
				operation === "INSERT"
					? [`NEW.${key}`]
					: operation === "DELETE"
						? [`OLD.${key}`]
						: [`NEW.${key}`, `OLD.${key}`];
			const scope = table === "groups" ? `${predicate} IN (${refs.join(",")}))` : `${predicate} IN (${refs.join(",")})`;
			if (operation === "UPDATE") db.exec(`DROP TRIGGER IF EXISTS identity_person_${table}_update`);
			db.exec(
				`CREATE TRIGGER IF NOT EXISTS identity_person_${table}_${operation.toLowerCase()} AFTER ${operation}${operation === "UPDATE" ? ` OF ${columns}` : ""} ON ${table} BEGIN ${project(scope)} END;`,
			);
		}
	}
}

function partitionEvidenceProgress(db: MigrationDb): void {
	const revision = "agent_id,source_kind,source_id,source_captured_at,source_entry_id,source_revision";
	for (const [table, key] of [
		["dreaming_evidence_consumption", revision],
		["dreaming_evidence_reviews", revision],
		["dreaming_evidence_exclusions", "agent_id,source_kind,source_id"],
	] as const) {
		const index = `idx_${table}_partition`;
		if (db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(index)) continue;
		const original = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
		if (typeof original !== "string") throw new Error(`Missing evidence progress table: ${table}`);
		const columns = db
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.map((row) => {
				if (typeof row.name !== "string") throw new Error("Invalid evidence progress column");
				return '"' + row.name.replaceAll('"', '""') + '"';
			})
			.join(",");
		const attached = db
			.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL")
			.all(table);
		const replacement = table + "_v179";
		const schema = original
			.replace(
				/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/i,
				`CREATE TABLE ${replacement}`,
			)
			.replace(/,\s*PRIMARY KEY\s*\([^)]*\)/i, ", compartment_id INTEGER");
		if (schema === original) throw new Error("Evidence progress key was not replaced");
		const legacyAlter = db.prepare("PRAGMA legacy_alter_table").get()?.legacy_alter_table;
		db.exec("PRAGMA legacy_alter_table=ON");
		try {
			db.exec(schema);
			db.exec(
				`INSERT INTO ${replacement}(rowid,${columns}) SELECT rowid,${columns} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${replacement} RENAME TO ${table};`,
			);
		} finally {
			if (legacyAlter !== 1) db.exec("PRAGMA legacy_alter_table=OFF");
		}
		for (const row of attached) if (typeof row.sql === "string") db.exec(row.sql);
		db.exec(
			`CREATE UNIQUE INDEX ${index} ON ${table}(${key},COALESCE(compartment_id,0)); CREATE INDEX idx_${table}_label ON ${table}(agent_id,compartment_id);`,
		);
	}
}

function upgradeDreamingAliases(db: MigrationDb): void {
	if (
		!db
			.prepare("PRAGMA table_info(entity_aliases)")
			.all()
			.some((row) => row.name === "compartment_id")
	)
		db.exec("ALTER TABLE entity_aliases ADD COLUMN compartment_id INTEGER REFERENCES compartments(id)");
	if (
		!db
			.prepare("PRAGMA table_info(entity_aliases)")
			.all()
			.some((row) => row.name === "dreaming_pass_id")
	)
		db.exec("ALTER TABLE entity_aliases ADD COLUMN dreaming_pass_id TEXT");
	db.exec(`
		DROP INDEX IF EXISTS idx_entity_aliases_active_unique;
		CREATE UNIQUE INDEX idx_entity_aliases_active_unique ON entity_aliases(agent_id, canonical_alias, COALESCE(compartment_id, 0)) WHERE status = 'active';
		CREATE INDEX IF NOT EXISTS idx_entity_aliases_compartment ON entity_aliases(agent_id, compartment_id);
	`);
}

function backfillDreamingAliases(db: MigrationDb): void {
	const creator = `p.agent_id=entity_aliases.agent_id AND p.operation='create_entity_alias' AND p.status='applied' AND CASE WHEN json_valid(p.result) THEN json_extract(p.result,'$.aliasId') END=entity_aliases.id`;
	db.exec(`
		UPDATE entity_aliases SET
			compartment_id=(SELECT p.compartment_id FROM ontology_proposals p WHERE ${creator} ORDER BY p.created_at,p.id LIMIT 1),
			dreaming_pass_id=(SELECT p.dreaming_pass_id FROM ontology_proposals p WHERE ${creator} ORDER BY p.created_at,p.id LIMIT 1)
		WHERE (SELECT COUNT(*) FROM ontology_proposals p WHERE ${creator})=1
		AND NOT EXISTS(SELECT 1 FROM evidence_citations c WHERE c.derived_kind='alias' AND c.derived_id=entity_aliases.id AND c.agent_id=entity_aliases.agent_id);
		WITH creators AS (
			SELECT a.id AS alias_id,p.id AS proposal_id,a.agent_id,p.evidence
			FROM entity_aliases a JOIN ontology_proposals p ON p.agent_id=a.agent_id
			AND p.operation='create_entity_alias' AND p.status='applied'
			AND CASE WHEN json_valid(p.result) THEN json_extract(p.result,'$.aliasId') END=a.id
			WHERE (SELECT COUNT(*) FROM ontology_proposals candidate WHERE candidate.agent_id=a.agent_id AND candidate.operation='create_entity_alias' AND candidate.status='applied' AND CASE WHEN json_valid(candidate.result) THEN json_extract(candidate.result,'$.aliasId') END=a.id)=1
		), refs AS (
			SELECT c.*,CASE WHEN j.type='text' THEN j.value WHEN j.type='object' THEN json_extract(j.value,'$.source_ref') END AS ref
			FROM creators c,json_each(CASE WHEN json_valid(c.evidence) THEN CASE WHEN json_type(c.evidence)='array' THEN c.evidence ELSE '[]' END ELSE '[]' END) j
		), parsed AS (
			SELECT *,substr(ref,1,instr(ref,':')-1) AS kind,substr(ref,instr(ref,':')+1) AS source_id FROM refs WHERE instr(ref,':')>0
		), canonical AS (
			SELECT p.proposal_id,p.agent_id,p.kind,m.id AS evidence_id FROM parsed p JOIN memories m ON p.kind='memory' AND m.id=p.source_id AND m.agent_id=p.agent_id
			UNION ALL SELECT p.proposal_id,p.agent_id,p.kind,t.session_key FROM parsed p JOIN session_transcripts t ON p.kind='transcript' AND t.session_key=p.source_id AND t.agent_id=p.agent_id
			UNION ALL SELECT p.proposal_id,p.agent_id,p.kind,a.source_path FROM parsed p JOIN memory_artifacts a ON p.kind='artifact' AND a.source_path=p.source_id AND a.agent_id=p.agent_id
			UNION ALL SELECT p.proposal_id,p.agent_id,p.kind,s.id FROM parsed p JOIN session_summaries s ON p.kind='summary' AND s.id=p.source_id AND s.agent_id=p.agent_id
			UNION ALL SELECT p.proposal_id,p.agent_id,p.kind,a.id FROM parsed p JOIN entity_attributes a ON p.kind='attribute' AND a.id=p.source_id AND a.agent_id=p.agent_id
		)
		INSERT OR IGNORE INTO evidence_citations(derived_kind,derived_id,agent_id,evidence_kind,evidence_id)
		SELECT 'proposal',proposal_id,agent_id,kind,evidence_id FROM canonical;
		INSERT OR IGNORE INTO evidence_citations(derived_kind,derived_id,agent_id,evidence_kind,evidence_id)
		SELECT 'alias',a.id,a.agent_id,c.evidence_kind,c.evidence_id
		FROM entity_aliases a JOIN ontology_proposals p ON p.agent_id=a.agent_id
		AND p.operation='create_entity_alias' AND p.status='applied'
		AND CASE WHEN json_valid(p.result) THEN json_extract(p.result,'$.aliasId') END=a.id
		JOIN evidence_citations c ON c.derived_kind='proposal' AND c.derived_id=p.id AND c.agent_id=a.agent_id
		WHERE (SELECT COUNT(*) FROM ontology_proposals candidate WHERE candidate.agent_id=a.agent_id AND candidate.operation='create_entity_alias' AND candidate.status='applied' AND CASE WHEN json_valid(candidate.result) THEN json_extract(candidate.result,'$.aliasId') END=a.id)=1;
	`);
}

function upgradeDreamingChildren(db: MigrationDb): void {
	for (const [table, parents] of [
		[
			"memory_entity_mentions",
			"SELECT agent_id,compartment_id FROM memories WHERE id=child.memory_id UNION ALL SELECT agent_id,compartment_id FROM entities WHERE id=child.entity_id",
		],
		[
			"derived_memory_sources",
			"SELECT agent_id,compartment_id FROM memories WHERE id=child.derived_memory_id UNION ALL SELECT agent_id,compartment_id FROM memories WHERE child.source_kind='memory' AND id=child.source_id UNION ALL SELECT agent_id,compartment_id FROM entity_attributes WHERE child.source_kind='ontology_claim' AND id=child.source_id",
		],
		["memory_history", "SELECT agent_id,compartment_id FROM memories WHERE id=child.memory_id"],
		[
			"relations",
			"SELECT agent_id,compartment_id FROM entities WHERE id=child.source_entity_id OR id=child.target_entity_id",
		],
	] as const) {
		const columns = db.prepare(`PRAGMA table_info(${table})`).all();
		const needsLabel = !columns.some((row) => row.name === "compartment_id");
		if (needsLabel) db.exec(`ALTER TABLE ${table} ADD COLUMN compartment_id INTEGER REFERENCES compartments(id)`);
		if (!columns.some((row) => row.name === "agent_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN agent_id TEXT`);
		if (!columns.some((row) => row.name === "dreaming_pass_id"))
			db.exec(`ALTER TABLE ${table} ADD COLUMN dreaming_pass_id TEXT`);
		if (needsLabel) {
			const rows = db.prepare(`SELECT child.*,child.rowid AS child_rowid FROM ${table} child`).all();
			for (const row of rows) {
				const args: unknown[] = [];
				const parentSql = parents.replace(/child\.(\w+)/g, (_, column: string) => {
					args.push(row[column]);
					return "?";
				});
				const inherited = db.prepare(parentSql).all(...args);
				const agents = new Set(
					inherited.flatMap((parent) => (typeof parent.agent_id === "string" ? [parent.agent_id] : [])),
				);
				const labels = inherited.flatMap((parent) =>
					db
						.prepare("SELECT classification_id FROM compartment_members WHERE compartment_id=?")
						.all(parent.compartment_id)
						.flatMap((member) => (typeof member.classification_id === "string" ? [member.classification_id] : [])),
				);
				db.prepare(`UPDATE ${table} SET agent_id=COALESCE(agent_id,?),compartment_id=? WHERE rowid=?`).run(
					agents.size === 1 ? [...agents][0] : null,
					compartmentFor(db, labels),
					row.child_rowid,
				);
			}
		}
		db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_compartment ON ${table}(agent_id,compartment_id)`);
	}
}

function suspendDreamingPurgeTriggers(db: MigrationDb): { name: string; sql: string }[] {
	return db
		.prepare(
			"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND (name GLOB '*_evidence_purge' OR name GLOB '*_citation_purge')",
		)
		.all()
		.map((row) => {
			if (typeof row.name !== "string" || typeof row.sql !== "string")
				throw new Error("Invalid evidence purge trigger");
			db.exec(`DROP TRIGGER "${row.name.replaceAll('"', '""')}"`);
			return { name: row.name, sql: row.sql };
		});
}

function restoreDreamingPurgeTriggers(db: MigrationDb, triggers: readonly { name: string; sql: string }[]): void {
	for (const trigger of triggers) {
		let sql = trigger.sql
			.replaceAll("memory_head_entries.entry_id", "memory_head_entries.id")
			.replaceAll("memory_head_revision_entries.revision,", "memory_head_revision_entries.revision_id,")
			.replaceAll("json_array(revision,entry_id)", "json_array(revision_id,entry_id)")
			.replaceAll("json_array(old.revision,old.entry_id)", "json_array(old.revision_id,old.entry_id)")
			.replaceAll(
				"DELETE FROM memory_head_entries WHERE agent_id=old.agent_id AND entry_id IN",
				"DELETE FROM memory_head_entries WHERE agent_id=old.agent_id AND id IN",
			);
		if (trigger.name === "memory_head_entries_citation_purge")
			sql = sql.replaceAll("derived_id=old.entry_id", "derived_id=old.id");
		for (const [table, kind, key] of [
			["memories", "memory", "id"],
			["session_transcripts", "transcript", "session_key"],
			["memory_artifacts", "artifact", "source_path"],
			["session_summaries", "summary", "id"],
			["entity_attributes", "attribute", "id"],
		] as const) {
			if (trigger.name !== `${table}_evidence_purge` || sql.includes("DELETE FROM entity_aliases")) continue;
			const marker = `DELETE FROM evidence_citations WHERE agent_id=old.agent_id AND evidence_kind='${kind}'`;
			if (!sql.includes(marker)) throw new Error("Unknown evidence purge trigger layout");
			const aliases = `DELETE FROM entity_aliases WHERE agent_id=old.agent_id AND id IN (SELECT derived_id FROM evidence_citations WHERE agent_id=old.agent_id AND derived_kind='alias' AND evidence_kind='${kind}' AND evidence_id=old.${key}) AND NOT EXISTS(SELECT 1 FROM evidence_citations c WHERE c.agent_id=old.agent_id AND c.derived_kind='alias' AND c.derived_id=entity_aliases.id AND NOT(c.evidence_kind='${kind}' AND c.evidence_id=old.${key})); `;
			sql = sql.replace(marker, aliases + marker);
		}
		db.exec(sql);
	}
	db.exec(`CREATE TRIGGER IF NOT EXISTS entity_aliases_citation_purge AFTER DELETE ON entity_aliases BEGIN
		DELETE FROM evidence_citations WHERE derived_kind='alias' AND derived_id=old.id AND agent_id=old.agent_id;
	END; CREATE INDEX IF NOT EXISTS idx_dreaming_citation_purge_lookup ON evidence_citations(agent_id,derived_kind,derived_id,evidence_kind,evidence_id);`);
}

export function up(db: MigrationDb): void {
	const purgeTriggers = suspendDreamingPurgeTriggers(db);
	for (const [table, column, declaration] of [
		["ontology_proposals", "dreaming_pass_id", "TEXT"],
		["entities", "dreaming_pass_id", "TEXT"],
		["dreaming_attention", "dreaming_pass_id", "TEXT"],
		["memory_head_revisions", "compartment_id", "INTEGER"],
		["memory_head_publications", "compartment_id", "INTEGER"],
	]) {
		if (!table || !column || !declaration) throw new Error("Invalid migration column");
		const columns = db.prepare(`PRAGMA table_info(${table})`).all();
		if (!columns.some((row) => row.name === column))
			db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
	}
	const epochColumns = db.prepare("PRAGMA table_info(dreaming_classification_epoch)").all();
	if (epochColumns.some((column) => column.name === "id")) {
		db.exec(`
			DROP TRIGGER IF EXISTS dreaming_pass_classification_epoch;
			DROP TRIGGER IF EXISTS dreaming_pass_completion_epoch;
			DROP TRIGGER IF EXISTS dreaming_classification_epoch_insert;
			DROP TRIGGER IF EXISTS dreaming_classification_epoch_update;
			DROP TRIGGER IF EXISTS dreaming_classification_epoch_delete;
			DROP TRIGGER IF EXISTS dreaming_evidence_lease_insert;
			DROP TRIGGER IF EXISTS dreaming_evidence_lease_update;
			DROP TABLE dreaming_classification_epoch;
		`);
	}
	db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_classification_epoch (
			agent_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS dreaming_pass_classification_epochs (
			pass_id TEXT NOT NULL, agent_id TEXT NOT NULL, epoch INTEGER NOT NULL,
			PRIMARY KEY(pass_id,agent_id), FOREIGN KEY(pass_id) REFERENCES dreaming_passes(id) ON DELETE CASCADE
		);
		CREATE VIEW IF NOT EXISTS dreaming_classification_job_agents AS
			SELECT j.id AS job_id, json_extract(j.params_json,'$.target.agentId') AS agent_id
			FROM org_jobs j WHERE j.kind IN ('classify','unclassify') AND j.status IN ('pending','running');
		CREATE VIEW IF NOT EXISTS dreaming_pass_fences AS
			SELECT p.id AS pass_id, (
				EXISTS(SELECT 1 FROM dreaming_pass_classification_epochs s WHERE s.pass_id=p.id AND s.agent_id=p.agent_id)
				AND NOT EXISTS(SELECT 1 FROM dreaming_pass_classification_epochs s
					LEFT JOIN dreaming_classification_epoch e ON e.agent_id=s.agent_id
					WHERE s.pass_id=p.id AND (s.epoch != COALESCE(e.epoch,0)
						OR EXISTS(SELECT 1 FROM dreaming_classification_job_agents j WHERE j.agent_id=s.agent_id)))
			) AS valid FROM dreaming_passes p;
		CREATE TRIGGER IF NOT EXISTS dreaming_pass_agent_policy BEFORE INSERT ON dreaming_passes
		WHEN EXISTS(SELECT 1 FROM agents a WHERE a.id=NEW.agent_id AND (a.archived_at IS NOT NULL OR
			(a.kind='organization' AND EXISTS(SELECT 1 FROM organization o WHERE o.id=1 AND o.claimed_at IS NOT NULL AND o.agent_model='personal'))))
		BEGIN SELECT RAISE(ABORT,'org_policy'); END;
		CREATE TRIGGER IF NOT EXISTS dreaming_pass_classification_epoch AFTER INSERT ON dreaming_passes BEGIN
			INSERT INTO dreaming_pass_classification_epochs(pass_id,agent_id,epoch)
			WITH RECURSIVE scopes(agent_id,rest) AS (
				SELECT NEW.agent_id, COALESCE(NULLIF(NEW.scope_key,''),NEW.agent_id) || ','
				UNION ALL SELECT substr(rest,1,instr(rest,',')-1),substr(rest,instr(rest,',')+1) FROM scopes WHERE rest!=''
			)
			SELECT NEW.id,s.agent_id,COALESCE(e.epoch,0) FROM scopes s LEFT JOIN dreaming_classification_epoch e ON e.agent_id=s.agent_id
			WHERE s.agent_id!='' GROUP BY s.agent_id;
		END;
		CREATE TRIGGER IF NOT EXISTS dreaming_pass_scope_classification_epoch AFTER UPDATE OF scope_key ON dreaming_passes
		WHEN NEW.status='running' BEGIN
			INSERT OR IGNORE INTO dreaming_pass_classification_epochs(pass_id,agent_id,epoch)
			WITH RECURSIVE scopes(agent_id,rest) AS (
				SELECT NEW.agent_id, COALESCE(NULLIF(NEW.scope_key,''),NEW.agent_id) || ','
				UNION ALL SELECT substr(rest,1,instr(rest,',')-1),substr(rest,instr(rest,',')+1) FROM scopes WHERE rest!=''
			)
			SELECT NEW.id,s.agent_id,COALESCE(e.epoch,0) FROM scopes s LEFT JOIN dreaming_classification_epoch e ON e.agent_id=s.agent_id
			WHERE s.agent_id!='' GROUP BY s.agent_id;
		END;
		CREATE TRIGGER IF NOT EXISTS dreaming_pass_completion_epoch BEFORE UPDATE OF status ON dreaming_passes
		WHEN OLD.status='running' AND NEW.status='completed' AND NOT EXISTS(SELECT 1 FROM dreaming_pass_fences WHERE pass_id=NEW.id AND valid=1)
		BEGIN SELECT RAISE(ABORT,'compartment_mismatch'); END;
		CREATE TABLE IF NOT EXISTS dreaming_evidence_leases (
			agent_id TEXT NOT NULL,
			compartment_id INTEGER CHECK (compartment_id IS NULL OR compartment_id > 0),
			source_kind TEXT NOT NULL CHECK (source_kind IN ('memory', 'artifact', 'transcript', 'summary')),
			source_id TEXT NOT NULL,
			pass_id TEXT NOT NULL,
			leased_at TEXT NOT NULL,
			expires_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_dreaming_evidence_lease_partition
		ON dreaming_evidence_leases (agent_id, COALESCE(compartment_id, 0), source_kind, source_id);
		CREATE INDEX IF NOT EXISTS idx_dreaming_evidence_leases_pass ON dreaming_evidence_leases (pass_id);
	`);
	for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
		const agents =
			operation === "INSERT" ? "NEW.agent_id" : operation === "DELETE" ? "OLD.agent_id" : "OLD.agent_id,NEW.agent_id";
		const targets = operation === "UPDATE" ? "SELECT OLD.agent_id UNION SELECT NEW.agent_id" : `SELECT ${agents}`;
		db.exec(`CREATE TRIGGER IF NOT EXISTS dreaming_classification_epoch_${operation.toLowerCase()}
		AFTER ${operation} ON classification_assignments BEGIN
			INSERT OR IGNORE INTO dreaming_classification_epoch(agent_id,epoch)
			SELECT agent_id,0 FROM (${targets}) WHERE agent_id IS NOT NULL;
			UPDATE dreaming_classification_epoch SET epoch=epoch+1 WHERE agent_id IN (${agents});
		END;`);
	}
	partitionDreamingKeys(db);
	partitionMemoryHeads(db);
	migrateMemoryHeadCitationKeys(db);
	partitionDreamingHistory(db);
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_memory_artifacts_dreaming_partition_path ON memory_artifacts(agent_id,compartment_id,source_path)",
	);
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_memory_artifacts_dreaming_partition_sha ON memory_artifacts(agent_id,compartment_id,source_sha256,COALESCE(source_id,''),COALESCE(is_deleted,0),captured_at DESC,source_path)",
	);
	partitionDreamingState(db);
	partitionEvidenceProgress(db);
	upgradeDreamingChildren(db);
	upgradeDreamingAliases(db);
	extendDreamingCitations(db);
	backfillDreamingAliases(db);
	partitionOntologyKeys(db);
	installPersonIdentityOwner(db);
	for (const operation of ["INSERT", "UPDATE"]) {
		db.exec(`CREATE TRIGGER IF NOT EXISTS dreaming_evidence_lease_${operation.toLowerCase()}
		BEFORE ${operation} ON dreaming_evidence_leases BEGIN
			SELECT CASE WHEN NOT EXISTS (
				SELECT 1 FROM dreaming_passes p JOIN dreaming_pass_fences f ON f.pass_id = p.id
				WHERE p.id = NEW.pass_id AND p.status = 'running'
				AND p.compartment_id IS NEW.compartment_id AND f.valid = 1
				AND instr(',' || COALESCE(NULLIF(p.scope_key, ''), p.agent_id) || ',', ',' || NEW.agent_id || ',') > 0
			) THEN RAISE(ABORT, 'compartment_mismatch') END;
			SELECT CASE WHEN EXISTS (
				SELECT 1 FROM agents a WHERE a.id = NEW.agent_id AND (a.archived_at IS NOT NULL OR
				(a.kind = 'organization' AND EXISTS (SELECT 1 FROM organization o
				WHERE o.id = 1 AND o.claimed_at IS NOT NULL AND o.agent_model = 'personal')))
			) THEN RAISE(ABORT, 'org_policy') END;
			SELECT CASE WHEN NOT EXISTS (
				SELECT 1 FROM memories WHERE NEW.source_kind = 'memory' AND id = NEW.source_id
				AND agent_id = NEW.agent_id AND compartment_id IS NEW.compartment_id AND is_deleted = 0
				UNION ALL SELECT 1 FROM memory_artifacts WHERE NEW.source_kind = 'artifact' AND source_path = NEW.source_id
				AND agent_id = NEW.agent_id AND compartment_id IS NEW.compartment_id AND is_deleted = 0
				UNION ALL SELECT 1 FROM session_transcripts WHERE NEW.source_kind = 'transcript' AND session_key = NEW.source_id
				AND agent_id = NEW.agent_id AND compartment_id IS NEW.compartment_id
				UNION ALL SELECT 1 FROM session_summaries WHERE NEW.source_kind = 'summary' AND id = NEW.source_id
				AND agent_id = NEW.agent_id AND compartment_id IS NEW.compartment_id
			) THEN RAISE(ABORT, 'compartment_mismatch') END;
		END;`);
	}
	restoreDreamingPurgeTriggers(db, purgeTriggers);
}

function partitionMemoryHeads(db: MigrationDb): void {
	const installed = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_memory_head_revisions_partition'").get();
	if (!installed) {
		db.exec(`
			CREATE TABLE memory_head_revisions_v179 (
				id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, revision INTEGER NOT NULL,
				content TEXT NOT NULL, content_hash TEXT NOT NULL, rendered_token_count INTEGER NOT NULL,
				pass_id TEXT NOT NULL, base_revision INTEGER NOT NULL, base_hash TEXT NOT NULL, created_at TEXT NOT NULL,
				entry_id TEXT, entry_text TEXT, operation TEXT, source_refs_json TEXT, supporting_quotes_json TEXT,
				compartment_id INTEGER, is_current INTEGER NOT NULL DEFAULT 1
			);
			INSERT INTO memory_head_revisions_v179 SELECT id,agent_id,revision,content,content_hash,rendered_token_count,
				pass_id,base_revision,base_hash,created_at,entry_id,entry_text,operation,source_refs_json,supporting_quotes_json,compartment_id,
				CASE WHEN revision = (SELECT MAX(latest.revision) FROM memory_head_revisions latest
					WHERE latest.agent_id=memory_head_revisions.agent_id
					AND latest.compartment_id IS memory_head_revisions.compartment_id) THEN 1 ELSE 0 END
				FROM memory_head_revisions;
			DROP TABLE memory_head_revisions;
			ALTER TABLE memory_head_revisions_v179 RENAME TO memory_head_revisions;
			CREATE UNIQUE INDEX idx_memory_head_revisions_partition ON memory_head_revisions(agent_id,COALESCE(compartment_id,0),revision);
			CREATE INDEX idx_memory_head_revisions_agent ON memory_head_revisions(agent_id,compartment_id,revision DESC);
			CREATE INDEX idx_memory_head_revisions_content_hash ON memory_head_revisions(content_hash);
			CREATE UNIQUE INDEX idx_memory_head_revisions_entry ON memory_head_revisions(agent_id,COALESCE(compartment_id,0),revision,entry_id);
			CREATE TABLE memory_head_revision_entries_v179 (
				agent_id TEXT NOT NULL, revision INTEGER NOT NULL, entry_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
				operation TEXT NOT NULL CHECK(operation IN ('add','update','remove','retain')), provenance_json TEXT NOT NULL,
				compartment_id INTEGER, pass_id TEXT, revision_id TEXT
			);
			INSERT INTO memory_head_revision_entries_v179 SELECT e.agent_id,e.revision,e.entry_id,e.ordinal,e.operation,e.provenance_json,e.compartment_id,r.pass_id,r.id
				FROM memory_head_revision_entries e LEFT JOIN memory_head_revisions r ON r.agent_id=e.agent_id AND r.revision=e.revision AND r.compartment_id IS e.compartment_id;
			DROP TABLE memory_head_revision_entries;
			ALTER TABLE memory_head_revision_entries_v179 RENAME TO memory_head_revision_entries;
			CREATE UNIQUE INDEX idx_memory_head_revision_entries_partition ON memory_head_revision_entries(agent_id,COALESCE(compartment_id,0),revision,entry_id);
			CREATE UNIQUE INDEX idx_memory_head_revision_entries_ordinal ON memory_head_revision_entries(agent_id,COALESCE(compartment_id,0),revision,ordinal);
			CREATE INDEX idx_memory_head_revision_entries_entry ON memory_head_revision_entries(agent_id,entry_id,compartment_id,revision DESC);
			CREATE TABLE memory_head_publications_v179 (
				agent_id TEXT NOT NULL, revision INTEGER NOT NULL, revision_id TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('pending','completed')), created_at TEXT NOT NULL, completed_at TEXT, compartment_id INTEGER,
				UNIQUE(agent_id,revision_id)
			);
			INSERT INTO memory_head_publications_v179 SELECT agent_id,revision,revision_id,status,created_at,completed_at,compartment_id FROM memory_head_publications;
			DROP TABLE memory_head_publications;
			ALTER TABLE memory_head_publications_v179 RENAME TO memory_head_publications;
			CREATE UNIQUE INDEX idx_memory_head_publications_partition ON memory_head_publications(agent_id,COALESCE(compartment_id,0),revision);
			CREATE INDEX idx_memory_head_publications_pending ON memory_head_publications(agent_id,compartment_id,status,revision DESC);
		`);
	}
	db.exec(`UPDATE memory_head_revisions SET is_current=0 WHERE EXISTS (
		SELECT 1 FROM memory_head_revisions newer WHERE newer.agent_id=memory_head_revisions.agent_id
		AND newer.compartment_id IS memory_head_revisions.compartment_id AND newer.revision>memory_head_revisions.revision
	);`);
	const entryColumns = db.prepare("PRAGMA table_info(memory_head_entries)").all();
	if (!entryColumns.some((row) => row.name === "pass_id"))
		db.exec("ALTER TABLE memory_head_entries ADD COLUMN pass_id TEXT");
	db.exec(`
		DROP TRIGGER IF EXISTS dreaming_passes_head_fence_ai;
		CREATE TRIGGER dreaming_passes_head_fence_ai AFTER INSERT ON dreaming_passes WHEN NEW.mode = 'incremental-content' BEGIN
			INSERT OR IGNORE INTO memory_md_heads(agent_id,content,content_hash,revision,updated_at,is_current)
				SELECT NEW.agent_id,'','',0,datetime('now'),0 WHERE NEW.compartment_id IS NULL;
			UPDATE dreaming_passes SET head_base_revision = CASE WHEN NEW.compartment_id IS NULL
				THEN (SELECT revision FROM memory_md_heads WHERE agent_id=NEW.agent_id)
				ELSE COALESCE((SELECT MAX(revision) FROM memory_head_revisions WHERE agent_id=NEW.agent_id AND compartment_id IS NEW.compartment_id),0) END WHERE id=NEW.id;
		END;
	`);
	for (const table of ["memories", "memory_artifacts", "session_transcripts", "session_summaries"]) {
		const subset = (
			row: string,
			label: string,
		) => `(${row}.compartment_id IS NULL OR (${label} IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM compartment_members evidence WHERE evidence.compartment_id=${row}.compartment_id AND NOT EXISTS (
				SELECT 1 FROM compartment_members audience WHERE audience.compartment_id=${label} AND audience.classification_id=evidence.classification_id))))`;
		for (const operation of ["UPDATE", "DELETE"]) {
			const suffix = operation === "UPDATE" ? "au" : "ad";
			const agents = operation === "UPDATE" ? "(OLD.agent_id,NEW.agent_id)" : "(OLD.agent_id)";
			const globalMemory =
				operation === "UPDATE"
					? "(COALESCE(OLD.visibility,'global')='global' OR COALESCE(NEW.visibility,'global')='global')"
					: "COALESCE(OLD.visibility,'global')='global'";
			const publicAgents =
				table === "memories"
					? `(agent_id IN ${agents} OR (${globalMemory} AND (agent_id IN (SELECT id FROM agents WHERE read_policy='shared') OR agent_id IN (SELECT id FROM agents WHERE read_policy='group' AND policy_group IN (SELECT policy_group FROM agents WHERE id IN ${agents})))) )`
					: `agent_id IN ${agents}`;
			const visible =
				operation === "UPDATE"
					? "(OLD.compartment_id IS NULL OR NEW.compartment_id IS NULL)"
					: "OLD.compartment_id IS NULL";
			const revisionVisible =
				operation === "UPDATE"
					? `(${subset("OLD", "memory_head_revisions.compartment_id")} OR ${subset("NEW", "memory_head_revisions.compartment_id")})`
					: subset("OLD", "memory_head_revisions.compartment_id");
			const passVisible =
				operation === "UPDATE"
					? `(${subset("OLD", "dreaming_passes.compartment_id")} OR ${subset("NEW", "dreaming_passes.compartment_id")})`
					: subset("OLD", "dreaming_passes.compartment_id");
			const contentChanged =
				table === "memories"
					? "OLD.content IS NOT NEW.content OR OLD.superseded_by IS NOT NEW.superseded_by OR OLD.stale_at IS NOT NEW.stale_at OR OLD.is_deleted IS NOT NEW.is_deleted OR OLD.visibility IS NOT NEW.visibility OR OLD.scope IS NOT NEW.scope OR OLD.memory_kind IS NOT NEW.memory_kind"
					: table === "memory_artifacts"
						? "OLD.content IS NOT NEW.content OR OLD.is_deleted IS NOT NEW.is_deleted"
						: table === "session_transcripts"
							? "(OLD.completed_at IS NOT NULL AND (OLD.content IS NOT NEW.content OR NEW.completed_at IS NULL))"
							: "(OLD.content IS NOT NEW.content OR OLD.source_ref IS NOT NEW.source_ref OR OLD.source_type IS NOT NEW.source_type OR OLD.depth IS NOT NEW.depth)";
			const changed =
				operation === "UPDATE"
					? ` WHEN ${table === "session_summaries" ? "(OLD.depth=0 OR NEW.depth=0) AND" : ""} (OLD.agent_id IS NOT NEW.agent_id OR OLD.compartment_id IS NOT NEW.compartment_id OR ${contentChanged})`
					: table === "session_summaries"
						? " WHEN OLD.depth=0"
						: "";
			db.exec(`DROP TRIGGER IF EXISTS ${table}_head_freshness_${suffix};
				CREATE TRIGGER ${table}_head_freshness_${suffix} AFTER ${operation} ON ${table}${changed} BEGIN
					UPDATE memory_md_heads SET revision=revision+1,is_current=0 WHERE ${publicAgents} AND ${visible};
					UPDATE memory_head_revisions SET is_current=0 WHERE agent_id IN ${agents} AND ${revisionVisible};
					UPDATE dreaming_passes SET head_base_revision=-1 WHERE status='running' AND mode='incremental-content' AND agent_id IN ${agents} AND ${passVisible};
				END;`);
		}
	}
}

function partitionDreamingState(db: MigrationDb): void {
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_dreaming_state_partition'").get()) return;
	db.exec(`
		CREATE TABLE dreaming_state_v179 (
			agent_id TEXT NOT NULL, compartment_id INTEGER,
			tokens_since_last_pass INTEGER NOT NULL DEFAULT 0,
			consecutive_failures INTEGER NOT NULL DEFAULT 0,
			last_pass_at TEXT, last_pass_id TEXT, last_pass_mode TEXT, evidence_cursor TEXT, last_failure_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		INSERT INTO dreaming_state_v179(agent_id,tokens_since_last_pass,consecutive_failures,last_pass_at,last_pass_id,last_pass_mode,evidence_cursor,last_failure_at,created_at,updated_at)
			SELECT agent_id,tokens_since_last_pass,consecutive_failures,last_pass_at,last_pass_id,last_pass_mode,evidence_cursor,last_failure_at,created_at,updated_at FROM dreaming_state;
		DROP TABLE dreaming_state;
		ALTER TABLE dreaming_state_v179 RENAME TO dreaming_state;
		CREATE UNIQUE INDEX idx_dreaming_state_partition ON dreaming_state(agent_id,COALESCE(compartment_id,0));
	`);
}

function extendDreamingCitations(db: MigrationDb): void {
	const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='evidence_citations'").get();
	if (
		typeof definition?.sql === "string" &&
		definition.sql.includes("'attention'") &&
		definition.sql.includes("'community'") &&
		definition.sql.includes("'alias'")
	)
		return;
	db.exec(`
		CREATE TABLE evidence_citations_v179 (
			derived_kind TEXT NOT NULL CHECK(derived_kind IN ('attribute','memory','dependency','entity','aspect','assertion','head_entry','reflection','contradiction','head_revision','proposal','telemetry','temporal_edge','attention','community','alias')),
			derived_id TEXT NOT NULL, agent_id TEXT NOT NULL,
			evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('memory','transcript','artifact','summary','attribute')),
			evidence_id TEXT NOT NULL,
			PRIMARY KEY(derived_kind,derived_id,evidence_kind,evidence_id)
		);
		INSERT INTO evidence_citations_v179 SELECT derived_kind,derived_id,agent_id,evidence_kind,evidence_id FROM evidence_citations;
		DROP TABLE evidence_citations;
		ALTER TABLE evidence_citations_v179 RENAME TO evidence_citations;
		CREATE INDEX idx_evidence_citations_reverse ON evidence_citations(agent_id,evidence_kind,evidence_id);
	`);
}

function partitionDreamingKeys(db: MigrationDb): void {
	for (const [table, constraint, key] of [
		["memory_head_entries", "PRIMARY KEY(agent_id, entry_id)", "agent_id,entry_id,COALESCE(compartment_id,0)"],
		[
			"dreaming_attention",
			"UNIQUE(agent_id, kind, subject_ref)",
			"agent_id,kind,subject_ref,COALESCE(compartment_id,0)",
		],
	]) {
		if (!table || !constraint || !key) throw new Error("Invalid Dreaming partition key");
		const index = `idx_${table}_partition`;
		if (db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(index)) continue;
		const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
		if (typeof schema !== "string") throw new Error("Missing Dreaming table");
		const expression =
			table === "memory_head_entries"
				? /,\s*PRIMARY KEY\s*\(\s*agent_id\s*,\s*entry_id\s*\)/i
				: /,\s*UNIQUE\s*\(\s*agent_id\s*,\s*kind\s*,\s*subject_ref\s*\)/i;
		const rewritten = schema.replace(expression, "");
		if (rewritten === schema) throw new Error(`Missing Dreaming legacy key: ${constraint}`);
		const objects = db
			.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL")
			.all(table);
		const temporary = `${table}_partition_v179`;
		const withIdentity =
			table === "memory_head_entries"
				? rewritten.replace(/(CREATE TABLE[^(]+\()/i, "$1id TEXT NOT NULL UNIQUE,")
				: rewritten;
		db.exec(
			withIdentity.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|[^\s(]+)/i, `CREATE TABLE ${temporary}`),
		);
		const columns = db
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.map((row) => String(row.name))
			.join(",");
		db.exec(
			table === "memory_head_entries"
				? `INSERT INTO ${temporary}(id,${columns}) SELECT lower(hex(randomblob(16))),${columns} FROM ${table}`
				: `INSERT INTO ${temporary}(${columns}) SELECT ${columns} FROM ${table}`,
		);
		db.exec(`DROP TABLE ${table}`);
		db.exec(`ALTER TABLE ${temporary} RENAME TO ${table}`);
		for (const object of objects) if (typeof object.sql === "string") db.exec(object.sql);
		db.exec(`CREATE UNIQUE INDEX ${index} ON ${table}(${key})`);
	}
}

function migrateMemoryHeadCitationKeys(db: MigrationDb): void {
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_head_revision_identity_citation'").get()) return;
	db.exec(`
		UPDATE evidence_citations SET evidence_id=(
			SELECT h.id FROM memory_head_revision_entries e JOIN memory_head_entries h
			ON h.agent_id=e.agent_id AND h.entry_id=e.entry_id AND h.compartment_id IS e.compartment_id
			WHERE e.agent_id=evidence_citations.agent_id AND json_array(e.revision,e.entry_id)=evidence_citations.derived_id
			AND h.entry_id=evidence_citations.evidence_id
		) WHERE derived_kind='head_revision' AND evidence_kind='attribute' AND EXISTS (
			SELECT 1 FROM memory_head_revision_entries e JOIN memory_head_entries h
			ON h.agent_id=e.agent_id AND h.entry_id=e.entry_id AND h.compartment_id IS e.compartment_id
			WHERE e.agent_id=evidence_citations.agent_id AND json_array(e.revision,e.entry_id)=evidence_citations.derived_id
			AND h.entry_id=evidence_citations.evidence_id
		);
		UPDATE evidence_citations SET derived_id=(
			SELECT json_array(e.revision_id,e.entry_id) FROM memory_head_revision_entries e
			WHERE e.agent_id=evidence_citations.agent_id AND json_array(e.revision,e.entry_id)=evidence_citations.derived_id
			AND e.revision_id IS NOT NULL
		) WHERE derived_kind='head_revision' AND EXISTS (
			SELECT 1 FROM memory_head_revision_entries e WHERE e.agent_id=evidence_citations.agent_id
			AND json_array(e.revision,e.entry_id)=evidence_citations.derived_id AND e.revision_id IS NOT NULL
		);
		UPDATE evidence_citations SET derived_id=(
			SELECT h.id FROM memory_head_entries h WHERE h.agent_id=evidence_citations.agent_id AND h.entry_id=evidence_citations.derived_id
		) WHERE derived_kind='head_entry' AND EXISTS (
			SELECT 1 FROM memory_head_entries h WHERE h.agent_id=evidence_citations.agent_id AND h.entry_id=evidence_citations.derived_id
		);
		DROP INDEX IF EXISTS idx_head_revision_citation;
		CREATE INDEX idx_head_revision_identity_citation ON memory_head_revision_entries(agent_id,json_array(revision_id,entry_id));
	`);
}
