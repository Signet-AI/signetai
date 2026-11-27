import {
	compartmentFor,
	classificationsForWrite,
	attempt,
	syncEmbeddingCompartment,
	COMPARTMENT_TABLES,
	backfillEvidenceCitations,
	type MigrationDb,
} from "@signet/core";
import type { WriteAuthor } from "./auth/audit-owner";
import type {
	ClassificationActor,
	ClassificationRequest,
	ClassificationTarget,
	ClassificationPrincipal,
} from "./classifications";
import { z } from "zod";
import { prepareTypedStatement, type ReadDb, type WriteDb } from "./db-accessor";
import { inFlightClassificationSql, readScopeSql, type AudienceSubject, type ReadScope } from "./read-scope";

type Row = Record<string, unknown>;
interface ContentRow {
	table: string;
	row: Row;
	key: string;
	kind: string | null;
}
const DERIVED: Readonly<Record<string, string>> = {
	alias: "entity_aliases",
	attribute: "entity_attributes",
	memory: "memories",
	dependency: "entity_dependencies",
	entity: "entities",
	aspect: "entity_aspects",
	assertion: "epistemic_assertions",
	head_entry: "memory_head_entries",
	reflection: "daily_reflections",
	temporal_edge: "temporal_edges",
	attention: "dreaming_attention",
	contradiction: "ontology_contradictions",
	head_revision: "memory_head_revision_entries",
	proposal: "ontology_proposals",
	telemetry: "memory_search_telemetry",
	community: "entity_communities",
};
function id(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
function transaction<T>(db: MigrationDb, fn: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
function text(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}
function matches(
	db: MigrationDb,
	table: "classification_audience" | "classification_appliers",
	classification: string,
	subject: AudienceSubject,
): boolean {
	if (subject.local) return true;
	if (!subject.userId) return false;
	return (
		db
			.prepare(
				`SELECT 1 FROM ${table} p WHERE p.classification_id=? AND ((p.principal_kind='user' AND p.principal_id=?) OR (p.principal_kind='group' AND p.principal_id IN (SELECT group_id FROM group_members WHERE user_id=?))) LIMIT 1`,
			)
			.get(classification, subject.userId, subject.userId) != null
	);
}
const audienceCache = new WeakMap<MigrationDb, { version: number; users: Map<string, number[]> }>();
function readable(db: MigrationDb, subject: AudienceSubject): number[] {
	if (!subject.userId) return [];
	const versionRow = db.prepare("SELECT version FROM classification_access_version WHERE id=1").get();
	if (typeof versionRow?.version !== "number") throw new Error("classification_access_version_missing");
	let cache = audienceCache.get(db);
	if (!cache || cache.version !== versionRow.version) {
		cache = { version: versionRow.version, users: new Map() };
		audienceCache.set(db, cache);
	}
	const hit = cache.users.get(subject.userId);
	if (hit) return [...hit];
	const result = db
		.prepare(
			`SELECT c.id FROM compartments c WHERE NOT EXISTS (SELECT 1 FROM compartment_members cm WHERE cm.compartment_id=c.id AND NOT EXISTS(SELECT 1 FROM classification_audience a WHERE a.classification_id=cm.classification_id AND ((a.principal_kind='user' AND a.principal_id=?) OR (a.principal_kind='group' AND a.principal_id IN (SELECT group_id FROM group_members WHERE user_id=?))))) ORDER BY c.id`,
		)
		.all(subject.userId, subject.userId)
		.flatMap((r) => (typeof r.id === "number" ? [r.id] : []));
	if (cache.users.size >= 1000) cache.users.clear();
	cache.users.set(subject.userId, result);
	return [...result];
}
const DEFINITION_AUDIENCE =
	"(?=1 OR EXISTS(SELECT 1 FROM classification_audience a WHERE a.classification_id=c.id AND ((a.principal_kind='user' AND a.principal_id=?) OR (a.principal_kind='group' AND a.principal_id IN (SELECT group_id FROM group_members WHERE user_id=?)))))";
function definition(db: MigrationDb, classification: string, actor: ClassificationActor): Row {
	const row = db
		.prepare(`SELECT c.* FROM classifications c WHERE c.id=? AND ${DEFINITION_AUDIENCE}`)
		.get(classification, Number(actor.compliance || actor.local), actor.userId, actor.userId);
	if (!row) throw new Error("not_found");
	return row;
}
function definitionView(db: MigrationDb, row: Row, actor: ClassificationActor, includePrincipals: boolean): Row {
	if (!includePrincipals || (!actor.compliance && !actor.local)) return row;
	const values = (table: "classification_audience" | "classification_appliers") =>
		db
			.prepare(
				`SELECT p.principal_kind AS kind,p.principal_id AS id,COALESCE(u.display_name,g.name,p.principal_id) AS displayName FROM ${table} p LEFT JOIN users u ON p.principal_kind='user' AND u.id=p.principal_id LEFT JOIN groups g ON p.principal_kind='group' AND g.id=p.principal_id WHERE p.classification_id=? ORDER BY p.principal_kind,p.principal_id LIMIT 1000`,
			)
			.all(text(row.id));
	return { ...row, audience: values("classification_audience"), appliers: values("classification_appliers") };
}
function compliance(actor: ClassificationActor): void {
	if (!actor.compliance && !actor.local) throw new Error("permission");
}
function audit(
	db: MigrationDb,
	actor: ClassificationActor,
	action: string,
	target: ClassificationTarget | null,
	classification: string,
	detail: unknown,
	outcome: "ok" | "failed" = "ok",
): void {
	db.prepare(
		`INSERT INTO audit_events(id,at,actor_user_id,actor_credential,action,target_kind,target_id,agent_id,outcome,detail_json) VALUES (?,?,?,?,?,?,?,?,?,?)`,
	).run(
		id("aud"),
		new Date().toISOString(),
		actor.userId,
		actor.credential,
		action,
		target?.kind ?? "classification",
		target?.id ?? classification,
		target?.agentId ?? null,
		outcome,
		JSON.stringify(detail),
	);
}
function principals(
	db: MigrationDb,
	table: "classification_audience" | "classification_appliers",
	classification: string,
	values: readonly ClassificationPrincipal[],
): void {
	if (values.length > 1000) throw new Error("too_many_principals");
	for (const p of values)
		if (!db.prepare(`SELECT 1 FROM ${p.kind === "user" ? "users" : "groups"} WHERE id=?`).get(p.id))
			throw new Error("principal_not_found");
	db.prepare(`DELETE FROM ${table} WHERE classification_id=?`).run(classification);
	for (const p of values) db.prepare(`INSERT OR IGNORE INTO ${table} VALUES (?,?,?)`).run(classification, p.kind, p.id);
}
interface TableInfo {
	columns: ReadonlySet<string>;
	select: string;
	key: string;
	kind: string | null;
}
const metadataCache = new WeakMap<MigrationDb, Map<string, TableInfo>>();
function tableInfo(db: MigrationDb, table: string): TableInfo | undefined {
	let cache = metadataCache.get(db);
	if (!cache) {
		cache = new Map();
		metadataCache.set(db, cache);
	}
	const hit = cache.get(table);
	if (hit) return hit;
	if (!COMPARTMENT_TABLES.some((name) => name === table)) throw new Error("invalid_content_table");
	const columns = new Set(
		db
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.flatMap((r) => (typeof r.name === "string" ? [r.name] : [])),
	);
	if (!columns.size) return;
	const key =
		table === "session_transcripts"
			? "session_key"
			: table === "memory_artifacts"
				? "source_path"
				: table === "memory_head_revision_entries"
					? "json_array(revision_id,entry_id)"
					: table === "session_recall_events"
						? "json_array(session_key,context_epoch,item_kind,item_id)"
						: columns.has("id")
							? "id"
							: columns.has("entry_id")
								? "entry_id"
								: "rowid";
	const selected = [
		"id",
		"entry_id",
		"revision",
		"context_epoch",
		"item_kind",
		"item_id",
		"session_key",
		"session_id",
		"source_path",
		"source_id",
		"source_type",
		"agent_id",
		"author_user_id",
		"speaker_user_id",
		"compartment_id",
		"pass_id",
		"dreaming_pass_id",
		"proposal_id",
		"memory_id",
		"entity_id",
		"derived_memory_id",
		"source_kind",
		"source_entity_id",
		"target_entity_id",
		"project",
		"visibility",
	].filter((c) => columns.has(c));
	const kind =
		table === "session_transcripts"
			? "transcript"
			: table === "memory_artifacts"
				? "artifact"
				: table === "session_summaries"
					? "summary"
					: table === "session_recall_events"
						? "telemetry"
						: (Object.entries(DERIVED).find(([, t]) => t === table)?.[0] ?? null);
	const info = {
		columns,
		key,
		kind,
		select: `rowid AS _classification_rowid,${key} AS _classification_key${table === "cross_agent_messages" ? ",from_agent_id AS agent_id,from_session_key AS session_key" : ""}${selected.length ? "," + selected.join(",") : ""}`,
	};
	cache.set(table, info);
	return info;
}
function contentRows(
	db: MigrationDb,
	table: string,
	where: string,
	args: readonly unknown[],
	limit?: number,
): ContentRow[] {
	const info = tableInfo(db, table);
	if (!info) return [];
	return db
		.prepare(
			`SELECT ${info.select} FROM ${table} WHERE (${table === "cross_agent_messages" ? where.replace(/\bagent_id\b/g, "from_agent_id").replace(/\bsession_key\b/g, "from_session_key") : where})${table === "entities" ? " AND person_user_id IS NULL" : ""}${limit === undefined ? "" : " ORDER BY rowid LIMIT ?"}`,
		)
		.all(...args, ...(limit === undefined ? [] : [limit]))
		.map((row) => ({ table, row, key: String(row._classification_key), kind: info.kind }));
}
function checkpointOwners(db: MigrationDb, key: unknown): string[] {
	return db
		.prepare(
			"SELECT agent_id FROM session_transcripts WHERE session_key=? UNION SELECT agent_id FROM session_claims WHERE session_key=?",
		)
		.all(key, key)
		.flatMap((r) => (typeof r.agent_id === "string" ? [r.agent_id] : []));
}
function childParentRefs(item: ContentRow): readonly (readonly [string, string, unknown])[] {
	if (item.table === "memory_entity_mentions")
		return [
			["memories", "id", item.row.memory_id],
			["entities", "id", item.row.entity_id],
		];
	if (item.table === "memory_history") return [["memories", "id", item.row.memory_id]];
	if (item.table === "relations")
		return [
			["entities", "id", item.row.source_entity_id],
			["entities", "id", item.row.target_entity_id],
		];
	if (item.table === "derived_memory_sources") {
		const sourceTable =
			item.row.source_kind === "ontology_claim"
				? "entity_attributes"
				: item.row.source_kind === "memory"
					? "memories"
					: item.row.source_kind === "transcript"
						? "session_transcripts"
						: item.row.source_kind === "artifact"
							? "memory_artifacts"
							: item.row.source_kind === "summary"
								? "session_summaries"
								: null;
		return [
			["memories", "id", item.row.derived_memory_id],
			...(sourceTable
				? [
						[
							sourceTable,
							sourceTable === "session_transcripts"
								? "session_key"
								: sourceTable === "memory_artifacts"
									? "source_path"
									: "id",
							item.row.source_id,
						] as const,
					]
				: []),
		];
	}
	return [];
}
function contextFor(db: MigrationDb, initial: readonly ContentRow[]): ContentRow[] {
	const result = new Map(initial.map((r) => [`${r.table}:${r.row._classification_rowid}`, r]));
	for (const item of result.values()) {
		const agent = item.row.agent_id;
		const memory =
			item.table === "memory_hints"
				? item.row.memory_id
				: item.row.source_type === "memory"
					? item.row.source_id
					: null;
		const lookups: readonly (readonly [string, string, unknown])[] = [
			...childParentRefs(item),
			["memories", "id", memory],
			["memory_artifacts", "source_path", item.row.source_id],
			["session_transcripts", "session_key", item.row.source_id],
		];
		for (const [table, key, value] of lookups)
			if (typeof value === "string")
				for (const parent of contentRows(
					db,
					table,
					`${key}=?${agent == null ? "" : " AND agent_id=?"}`,
					agent == null ? [value] : [value, agent],
				))
					result.set(`${parent.table}:${parent.row._classification_rowid}`, parent);
	}
	return [...result.values()];
}
function covers(db: MigrationDb, target: ClassificationTarget, item: ContentRow, rows: readonly ContentRow[]): boolean {
	const r = item.row;
	if (item.table === "session_checkpoints" && r.agent_id == null) {
		if (!checkpointOwners(db, r.session_key).includes(target.agentId)) return false;
		return (
			target.kind === "agent" ||
			(target.kind === "session" && [target.id, `session:${target.id}`].includes(String(r.session_key))) ||
			(target.kind === "source" &&
				db
					.prepare("SELECT 1 FROM session_transcripts WHERE agent_id=? AND session_key=? AND source_id=?")
					.get(target.agentId, r.session_key, target.id) != null)
		);
	}
	const parentMemory =
		(item.table === "embeddings" || item.table === "embeddings_staging") &&
		r.agent_id == null &&
		r.source_type === "memory"
			? rows.find((p) => p.table === "memories" && p.key === r.source_id)
			: undefined;
	if ((r.agent_id ?? parentMemory?.row.agent_id) !== target.agentId) return false;
	if (target.kind === "agent") return true;
	if (target.kind === "memory") return item.table === "memories" && item.key === target.id;
	if (target.kind === "session") {
		const keys = [target.id, `session:${target.id}`];
		return (
			keys.includes(String(r.session_key ?? r.session_id)) ||
			(item.table === "memories" &&
				(keys.includes(String(r.source_id)) ||
					rows.some(
						(p) =>
							p.row.agent_id === target.agentId &&
							p.key === r.source_id &&
							["transcript", "artifact", "summary"].includes(p.kind ?? "") &&
							keys.includes(String(p.row.session_key ?? p.row.session_id)),
					)))
		);
	}
	return (
		r.source_id === target.id ||
		((item.table === "embeddings" || item.table === "embeddings_staging") &&
			typeof r.source_id === "string" &&
			r.source_id.startsWith(`${target.id}:`)) ||
		(item.table === "memories" &&
			rows.some((p) => p.row.agent_id === target.agentId && p.key === r.source_id && p.row.source_id === target.id))
	);
}
function passLabels(db: MigrationDb, item: ContentRow): string[] {
	let pass = item.table === "dreaming_passes" ? item.key : text(item.row.pass_id ?? item.row.dreaming_pass_id);
	const proposalId = text(item.row.proposal_id);
	if (!pass && proposalId && tableInfo(db, "ontology_proposals")?.columns.has("dreaming_pass_id")) {
		const proposal = db
			.prepare("SELECT dreaming_pass_id FROM ontology_proposals WHERE id=? AND agent_id=?")
			.get(proposalId, item.row.agent_id);
		pass = text(proposal?.dreaming_pass_id);
	}
	if (!pass) return [];
	return db
		.prepare(
			"SELECT cm.classification_id FROM dreaming_passes p JOIN compartment_members cm ON cm.compartment_id=p.compartment_id WHERE p.id=? AND (p.agent_id=? OR instr(','||COALESCE(NULLIF(p.scope_key,''),p.agent_id)||',',','||?||',')>0)",
		)
		.all(pass, item.row.agent_id, item.row.agent_id)
		.flatMap((r) => (typeof r.classification_id === "string" ? [r.classification_id] : []));
}
function members(db: MigrationDb, c: unknown): string[] {
	return typeof c === "number"
		? db
				.prepare("SELECT classification_id FROM compartment_members WHERE compartment_id=?")
				.all(c)
				.flatMap((r) => (typeof r.classification_id === "string" ? [r.classification_id] : []))
		: [];
}
function effective(db: MigrationDb, item: ContentRow, rows: readonly ContentRow[]): Set<string> {
	const agents =
		typeof item.row.agent_id === "string"
			? [item.row.agent_id]
			: item.table === "session_checkpoints"
				? checkpointOwners(db, item.row.session_key)
				: rows
						.filter((p) => p.table === "memories" && p.key === item.row.source_id)
						.flatMap((p) => (typeof p.row.agent_id === "string" ? [p.row.agent_id] : []));
	const keys = new Set<unknown>([item.key, item.row.session_key, item.row.session_id, item.row.source_id]);
	if (typeof item.row.source_id === "string")
		for (const p of rows)
			if (p.row.agent_id === item.row.agent_id && p.key === item.row.source_id) {
				keys.add(p.row.source_id);
				keys.add(p.row.session_key);
				keys.add(p.row.session_id);
			}
	if (item.table === "session_checkpoints")
		for (const transcript of db
			.prepare("SELECT source_id FROM session_transcripts WHERE session_key=? AND (agent_id=? OR ? IS NULL)")
			.all(item.row.session_key, item.row.agent_id, item.row.agent_id))
			keys.add(transcript.source_id);
	const strings = [...keys].flatMap((k) =>
		typeof k === "string" ? [k, k.startsWith("session:") ? k.slice(8) : `session:${k}`] : [],
	);
	const labels = new Set(passLabels(db, item));
	for (const agent of agents)
		for (const a of db
			.prepare(
				`SELECT * FROM classification_assignments WHERE agent_id=? AND (target_kind='agent' OR target_id IN (${strings.map(() => "?").join(",") || "NULL"}) OR (target_kind='source' AND substr(?,1,length(target_id)+1)=target_id||':'))`,
			)
			.all(agent, ...strings, item.row.source_id ?? null)) {
			if (
				typeof a.classification_id === "string" &&
				(a.target_kind === "memory" ||
					a.target_kind === "session" ||
					a.target_kind === "source" ||
					a.target_kind === "agent") &&
				typeof a.target_id === "string" &&
				covers(db, { kind: a.target_kind, id: a.target_id, agentId: agent }, item, rows)
			)
				labels.add(a.classification_id);
		}
	return labels;
}
function canActAs(db: MigrationDb, agent: Row, actor: ClassificationActor): boolean {
	if (actor.local || actor.compliance) return true;
	if (!actor.userId) return false;
	if (agent.kind === "personal") return agent.owner_user_id === actor.userId;
	if (agent.kind === "team")
		return (
			db
				.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?")
				.get(agent.owner_group_id, actor.userId) != null
		);
	return agent.kind === "legacy" || agent.kind === "organization";
}
function targetRelations(target: ClassificationTarget): readonly (readonly [string, string])[] {
	if (target.kind === "memory") return [["memories", "id"]];
	if (target.kind === "session") return [["session_transcripts", "session_key"]];
	if (target.kind === "source")
		return [
			["memory_artifacts", "source_id"],
			["session_transcripts", "source_id"],
		];
	return [];
}
function authorize(
	db: MigrationDb,
	target: ClassificationTarget,
	classification: string,
	actor: ClassificationActor,
	remove: boolean,
	previewOnly = false,
): void {
	const def = definition(db, classification, actor);
	const forbidden = (message: string) => {
		throw new Error(actor.local || actor.compliance ? message : "not_found");
	};
	if (actor.boundAgentId !== null && actor.boundAgentId !== target.agentId) forbidden("agent_binding_conflict");
	const agent = db.prepare("SELECT * FROM agents WHERE id=?").get(target.agentId);
	if (!agent || (!remove && agent.archived_at != null) || (target.kind === "agent" && target.id !== target.agentId))
		throw new Error("not_found");
	if (!canActAs(db, agent, actor)) throw new Error("not_found");
	const relations = targetRelations(target);
	if (
		target.kind !== "agent" &&
		!relations.some(([table, key]) =>
			db.prepare(`SELECT 1 FROM ${table} WHERE agent_id=? AND ${key}=? LIMIT 1`).get(target.agentId, target.id),
		)
	)
		throw new Error("not_found");
	if (actor.allowedProjects !== null) {
		if (target.kind === "agent") forbidden("project_not_permitted");
		const projects = actor.allowedProjects;
		for (const [table, key] of relations)
			if (
				!tableInfo(db, table)?.columns.has("project") ||
				db
					.prepare(
						`SELECT 1 FROM ${table} WHERE agent_id=? AND ${key}=? AND (project IS NULL OR ${projects.length ? `project NOT IN (${projects.map(() => "?").join(",")})` : "1"}) LIMIT 1`,
					)
					.get(target.agentId, target.id, ...projects)
			)
				forbidden("project_not_permitted");
	}
	if (!actor.compliance && !actor.local && target.kind !== "agent") {
		const scope: ReadScope = {
			reach: { kind: "all" },
			...visibility(db, actor),
			projects: actor.allowedProjects,
		};
		if (
			!relations.some(([table, key]) => {
				const clause = readScopeSql("r", scope, {
					...scopeColumns(db, table),
					visibility: tableInfo(db, table)?.columns.has("visibility") ? "visibility" : null,
				});
				return (
					db
						.prepare(`SELECT 1 FROM ${table} r WHERE r.agent_id=? AND r.${key}=? ${clause.sql} LIMIT 1`)
						.get(target.agentId, target.id, ...clause.args) != null
				);
			})
		)
			throw new Error("not_found");
	}
	if (previewOnly) return;
	if (!remove && def.archived_at) throw new Error("archived_classification");
	if (remove) {
		compliance(actor);
		return;
	}
	if (actor.compliance || actor.local) return;
	const personalOwner = agent.kind === "personal" && agent.owner_user_id === actor.userId;
	const teamOwner =
		agent.kind === "team" &&
		db
			.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND role='owner'")
			.get(agent.owner_group_id, actor.userId) != null;
	const author =
		relations.length > 0 &&
		relations.every(
			([table, key]) =>
				!db
					.prepare(
						`SELECT 1 FROM ${table} WHERE agent_id=? AND ${key}=? AND ${table === "session_transcripts" ? "speaker_user_id" : "author_user_id"} IS NOT ? LIMIT 1`,
					)
					.get(target.agentId, target.id, actor.userId),
		);
	if (!personalOwner && !teamOwner && !author) throw new Error("not_found");
	if (
		db.prepare("SELECT 1 FROM classification_appliers WHERE classification_id=? LIMIT 1").get(classification) &&
		!matches(db, "classification_appliers", classification, actor)
	)
		throw new Error("permission");
}
const COPY_KINDS = new Set([
	"contradiction",
	"head_revision",
	"proposal",
	"telemetry",
	"community",
	"temporal_edge",
	"attention",
]);
function referencedRows(db: MigrationDb, kind: unknown, key: unknown, agent: unknown): ContentRow[] {
	if (typeof kind !== "string" || typeof key !== "string" || typeof agent !== "string") return [];
	const tables =
		kind === "telemetry"
			? ["memory_search_telemetry", "session_recall_events"]
			: [
					DERIVED[kind] ??
						{ transcript: "session_transcripts", artifact: "memory_artifacts", summary: "session_summaries" }[kind],
				];
	return tables.flatMap((table) => {
		if (!table) return [];
		const info = tableInfo(db, table);
		return info ? contentRows(db, table, `${info.key}=? AND agent_id=?`, [key, agent]) : [];
	});
}
function publishCompartment(db: MigrationDb, item: ContentRow, compartment: number | null): void {
	if (item.table === "embeddings" || item.table === "embeddings_staging")
		db.prepare(`UPDATE ${item.table} SET compartment_id=?,agent_id=? WHERE rowid=?`).run(
			compartment,
			item.row.agent_id ?? null,
			item.row._classification_rowid,
		);
	else
		db.prepare(`UPDATE ${item.table} SET compartment_id=? WHERE rowid=?`).run(
			compartment,
			item.row._classification_rowid,
		);
	if (item.table === "embeddings" || item.table === "embeddings_staging")
		syncEmbeddingCompartment(db, item.table, item.key);
}
const CLASSIFICATION_TURN_ROWS = 1024;
const CLASSIFICATION_TURN_MS = 20;
class ClassificationTurnFull extends Error {
	constructor() {
		super("classification_fanout_budget_exceeded");
	}
}
function recompute(db: MigrationDb, selected: readonly ContentRow[], fanout = true, rowBudget = Infinity): number {
	const boundedRows = (table: string, where: string, args: readonly unknown[]) =>
		contentRows(db, table, where, args, Number.isFinite(rowBudget) ? rowBudget + 1 : undefined);
	const citationRows = (sql: string, args: readonly unknown[]): Row[] => {
		const limit = Number.isFinite(rowBudget) ? [rowBudget + 1] : [];
		const rows = db.prepare(`${sql}${limit.length ? " LIMIT ?" : ""}`).all(...args, ...limit);
		if (rows.length > rowBudget) throw new ClassificationTurnFull();
		return rows;
	};
	const initial = contextFor(db, selected),
		all = new Map(initial.map((r) => [`${r.table}:${r.row._classification_rowid}`, r]));
	const changed = new Set(selected.map((r) => `${r.table}:${r.row._classification_rowid}`));
	const add = (items: readonly ContentRow[], change: boolean) => {
		for (const item of items) {
			const key = `${item.table}:${item.row._classification_rowid}`;
			if (!all.has(key)) all.set(key, item);
			if (change) changed.add(key);
			if (changed.size > rowBudget || all.size > rowBudget * 4) throw new ClassificationTurnFull();
		}
	};
	if (fanout)
		for (const item of selected)
			if (["memory", "transcript", "artifact", "summary"].includes(item.kind ?? ""))
				for (const link of citationRows(
					"SELECT derived_kind,derived_id FROM evidence_citations WHERE agent_id=? AND evidence_kind=? AND evidence_id=?",
					[item.row.agent_id, item.kind, item.key],
				))
					add(referencedRows(db, link.derived_kind, link.derived_id, item.row.agent_id), true);
	const expanded = new Set<string>();
	for (;;) {
		const next = [...changed].filter((key) => !expanded.has(key));
		if (!next.length) break;
		for (const key of next) {
			expanded.add(key);
			const item = all.get(key);
			if (!item) continue;
			if (item.table === "entity_attributes" && typeof item.row.memory_id === "string")
				add(referencedRows(db, "memory", item.row.memory_id, item.row.agent_id), true);
			if (item.kind)
				for (const link of citationRows(
					"SELECT derived_kind,derived_id FROM evidence_citations WHERE agent_id=? AND evidence_kind IN ('memory','transcript','artifact','summary','attribute') AND evidence_id=? AND derived_kind IN ('contradiction','head_revision','proposal','telemetry','temporal_edge','attention')",
					[item.row.agent_id, item.key],
				))
					add(referencedRows(db, link.derived_kind, link.derived_id, item.row.agent_id), true);
			if (item.table === "memories") {
				for (const table of ["memory_entity_mentions", "memory_history"])
					add(boundedRows(table, "agent_id=? AND memory_id=?", [item.row.agent_id, item.key]), true);
				add(
					boundedRows("derived_memory_sources", "agent_id=? AND derived_memory_id=?", [item.row.agent_id, item.key]),
					true,
				);
			}
			if (item.table === "entities") {
				add(boundedRows("memory_entity_mentions", "agent_id=? AND entity_id=?", [item.row.agent_id, item.key]), true);
				add(
					boundedRows("relations", "agent_id=? AND (source_entity_id=? OR target_entity_id=?)", [
						item.row.agent_id,
						item.key,
						item.key,
					]),
					true,
				);
			}
			if (["memory", "transcript", "artifact", "summary", "attribute"].includes(item.kind ?? ""))
				add(
					boundedRows("derived_memory_sources", "agent_id=? AND source_kind=? AND source_id=?", [
						item.row.agent_id,
						item.kind === "attribute" ? "ontology_claim" : item.kind,
						item.key,
					]),
					true,
				);
			if (item.kind === "memory") {
				add(boundedRows("memory_hints", "agent_id=? AND memory_id=?", [item.row.agent_id, item.key]), true);
				for (const store of ["embeddings", "embeddings_staging"])
					add(
						boundedRows(store, "(agent_id=? OR agent_id IS NULL) AND source_type='memory' AND source_id=?", [
							item.row.agent_id,
							item.key,
						]),
						true,
					);
			} else if (item.kind === "artifact" || item.kind === "transcript")
				for (const store of ["embeddings", "embeddings_staging"])
					add(boundedRows(store, "agent_id=? AND source_id=?", [item.row.agent_id, item.key]), true);
		}
	}
	for (const item of [...all.values()])
		if (changed.has(`${item.table}:${item.row._classification_rowid}`) && item.kind)
			for (const link of citationRows(
				"SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind=? AND derived_id=? AND agent_id=?",
				[item.kind, item.key, item.row.agent_id],
			))
				add(referencedRows(db, link.evidence_kind, link.evidence_id, item.row.agent_id), false);
	add(contextFor(db, [...all.values()]), false);
	const rows = [...all.values()],
		labels = new Map<string, Set<string>>();
	for (const item of rows) {
		if (!item.table.startsWith("embeddings") || item.row.agent_id != null) continue;
		const parents = rows.filter((parent) => parent.kind === "memory" && parent.key === item.row.source_id);
		const owners = new Set(parents.map((parent) => text(parent.row.agent_id)).filter((agent) => agent !== null));
		if (owners.size !== 1) throw new Error("classification_ownership_unresolved");
		item.row.agent_id = [...owners][0];
	}
	const references = new Map<string, ContentRow[]>(),
		materialized = new Map<string, ContentRow[]>();
	for (const row of rows) {
		const identity = JSON.stringify([row.row.agent_id, row.key]),
			values = references.get(identity) ?? [];
		values.push(row);
		references.set(identity, values);
		if (row.table === "entity_attributes" && typeof row.row.memory_id === "string") {
			const key = JSON.stringify([row.row.agent_id, row.row.memory_id]),
				sources = materialized.get(key) ?? [];
			sources.push(row);
			materialized.set(key, sources);
		}
	}
	const links = new Map<string, Row[]>();
	const citations = (item: ContentRow): Row[] => {
		if (!item.kind) return [];
		const key = `${item.table}:${item.row._classification_rowid}`,
			cached = links.get(key);
		if (cached) return cached;
		const result = citationRows(
			"SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind=? AND derived_id=? AND agent_id=?",
			[item.kind, item.key, item.row.agent_id],
		);
		links.set(key, result);
		return result;
	};
	const sources = (item: ContentRow, link: Row) =>
		(references.get(JSON.stringify([item.row.agent_id, link.evidence_id])) ?? []).filter(
			(p) => p.kind === link.evidence_kind || COPY_KINDS.has(item.kind ?? ""),
		);

	const compile = (item: ContentRow, stack: Set<string>): Set<string> => {
		const key = `${item.table}:${item.row._classification_rowid}`;
		const cached = labels.get(key);
		if (cached) return cached;
		if (stack.has(key)) return effective(db, item, rows);
		const next = new Set(stack);
		next.add(key);
		const result = effective(db, item, rows);
		const parent = (p: ContentRow) => {
			const k = `${p.table}:${p.row._classification_rowid}`;
			return changed.has(k) ? compile(p, next) : new Set(members(db, p.row.compartment_id));
		};
		if (item.kind)
			for (const link of citations(item)) {
				for (const p of sources(item, link))
					if (
						!(
							COPY_KINDS.has(item.kind) &&
							COPY_KINDS.has(p.kind ?? "") &&
							changed.has(`${p.table}:${p.row._classification_rowid}`)
						)
					)
						for (const label of parent(p)) result.add(label);
			}
		const inherited =
			item.table === "memories"
				? (materialized.get(JSON.stringify([item.row.agent_id, item.key])) ?? [])
				: item.table === "memory_hints" || item.table.startsWith("embeddings")
					? (
							references.get(JSON.stringify([item.row.agent_id, item.row.memory_id ?? item.row.source_id])) ?? []
						).filter((p) => ["memory", "artifact", "transcript"].includes(p.kind ?? ""))
					: [];
		for (const p of inherited) for (const label of parent(p)) result.add(label);
		for (const [table, column, value] of childParentRefs(item))
			for (const p of rows.filter(
				(row) => row.table === table && row.row.agent_id === item.row.agent_id && row.row[column] === value,
			))
				for (const label of parent(p)) result.add(label);
		labels.set(key, result);
		return result;
	};
	const ordered = rows
		.filter((item) => changed.has(`${item.table}:${item.row._classification_rowid}`))
		.sort(
			(a, b) =>
				Number(a.table === "memory_hints" || a.table.startsWith("embeddings")) -
				Number(b.table === "memory_hints" || b.table.startsWith("embeddings")),
		);
	for (const item of ordered) compile(item, new Set());
	const dependents = new Map<string, string[]>();
	for (const item of ordered)
		if (COPY_KINDS.has(item.kind ?? ""))
			for (const link of citations(item))
				for (const parent of sources(item, link)) {
					const source = `${parent.table}:${parent.row._classification_rowid}`,
						target = `${item.table}:${item.row._classification_rowid}`,
						children = dependents.get(source) ?? [];
					children.push(target);
					dependents.set(source, children);
				}
	const queue = [...changed];
	for (let i = 0; i < queue.length; i++) {
		const source = queue[i];
		if (source === undefined) continue;
		for (const target of dependents.get(source) ?? []) {
			const child = labels.get(target);
			if (!child) continue;
			let updated = false;
			for (const label of labels.get(source) ?? []) {
				if (!child.has(label)) {
					child.add(label);
					updated = true;
				}
			}
			if (updated) queue.push(target);
		}
	}
	for (const item of ordered)
		publishCompartment(
			db,
			item,
			compartmentFor(db, [...(labels.get(`${item.table}:${item.row._classification_rowid}`) ?? [])]),
		);
	return ordered.length;
}
const cursorSchema = z.object({
	table: z.number().int().min(0).max(COMPARTMENT_TABLES.length),
	rowid: z.number().int().min(0),
	updated: z.number().int().min(0),
});
type Cursor = z.infer<typeof cursorSchema>;
function batch(
	db: MigrationDb,
	agentId: string | undefined,
	cursor: Cursor,
	limit = 2000,
): { rows: ContentRow[]; cursor: Cursor; done: boolean } {
	const rows: ContentRow[] = [];
	let table = cursor.table,
		rowid = cursor.rowid;
	while (table < COMPARTMENT_TABLES.length && rows.length < limit) {
		const name = COMPARTMENT_TABLES[table];
		if (!name) break;
		const info = tableInfo(db, name);
		if (!info) {
			table++;
			rowid = 0;
			continue;
		}
		const scope =
			agentId === undefined
				? "1"
				: name === "session_checkpoints"
					? "(agent_id=? OR (agent_id IS NULL AND session_key IN (SELECT session_key FROM session_transcripts WHERE agent_id=? UNION SELECT session_key FROM session_claims WHERE agent_id=?)))"
					: name === "cross_agent_messages"
						? "from_agent_id=?"
						: info.columns.has("agent_id")
							? "agent_id=?"
							: "0";
		const args =
			agentId === undefined
				? []
				: name === "session_checkpoints"
					? [agentId, agentId, agentId]
					: name === "cross_agent_messages" || info.columns.has("agent_id")
						? [agentId]
						: [];
		const page = contentRows(db, name, `rowid>? AND ${scope}`, [rowid, ...args], limit - rows.length);
		rows.push(...page);
		const last = page.at(-1)?.row._classification_rowid;
		if (typeof last === "number") rowid = last;
		if (page.length === 0 || rows.length < limit) {
			table++;
			rowid = 0;
		}
	}
	return { rows, cursor: { ...cursor, table, rowid }, done: table >= COMPARTMENT_TABLES.length };
}
function scopeColumns(db: MigrationDb, table: string) {
	const columns = tableInfo(db, table)?.columns;
	return {
		memory:
			table === "memories"
				? "id"
				: columns?.has("memory_id")
					? "memory_id"
					: table.startsWith("embeddings")
						? "source_id"
						: null,
		session: columns?.has("session_key")
			? "session_key"
			: columns?.has("session_id")
				? "session_id"
				: table === "memories"
					? "source_id"
					: null,
		source: columns?.has("source_id") ? "source_id" : null,
	};
}
function visibleCount(db: MigrationDb, rows: readonly ContentRow[], scope: ReadScope): number {
	let count = 0;
	for (const table of new Set(rows.map((r) => r.table))) {
		const info = tableInfo(db, table);
		if (!info?.columns.has("agent_id") || (scope.projects !== null && !info.columns.has("project"))) continue;
		const clause = readScopeSql("r", scope, {
			...scopeColumns(db, table),
			visibility: info.columns.has("visibility") ? "visibility" : null,
			checkpoint: table === "session_checkpoints",
		});
		const ids = rows.filter((r) => r.table === table).map((r) => r.row._classification_rowid);
		for (let start = 0; start < ids.length; start += 500) {
			const chunk = ids.slice(start, start + 500),
				row = db
					.prepare(`SELECT count(*) n FROM ${table} r WHERE rowid IN (${chunk.map(() => "?").join(",")}) ${clause.sql}`)
					.get(...chunk, ...clause.args);
			if (typeof row?.n === "number") count += row.n;
		}
	}
	return count;
}
function preview(
	db: MigrationDb,
	target: ClassificationTarget,
	scope: ReadScope,
): { evidence: number; derived: number } {
	let cursor: Cursor = { table: 0, rowid: 0, updated: 0 },
		evidence = 0,
		derived = 0;
	for (;;) {
		const page = batch(db, target.agentId, cursor),
			context = contextFor(db, page.rows),
			selected = page.rows.filter((r) => covers(db, target, r, context));
		evidence += visibleCount(
			db,
			selected.filter((r) => ["memory", "transcript", "artifact", "summary"].includes(r.kind ?? "")),
			scope,
		);
		const related = new Map<string, ContentRow>();
		for (const item of selected)
			if (item.kind)
				for (const link of db
					.prepare(
						"SELECT derived_kind,derived_id FROM evidence_citations WHERE agent_id=? AND evidence_kind=? AND evidence_id=?",
					)
					.all(item.row.agent_id, item.kind, item.key))
					for (const row of referencedRows(db, link.derived_kind, link.derived_id, item.row.agent_id))
						related.set(`${row.table}:${row.row._classification_rowid}`, row);
		derived += visibleCount(db, [...related.values()], scope);
		if (page.done) break;
		cursor = page.cursor;
	}
	return { evidence, derived };
}
const enqueuedSchema = z.object({
	op: z.literal("enqueue"),
	id: z.string(),
	remove: z.boolean(),
	target: z.object({ kind: z.enum(["memory", "session", "source", "agent"]), id: z.string(), agentId: z.string() }),
	actor: z.object({
		userId: z.string().nullable(),
		groupIds: z.array(z.string()),
		local: z.boolean(),
		compliance: z.boolean(),
		boundAgentId: z.string().nullable(),
		allowedProjects: z.array(z.string()).nullable(),
		credential: z.string(),
	}),
});
function executeJob(db: MigrationDb, jobId: string): unknown {
	const job = db.prepare("SELECT * FROM org_jobs WHERE id=? AND kind IN ('classify','unclassify')").get(jobId);
	if (!job || (job.status !== "pending" && job.status !== "running")) throw new Error("job_not_pending");
	const parsed = enqueuedSchema.safeParse(attempt(() => JSON.parse(String(job.params_json))));
	if (!parsed.success) throw new Error("invalid_job");
	const request = parsed.data;
	if (job.status === "pending") {
		const admitted = transaction(db, () => {
			if (
				db
					.prepare(
						"SELECT 1 FROM org_jobs WHERE kind IN ('classify','unclassify') AND status='running' AND json_extract(params_json,'$.target.agentId')=? AND id<>?",
					)
					.get(request.target.agentId, jobId)
			)
				return false;
			authorize(db, request.target, request.id, request.actor, request.remove);
			if (request.remove)
				db.prepare(
					"DELETE FROM classification_assignments WHERE target_kind=? AND target_id=? AND agent_id=? AND classification_id=?",
				).run(request.target.kind, request.target.id, request.target.agentId, request.id);
			else
				db.prepare("INSERT OR IGNORE INTO classification_assignments VALUES(?,?,?,?,?,?)").run(
					request.target.kind,
					request.target.id,
					request.target.agentId,
					request.id,
					request.actor.userId,
					new Date().toISOString(),
				);
			if (request.target.kind === "source") {
				const sources = db
					.prepare(
						"SELECT source_id FROM import_content_registry WHERE agent_id=? AND (source_id=? OR substr(source_id,1,length(?)+1)=?||':')",
					)
					.all(request.target.agentId, request.target.id, request.target.id, request.target.id);
				for (const source of sources) {
					const sourceId = z.string().parse(source.source_id);
					const labels = importSourceLabelsInTx(db, request.target.agentId, sourceId);
					const compartment = compartmentFor(db, labels);
					db.prepare("UPDATE import_content_registry SET compartment_id=? WHERE agent_id=? AND source_id=?").run(
						compartment,
						request.target.agentId,
						sourceId,
					);
				}
			}
			db.prepare("UPDATE org_jobs SET status='running',started_at=?,progress_json=? WHERE id=?").run(
				new Date().toISOString(),
				JSON.stringify({ table: 0, rowid: 0, updated: 0 }),
				jobId,
			);
			audit(
				db,
				request.actor,
				request.remove ? "classification.remove" : "classification.apply",
				request.target,
				request.id,
				{ jobId },
			);
			return true;
		});
		if (!admitted) return { status: "pending" };
	}
	return transaction(db, () => {
		const current = db.prepare("SELECT progress_json FROM org_jobs WHERE id=?").get(jobId),
			cursor = cursorSchema.safeParse(attempt(() => JSON.parse(String(current?.progress_json))));
		if (!cursor.success) throw new Error("invalid_cursor");
		let progress = cursor.data;
		let done = false;
		let inspected = 0;
		const started = performance.now();
		const initialUpdated = progress.updated;
		while (inspected < CLASSIFICATION_TURN_ROWS && progress.updated - initialUpdated < CLASSIFICATION_TURN_ROWS) {
			if (inspected > 0 && performance.now() - started >= CLASSIFICATION_TURN_MS) break;
			const page =
				request.target.kind === "memory"
					? {
							rows: contentRows(db, "memories", "id=? AND agent_id=?", [request.target.id, request.target.agentId]),
							cursor: { ...progress, table: COMPARTMENT_TABLES.length, rowid: 0 },
							done: true,
						}
					: batch(db, request.target.agentId, progress, 1);
			const context = contextFor(db, page.rows);
			const selected = page.rows.filter((row) => covers(db, request.target, row, context));
			let changed = 0;
			try {
				if (request.target.kind === "agent" && !request.remove) {
					for (const item of selected)
						publishCompartment(db, item, compartmentFor(db, [...members(db, item.row.compartment_id), request.id]));
					changed = selected.length;
				} else {
					changed = recompute(db, selected, true, CLASSIFICATION_TURN_ROWS - (progress.updated - initialUpdated));
				}
			} catch (error) {
				if (!(error instanceof ClassificationTurnFull) || inspected === 0) throw error;
				break;
			}
			progress = { ...page.cursor, updated: progress.updated + changed };
			inspected += page.rows.length;
			done = page.done;
			if (done) break;
		}
		db.prepare("UPDATE org_jobs SET status=?,progress_json=?,finished_at=?,error=NULL WHERE id=?").run(
			done ? "complete" : "running",
			JSON.stringify(progress),
			done ? new Date().toISOString() : null,
			jobId,
		);
		return { status: done ? "complete" : "running", updated: progress.updated };
	});
}
function visibility(db: MigrationDb, subject: AudienceSubject) {
	if (subject.local) return { compartments: "all" as const };
	if (!subject.userId) throw new Error("unauthorized");
	const pending = db
		.prepare(`SELECT 1 FROM org_jobs j WHERE ${inFlightClassificationSql("j")} LIMIT 1`)
		.get(subject.userId, subject.userId);
	return { compartments: readable(db, subject), ...(pending ? { inFlightUserId: subject.userId } : {}) };
}
function importSourceLabelsInTx(db: MigrationDb, agentId: string, sourceId: string): readonly string[] {
	return db
		.prepare(
			"SELECT DISTINCT classification_id FROM classification_assignments WHERE agent_id=? AND (target_kind='agent' OR (target_kind='source' AND (target_id=? OR substr(?,1,length(target_id)+1)=target_id||':'))) ORDER BY classification_id",
		)
		.all(agentId, sourceId, sourceId)
		.map((row) => z.string().parse(row.classification_id));
}
function importLabels(
	db: MigrationDb,
	agentId: string,
	author: WriteAuthor,
	actor: ClassificationActor | undefined,
	selected: string | undefined,
): string[] {
	if (actor?.legacy === true) {
		if (actor.userId !== null || author.userId !== null || actor.credential !== author.credential)
			throw new Error("permission");
		if (actor.boundAgentId !== agentId) throw new Error("agent_binding_conflict");
		if (actor.allowedProjects !== null) throw new Error("project_not_permitted");
		if (selected || classificationsForWrite(db, { agentId }).length > 0) throw new Error("classified_destination");
		return [];
	}
	if (actor && !actor.local) {
		if (
			actor.userId !== author.userId ||
			!actor.userId ||
			!db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(actor.userId)
		)
			throw new Error("permission");
		if (actor.boundAgentId !== null && actor.boundAgentId !== agentId) throw new Error("agent_binding_conflict");
		if (actor.allowedProjects !== null) throw new Error("project_not_permitted");
		const agent = db.prepare("SELECT * FROM agents WHERE id=? AND archived_at IS NULL").get(agentId);
		if (!agent || !canActAs(db, agent, { ...actor, compliance: false })) throw new Error("permission");
	}
	if (selected) {
		if (!actor || !matches(db, "classification_audience", selected, actor)) throw new Error("permission");
		const classification = db.prepare("SELECT archived_at FROM classifications WHERE id=?").get(selected);
		if (!classification) throw new Error("permission");
		if (classification.archived_at !== null) throw new Error("archived_classification");
		const user = actor.userId
			? db.prepare("SELECT compliance FROM users WHERE id=? AND status='active'").get(actor.userId)
			: null;
		if (
			!actor.local &&
			!(actor.compliance && user?.compliance === 1) &&
			db.prepare("SELECT 1 FROM classification_appliers WHERE classification_id=? LIMIT 1").get(selected) &&
			!matches(db, "classification_appliers", selected, actor)
		)
			throw new Error("permission");
	}
	const labels = [...new Set([...classificationsForWrite(db, { agentId }), ...(selected ? [selected] : [])])].sort();
	assertImportAudience(db, labels, author.userId);
	return labels;
}
function assertImportAudience(db: MigrationDb, labels: readonly string[], userId: string | null): void {
	if (labels.length > 1000) throw new Error("import_classification_conflict");
	if (userId !== null) {
		if (!db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(userId)) throw new Error("permission");
		for (const label of labels)
			if (!matches(db, "classification_audience", label, { local: false, userId, groupIds: [] }))
				throw new Error("classified_destination");
	}
}
function writeImportLabels(
	db: MigrationDb,
	agentId: string,
	sourceId: string,
	labels: readonly string[],
	author: WriteAuthor,
): void {
	for (const label of labels)
		db.prepare(
			"INSERT OR IGNORE INTO classification_assignments(classification_id,target_kind,target_id,agent_id,applied_by,applied_at) VALUES (?,'source',?,?,?,?)",
		).run(label, sourceId, agentId, author.userId, new Date().toISOString());
}
export function assertImportSourceLabelsInTx(
	db: MigrationDb,
	agentId: string,
	sourceId: string,
	encoded: string | null,
	author: WriteAuthor,
): readonly string[] {
	const actual = [...classificationsForWrite(db, { agentId, sourceId })].sort();
	const expected =
		encoded === null
			? actual
			: [
					...new Set([
						...z.array(z.string()).max(1000).parse(JSON.parse(encoded)),
						...classificationsForWrite(db, { agentId }),
					]),
				].sort();
	assertImportAudience(db, [...new Set([...actual, ...expected])], author.userId);
	const exists = db
		.prepare(
			"SELECT 1 FROM source_import_files WHERE source_id=? AND agent_id=? UNION ALL SELECT 1 FROM memory_artifacts WHERE source_id=? AND agent_id=? UNION ALL SELECT 1 FROM session_transcripts WHERE source_id=? AND agent_id=? UNION ALL SELECT 1 FROM document_import_jobs WHERE source_id=? AND agent_id=? UNION ALL SELECT 1 FROM classification_assignments WHERE target_kind='source' AND target_id=? AND agent_id=? LIMIT 1",
		)
		.get(sourceId, agentId, sourceId, agentId, sourceId, agentId, sourceId, agentId, sourceId, agentId);
	if (exists && JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("import_classification_conflict");
	return expected;
}
export function executeClassification(db: MigrationDb, request: ClassificationRequest): unknown {
	if (request.op === "import-identity")
		return transaction(db, () => {
			if (!/^[a-f0-9]{64}$/.test(request.contentHash)) throw new Error("invalid_import");
			const job = request.jobId
				? db
						.prepare("SELECT labels_json,author_user_id FROM source_import_jobs WHERE id=? AND agent_id=?")
						.get(request.jobId, request.agentId)
				: null;
			if (request.jobId && (!job || job.author_user_id !== request.author.userId)) throw new Error("permission");
			const labels = job
				? z.array(z.string()).parse(JSON.parse(z.string().parse(job.labels_json)))
				: importLabels(db, request.agentId, request.author, request.actor, request.classificationId);
			assertImportAudience(db, labels, request.author.userId);
			const missing = db
				.prepare(
					"SELECT value FROM json_each(?) s WHERE NOT EXISTS(SELECT 1 FROM import_content_registry r WHERE r.agent_id=? AND r.source_id=json_extract(s.value,'$.id'))",
				)
				.all(JSON.stringify(request.legacySources), request.agentId);
			for (const row of missing) {
				const legacy = z
					.object({
						id: z.string(),
						authorUserId: z.string().nullable(),
						authorCredential: z.string(),
						createdAt: z.string(),
					})
					.parse(JSON.parse(z.string().parse(row.value)));
				const compartment = compartmentFor(db, importSourceLabelsInTx(db, request.agentId, legacy.id));
				db.prepare(
					"INSERT OR IGNORE INTO import_content_registry(agent_id,source_id,content_hash,compartment_id,author_user_id,author_credential,created_at) VALUES(?,?,?,?,?,?,?)",
				).run(
					request.agentId,
					legacy.id,
					request.contentHash,
					compartment,
					legacy.authorUserId,
					legacy.authorCredential,
					legacy.createdAt,
				);
			}
			const compartment = compartmentFor(db, labels);
			const subject = {
				local: request.author.userId === null && request.actor?.legacy !== true,
				userId: request.author.userId,
				groupIds: [],
			};
			const scope: ReadScope = {
				reach: { kind: "own", agentId: request.agentId },
				projects: null,
				...(request.actor?.legacy ? { compartments: [] } : visibility(db, subject)),
			};
			const clause = readScopeSql("r", scope, { visibility: null, memory: null, session: null, source: "source_id" });
			if (
				request.author.userId !== null &&
				db
					.prepare(
						`SELECT 1 FROM import_content_registry r WHERE r.agent_id=? AND r.content_hash=? AND r.author_user_id=? AND r.compartment_id IS NOT ? ${clause.sql} LIMIT 1`,
					)
					.get(request.agentId, request.contentHash, request.author.userId, compartment, ...clause.args)
			)
				throw new Error("import_classification_conflict");
			const duplicate = db
				.prepare(
					`SELECT r.source_id FROM import_content_registry r WHERE r.agent_id=? AND r.content_hash=? AND r.compartment_id IS ? ${clause.sql} ORDER BY r.created_at,r.rowid LIMIT 1`,
				)
				.get(request.agentId, request.contentHash, compartment, ...clause.args);
			const duplicateSourceId = text(duplicate?.source_id);
			const sourceId = !request.newGeneration && duplicateSourceId ? duplicateSourceId : id("imp");
			if (sourceId !== duplicateSourceId)
				db.prepare(
					"INSERT INTO import_content_registry(agent_id,source_id,content_hash,compartment_id,author_user_id,author_credential,created_at) VALUES(?,?,?,?,?,?,?)",
				).run(
					request.agentId,
					sourceId,
					request.contentHash,
					compartment,
					request.author.userId,
					request.author.credential,
					new Date().toISOString(),
				);
			return { classificationKey: JSON.stringify([...labels].sort()), sourceId, duplicateSourceId };
		});
	if (request.op === "import-create")
		return transaction(db, () => {
			const input = request.input;
			if (!input.agentId || (input.files?.length ?? 0) > 25) throw new Error("invalid_import");
			const labels = importLabels(db, input.agentId, input.author, input.actor, input.classificationId);
			db.prepare(
				"INSERT INTO source_import_jobs(id,kind,agent_id,schema_id,adapter_version,state,generation,duplicate_mode,author_user_id,author_credential,labels_json) VALUES (?,'import',?,?,1,'staging',0,?,?,?,?)",
			).run(
				input.jobId,
				input.agentId,
				input.schemaId ?? "signet-export",
				input.duplicateMode ?? "skip",
				input.author.userId,
				input.author.credential,
				JSON.stringify(labels),
			);
			for (const [ordinal, file] of (input.files ?? []).entries()) {
				const sourceId = `reserved:${input.jobId}:${file.id}`;
				db.prepare(
					"INSERT INTO source_import_files(id,job_id,source_id,agent_id,ordinal,name,managed_path,state,storage_state) VALUES (?,?,?,?,?,?,?,'staging','uploading')",
				).run(file.id, input.jobId, sourceId, input.agentId, ordinal, file.name, "");
				writeImportLabels(db, input.agentId, sourceId, labels, input.author);
			}
			if (input.actor)
				audit(
					db,
					input.actor,
					"import.created",
					{ kind: "agent", id: input.agentId, agentId: input.agentId },
					input.classificationId ?? "",
					{ jobId: input.jobId, classifications: labels },
				);
			return [];
		});
	if (request.op === "import-bind")
		return transaction(db, () => {
			const { scope } = request;
			const job = db
				.prepare(
					"SELECT j.labels_json,j.author_user_id,j.author_credential FROM source_import_jobs j JOIN source_import_files f ON f.job_id=j.id AND f.agent_id=j.agent_id WHERE j.id=? AND j.agent_id=? AND f.upload_generation=? AND j.state IN ('staging','cancelled') AND f.id=? AND f.storage_state='sealed' AND f.state IN ('staging','ready')",
				)
				.get(scope.jobId, scope.agentId, scope.generation, scope.fileId);
			if (!job) throw new Error("stale_import_binding");
			const author = { userId: text(job.author_user_id), credential: z.string().parse(job.author_credential) };
			const labels = assertImportSourceLabelsInTx(db, scope.agentId, request.sourceId, text(job.labels_json), author);
			if (request.duplicateSourceId)
				assertImportSourceLabelsInTx(db, scope.agentId, request.duplicateSourceId, text(job.labels_json), author);
			writeImportLabels(db, scope.agentId, request.sourceId, labels, author);
			return db
				.prepare(
					"UPDATE source_import_files SET source_id=?,state='ready' WHERE id=? AND job_id=? AND agent_id=? AND storage_state='sealed'",
				)
				.run(request.sourceId, scope.fileId, scope.jobId, scope.agentId);
		});
	if (request.op === "import-document")
		return transaction(db, () => {
			const input = request.input;
			const labels = importLabels(db, input.agentId, input.author, input.actor, input.classificationId);
			if (input.duplicateSourceId)
				assertImportSourceLabelsInTx(db, input.agentId, input.duplicateSourceId, JSON.stringify(labels), input.author);
			assertImportSourceLabelsInTx(db, input.agentId, input.sourceId, JSON.stringify(labels), input.author);
			writeImportLabels(db, input.agentId, input.sourceId, labels, input.author);
			db.prepare(
				"INSERT OR IGNORE INTO document_import_jobs(id,agent_id,source_id,author_user_id,author_credential,labels_json,created_at) VALUES (?,?,?,?,?,?,?)",
			).run(
				input.jobId,
				input.agentId,
				input.sourceId,
				input.author.userId,
				input.author.credential,
				JSON.stringify(labels),
				new Date().toISOString(),
			);
			const admitted = db
				.prepare("SELECT id FROM document_import_jobs WHERE source_id=? AND agent_id=?")
				.get(input.sourceId, input.agentId);
			const jobId = z.string().parse(admitted?.id);
			if (input.actor)
				audit(
					db,
					input.actor,
					"import.created",
					{ kind: "source", id: input.sourceId, agentId: input.agentId },
					input.classificationId ?? "",
					{ jobId, classifications: labels },
				);
			return { id: jobId };
		});
	if (request.op === "admit-write") {
		for (const scope of request.scopes) classificationsForWrite(db, scope);
		return true;
	}
	if (request.op === "visibility") return visibility(db, request.subject);
	if (request.op === "readable") return request.subject.local ? "all" : readable(db, request.subject);
	if (request.op === "record-error")
		return transaction(db, () => {
			const job = db
				.prepare(
					"SELECT kind,status,progress_json,params_json FROM org_jobs WHERE id=? AND kind IN ('classify','unclassify','recompute')",
				)
				.get(request.jobId);
			if (!job) throw new Error("not_found");
			if (job.status !== "running") {
				if (job.status === "pending")
					db.prepare("UPDATE org_jobs SET error=? WHERE id=?").run(request.error.slice(0, 1000), request.jobId);
				return { status: job.status, failures: 0 };
			}
			const progress = cursorSchema
				.extend({ failures: z.number().int().nonnegative().default(0) })
				.parse(JSON.parse(String(job.progress_json)));
			progress.failures++;
			const failed = progress.failures >= 5;
			db.prepare("UPDATE org_jobs SET status=?,progress_json=?,error=?,finished_at=? WHERE id=?").run(
				failed ? "failed" : "running",
				JSON.stringify(progress),
				request.error.slice(0, 1000),
				failed ? new Date().toISOString() : null,
				request.jobId,
			);
			if (failed && job.kind !== "recompute") {
				const params = enqueuedSchema.parse(JSON.parse(String(job.params_json)));
				audit(
					db,
					params.actor,
					"classification.failed",
					params.target,
					params.id,
					{ jobId: request.jobId, error: request.error.slice(0, 1000), failures: progress.failures },
					"failed",
				);
			}
			return { status: failed ? "failed" : "running", failures: progress.failures };
		});
	if (request.op === "recover") {
		const jobs = db
			.prepare(
				"SELECT id FROM org_jobs WHERE kind IN ('classify','unclassify','recompute') AND status IN ('pending','running') AND id>? ORDER BY id LIMIT 100",
			)
			.all(request.cursor ?? "")
			.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
		return { jobs, nextCursor: jobs.length === 100 ? jobs.at(-1) : null };
	}
	if (request.op === "list")
		return db
			.prepare(`SELECT c.* FROM classifications c WHERE ${DEFINITION_AUDIENCE} ORDER BY c.name`)
			.all(Number(request.actor.compliance || request.actor.local), request.actor.userId, request.actor.userId)
			.map((row) => definitionView(db, row, request.actor, request.includePrincipals === true));
	if (request.op === "get")
		return definitionView(
			db,
			definition(db, request.id ?? "", request.actor),
			request.actor,
			request.includePrincipals === true,
		);
	if (request.op === "rebuild")
		return transaction(db, () => {
			const cursor =
				request.cursor === undefined ? { table: 0, rowid: 0, updated: 0 } : cursorSchema.parse(request.cursor);
			if (cursor.table === 0 && cursor.rowid === 0) backfillEvidenceCitations(db);
			const page = batch(db, request.agentId, cursor),
				updated = cursor.updated + recompute(db, page.rows);
			return { updated, cursor: page.done ? null : { ...page.cursor, updated } };
		});
	if (request.op === "create") {
		compliance(request.actor);
		return transaction(db, () => {
			if (db.prepare("SELECT 1 FROM classifications WHERE name=?").get(request.name)) throw new Error("name_conflict");
			const classification = id("cls");
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO classifications(id,name,color,description,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
			).run(classification, request.name, request.color, request.description, request.actor.userId, now, now);
			principals(db, "classification_audience", classification, request.audience);
			principals(db, "classification_appliers", classification, request.appliers);
			audit(db, request.actor, "classification.create", null, classification, {});
			return { id: classification };
		});
	}
	if (request.op === "update" || request.op === "audience" || request.op === "appliers") {
		compliance(request.actor);
		definition(db, request.id, request.actor);
		return transaction(db, () => {
			if (request.op === "update") {
				const old = definition(db, request.id, request.actor);
				if (
					request.name !== undefined &&
					db.prepare("SELECT 1 FROM classifications WHERE name=? AND id<>?").get(request.name, request.id)
				)
					throw new Error("name_conflict");
				db.prepare("UPDATE classifications SET name=?,color=?,description=?,archived_at=?,updated_at=? WHERE id=?").run(
					request.name ?? old.name,
					request.color === undefined ? old.color : request.color,
					request.description === undefined ? old.description : request.description,
					request.archived === undefined ? old.archived_at : request.archived ? new Date().toISOString() : null,
					new Date().toISOString(),
					request.id,
				);
			} else
				principals(
					db,
					request.op === "audience" ? "classification_audience" : "classification_appliers",
					request.id,
					request.principals,
				);
			audit(db, request.actor, `classification.${request.op}`, null, request.id, {});
			return { ok: true };
		});
	}
	if (request.op === "preview") {
		definition(db, request.id, request.actor);
		authorize(db, request.target, request.id, request.actor, false, true);
		return preview(db, request.target, request.scope);
	}
	if (request.op === "items") {
		definition(db, request.id, request.actor);
		const audience = matches(db, "classification_audience", request.id, request.actor);
		const predicate = readScopeSql("m", request.scope);
		const args: unknown[] = [request.id];
		let filter = "";
		if (audience || request.actor.boundAgentId !== null || request.scope.projects !== null) {
			const itemScope: ReadScope = audience ? request.scope : { ...request.scope, compartments: "all" };
			const checks: string[] = [];
			for (const [kind, table, key] of [
				["memory", "memories", "id"],
				["session", "session_transcripts", "session_key"],
				["source", "memory_artifacts", "source_id"],
				["source", "session_transcripts", "source_id"],
				["agent", "memories", "agent_id"],
			] as const) {
				const clause = readScopeSql("r", itemScope, {
					...scopeColumns(db, table),
					visibility: table === "memories" ? "visibility" : null,
				});
				checks.push(
					`(a.target_kind='${kind}' AND EXISTS(SELECT 1 FROM ${table} r WHERE r.${key}=a.target_id AND r.agent_id=a.agent_id ${clause.sql}))`,
				);
				args.push(...clause.args);
			}
			filter = ` AND (${checks.join(" OR ")})`;
		}
		let cursor: readonly string[] = ["", "", ""];
		if (request.cursor) {
			const value: unknown = attempt(() => JSON.parse(request.cursor ?? ""));
			if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => typeof v === "string"))
				throw new Error("invalid_cursor");
			cursor = value;
		}
		args.push(...cursor);
		const items = db
			.prepare(
				`SELECT target_kind,target_id,agent_id FROM classification_assignments a WHERE classification_id=? ${filter} AND (target_kind,agent_id,target_id)>(?,?,?) ORDER BY target_kind,agent_id,target_id LIMIT 100`,
			)
			.all(...args);
		const last = items.at(-1);
		return {
			items: items.map((r) => ({
				...r,
				...(audience && r.target_kind === "memory"
					? {
							memory:
								db
									.prepare(`SELECT id,content FROM memories m WHERE id=? AND agent_id=? ${predicate.sql}`)
									.get(r.target_id, r.agent_id, ...predicate.args) ?? null,
						}
					: {}),
			})),
			nextCursor:
				items.length === 100 && last ? JSON.stringify([last.target_kind, last.agent_id, last.target_id]) : null,
		};
	}
	if (request.op === "enqueue")
		return transaction(db, () => {
			authorize(db, request.target, request.id, request.actor, request.remove);
			const jobId = id("job");
			db.prepare(
				"INSERT INTO org_jobs(id,kind,status,params_json,created_by,created_at) VALUES (?,?,'pending',?,?,?)",
			).run(
				jobId,
				request.remove ? "unclassify" : "classify",
				JSON.stringify(request),
				request.actor.userId,
				new Date().toISOString(),
			);
			return { jobId };
		});
	if (request.op === "execute") {
		try {
			const repair = db.prepare("SELECT * FROM org_jobs WHERE id=? AND kind='recompute'").get(request.jobId);
			if (repair)
				return transaction(db, () => {
					if (repair.status === "complete") return { status: "complete" };
					if (repair.status === "failed") throw new Error("recompute_failed");
					const params = z.object({ agentId: z.string().min(1) }).parse(JSON.parse(String(repair.params_json)));
					const cursor = repair.progress_json
						? cursorSchema.parse(JSON.parse(String(repair.progress_json)))
						: { table: 0, rowid: 0, updated: 0 };
					const page = batch(db, params.agentId, cursor);
					const updated = cursor.updated + recompute(db, page.rows);
					db.prepare("UPDATE org_jobs SET status=?,progress_json=?,finished_at=? WHERE id=?").run(
						page.done ? "complete" : "running",
						JSON.stringify({ ...page.cursor, updated }),
						page.done ? new Date().toISOString() : null,
						request.jobId,
					);
					return { status: page.done ? "complete" : "running" };
				});
			return executeJob(db, request.jobId);
		} catch (error) {
			db.prepare("UPDATE org_jobs SET status='failed',error=?,finished_at=? WHERE id=? AND status='pending'").run(
				error instanceof Error ? error.message : "classification_failed",
				new Date().toISOString(),
				request.jobId,
			);
			throw error;
		}
	}
	throw new Error("unsupported_classification_operation");
}

export interface DreamingPartition {
	readonly agentId: string;
	readonly compartmentId: number | null;
}

export type DreamingMutationTable =
	| "entity_aliases"
	| "entities"
	| "entity_aspects"
	| "entity_attributes"
	| "entity_dependencies"
	| "memories"
	| "epistemic_assertions"
	| "ontology_contradictions"
	| "ontology_proposals"
	| "dreaming_attention"
	| "memory_head_entries"
	| "temporal_edges";

export function graphReadTablesInScope(agentId: string, scope: ReadScope) {
	if (scope.projects !== null) throw new Error("project_scope_unsupported");
	const predicates = ["e", "asp", "attr", "dep"].map((alias) =>
		readScopeSql(alias, scope, {
			memory: null,
			session: null,
			source: "source_id",
			visibility: null,
		}),
	);
	const [entity, aspect, attribute, dependency] = predicates;
	if (!entity || !aspect || !attribute || !dependency) throw new Error("invalid_read_scope");
	const params = predicates
		.flatMap((predicate) => [agentId, ...predicate.args])
		.map((value) => {
			if (typeof value === "string" || typeof value === "number" || value === null) return value;
			throw new Error("invalid_read_scope");
		});
	return {
		params,
		sql: `WITH visible_entities AS NOT MATERIALIZED (
			SELECT e.* FROM entities e WHERE e.agent_id=? ${entity.sql}
		), visible_aspects AS NOT MATERIALIZED (
			SELECT asp.* FROM entity_aspects asp JOIN visible_entities e ON e.id=asp.entity_id AND e.agent_id=asp.agent_id
			WHERE asp.agent_id=? ${aspect.sql}
		), visible_attributes AS NOT MATERIALIZED (
			SELECT attr.* FROM entity_attributes attr JOIN visible_aspects asp ON asp.id=attr.aspect_id AND asp.agent_id=attr.agent_id
			WHERE attr.agent_id=? ${attribute.sql}
		), visible_dependencies AS NOT MATERIALIZED (
			SELECT dep.* FROM entity_dependencies dep
			JOIN visible_entities src ON src.id=dep.source_entity_id AND src.agent_id=dep.agent_id
			JOIN visible_entities dst ON dst.id=dep.target_entity_id AND dst.agent_id=dep.agent_id
			WHERE dep.agent_id=? ${dependency.sql}
		)`,
	};
}

export function dreamingReadScopeInDb(db: ReadDb, agentId: string, compartmentId: number | null): ReadScope {
	if (!agentId.trim()) throw new Error("agent_required");
	if (compartmentId !== null && (!Number.isSafeInteger(compartmentId) || compartmentId < 1))
		throw new Error("compartment_mismatch");
	const compartments =
		compartmentId === null
			? []
			: prepareTypedStatement<{ id: number }>(
					db,
					`
		SELECT c.id FROM compartments c
		WHERE EXISTS (SELECT 1 FROM compartment_members own WHERE own.compartment_id = c.id)
		AND NOT EXISTS (
			SELECT 1 FROM compartment_members member WHERE member.compartment_id = c.id
			AND NOT EXISTS (SELECT 1 FROM compartment_members allowed
				WHERE allowed.compartment_id = ? AND allowed.classification_id = member.classification_id)
		) ORDER BY c.id
	`,
				)
					.all(compartmentId)
					.map((row) => row.id);
	if (compartmentId !== null && !compartments.includes(compartmentId)) throw new Error("compartment_mismatch");
	return { reach: { kind: "own", agentId }, compartments, projects: null };
}

export function assertDreamingAgentInDb(db: ReadDb, agentId: string): void {
	const excluded = prepareTypedStatement<{ id: string }>(
		db,
		`
		SELECT a.id FROM agents a WHERE a.id = ? AND (
			a.archived_at IS NOT NULL OR (a.kind = 'organization' AND EXISTS (
				SELECT 1 FROM organization o WHERE o.id = 1 AND o.claimed_at IS NOT NULL AND o.agent_model = 'personal'
			))
		) LIMIT 1
	`,
	).get(agentId);
	if (excluded) throw new Error("org_policy");
}

export function dreamingPassPartitionInDb(db: ReadDb, passId: string, agentId?: string): DreamingPartition {
	const pass = prepareTypedStatement<{
		agent_id: string;
		compartment_id: number | null;
		scope_key: string | null;
	}>(db, `SELECT agent_id, compartment_id, scope_key FROM dreaming_passes WHERE id = ? AND status = 'running'`).get(
		passId,
	);
	if (!pass) throw new Error("Dreaming pass is not running");
	const target = agentId ?? pass.agent_id;
	const scopes = (pass.scope_key || pass.agent_id).split(",");
	if (!scopes.includes(target)) throw new Error("agent_not_permitted");
	assertDreamingAgentInDb(db, target);
	const fence = prepareTypedStatement<{ valid: number }>(
		db,
		"SELECT valid FROM dreaming_pass_fences WHERE pass_id = ?",
	).get(passId);
	if (!fence?.valid) throw new Error("compartment_mismatch");
	return { agentId: target, compartmentId: pass.compartment_id };
}

export function assertDreamingMutationLabelInDb(
	db: ReadDb,
	table: DreamingMutationTable,
	id: string,
	partition: DreamingPartition,
): void {
	const row = prepareTypedStatement<{ id: string; person_user_id: string | null }>(
		db,
		`SELECT id,${table === "entities" ? "person_user_id" : "NULL AS person_user_id"} FROM ${table} WHERE id = ? AND agent_id = ? AND compartment_id IS ?`,
	).get(id, partition.agentId, partition.compartmentId);
	if (!row) throw new Error("compartment_mismatch");
	if (row.person_user_id !== null) throw new Error("person_identity_immutable");
}
export type SemanticCitationKind =
	| "alias"
	| "attribute"
	| "memory"
	| "dependency"
	| "entity"
	| "aspect"
	| "assertion"
	| "proposal"
	| "contradiction"
	| "temporal_edge";
export type CitationEvidenceKind = "memory" | "artifact" | "transcript" | "summary" | "attribute";
export interface SemanticEvidenceCitation {
	readonly kind: CitationEvidenceKind;
	readonly id: string;
}

export function dreamingEvidenceRecordInDb(
	db: ReadDb,
	agentId: string,
	evidence: SemanticEvidenceCitation,
): { readonly compartment_id: number | null; readonly author_user_id: string | null } | undefined {
	const tables = {
		memory: "memories",
		artifact: "memory_artifacts",
		transcript: "session_transcripts",
		summary: "session_summaries",
		attribute: "entity_attributes",
	} as const;
	const author =
		evidence.kind === "transcript"
			? "speaker_user_id"
			: evidence.kind === "memory" || evidence.kind === "artifact" || evidence.kind === "summary"
				? "author_user_id"
				: evidence.kind === "attribute"
					? "(SELECT author_user_id FROM memories WHERE memories.id = entity_attributes.memory_id AND memories.agent_id = entity_attributes.agent_id AND memories.compartment_id IS entity_attributes.compartment_id)"
					: "NULL";
	return prepareTypedStatement<{ compartment_id: number | null; author_user_id: string | null }>(
		db,
		`SELECT compartment_id, ${author} AS author_user_id FROM ${tables[evidence.kind]} WHERE ${evidence.kind === "transcript" ? "session_key" : evidence.kind === "artifact" ? "source_path" : "id"} = ? AND agent_id = ?`,
	).get(evidence.id, agentId);
}

export function evidenceCitationInDb(
	db: ReadDb,
	partition: DreamingPartition,
	evidence: SemanticEvidenceCitation,
): { readonly authorUserId: string | null } {
	const row = dreamingEvidenceRecordInDb(db, partition.agentId, evidence);
	if (!row) throw new Error(`Derived memory provenance source is not in the authorized agent scope: ${evidence.id}`);
	const scope = dreamingReadScopeInDb(db, partition.agentId, partition.compartmentId);
	if (row.compartment_id !== null && scope.compartments !== "all" && !scope.compartments.includes(row.compartment_id))
		throw new Error("compartment_mismatch");
	return { authorUserId: row.author_user_id };
}

export function recordSemanticCitationsInTx(
	db: WriteDb,
	input: {
		readonly kind: SemanticCitationKind;
		readonly id: string;
		readonly partition: DreamingPartition;
		readonly evidence: readonly SemanticEvidenceCitation[];
	},
): void {
	for (const evidence of input.evidence) evidenceCitationInDb(db, input.partition, evidence);
	for (const evidence of input.evidence)
		db.prepare(
			"INSERT INTO evidence_citations (derived_kind, derived_id, agent_id, evidence_kind, evidence_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT (derived_kind, derived_id, evidence_kind, evidence_id) DO NOTHING",
		).run(input.kind, input.id, input.partition.agentId, evidence.kind, evidence.id);
}

export function assertDreamingAttentionSubjectInDb(
	db: ReadDb,
	partition: DreamingPartition,
	subject: string | null,
): void {
	const separator = subject?.indexOf(":") ?? -1;
	const kind = subject?.slice(0, separator) ?? "";
	const sourceId = subject?.slice(separator + 1) ?? "";
	const definitions: Readonly<Record<string, readonly [string, string]>> = {
		entity: ["entities", "id"],
		aspect: ["entity_aspects", "id"],
		attribute: ["entity_attributes", "id"],
		claim: ["entity_attributes", "id"],
		link: ["entity_dependencies", "id"],
		memory: ["memories", "id"],
		artifact: ["memory_artifacts", "source_path"],
		transcript: ["session_transcripts", "session_key"],
		summary: ["session_summaries", "id"],
	};
	const definition = Object.hasOwn(definitions, kind) ? definitions[kind] : undefined;
	if (separator > 0 && definition) {
		const [table, key] = definition;
		const source = prepareTypedStatement<{ compartment_id: number | null }>(
			db,
			`SELECT compartment_id FROM ${table} WHERE ${key} = ? AND agent_id = ?`,
		).get(sourceId, partition.agentId);
		const readable = dreamingReadScopeInDb(db, partition.agentId, partition.compartmentId);
		if (
			source?.compartment_id != null &&
			readable.compartments !== "all" &&
			!readable.compartments.includes(source.compartment_id)
		)
			throw new Error("compartment_mismatch");
	}
	for (const row of prepareTypedStatement<{ id: string }>(
		db,
		"SELECT id FROM dreaming_attention WHERE agent_id = ? AND kind = 'hygiene' AND subject_ref = ? AND compartment_id IS ?",
	).all(partition.agentId, subject, partition.compartmentId))
		assertDreamingMutationLabelInDb(db, "dreaming_attention", row.id, partition);
}
