import {
	compartmentFor,
	ensureCompartmentShards,
	syncEmbeddingCompartment,
	COMPARTMENT_TABLES,
	backfillEvidenceCitations,
	type MigrationDb,
} from "@signet/core";
import type {
	ClassificationActor,
	ClassificationRequest,
	ClassificationTarget,
	ClassificationPrincipal,
} from "./classifications";
import { readScopeSql, type AudienceSubject, type ReadScope } from "./read-scope";

type Row = Record<string, unknown>;
interface ContentRow {
	table: string;
	row: Row;
	key: string;
	kind: string | null;
}
const DERIVED: Readonly<Record<string, string>> = {
	attribute: "entity_attributes",
	memory: "memories",
	dependency: "entity_dependencies",
	entity: "entities",
	aspect: "entity_aspects",
	assertion: "epistemic_assertions",
	head_entry: "memory_head_entries",
	reflection: "daily_reflections",
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
): void {
	db.prepare(
		`INSERT INTO audit_events(id,at,actor_user_id,actor_credential,action,target_kind,target_id,agent_id,outcome,detail_json) VALUES (?,?,?,?,?,?,?,?, 'ok',?)`,
	).run(
		id("aud"),
		new Date().toISOString(),
		actor.userId,
		actor.credential,
		action,
		target?.kind ?? "classification",
		target?.id ?? classification,
		target?.agentId ?? null,
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
function loadRows(db: MigrationDb, agentId?: string): ContentRow[] {
	const result: ContentRow[] = [];
	for (const table of COMPARTMENT_TABLES) {
		const columns = db.prepare(`PRAGMA table_info(${table})`).all();
		if (!columns.length) continue;
		const hasAgent = columns.some((r) => r.name === "agent_id");
		if (agentId && !hasAgent && table !== "session_checkpoints") continue;
		const embedding = table === "embeddings" || table === "embeddings_staging";
		const where =
			agentId && hasAgent
				? embedding
					? "WHERE agent_id=? OR (agent_id IS NULL AND source_type='memory' AND source_id IN (SELECT id FROM memories WHERE agent_id=?))"
					: "WHERE agent_id=?"
				: "";
		const metadata = columns.flatMap((c) =>
			typeof c.name === "string" &&
			[
				"id",
				"entry_id",
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
				"memory_id",
				"project",
				"visibility",
			].includes(c.name)
				? [c.name]
				: [],
		);
		const rows = db
			.prepare(
				`SELECT rowid AS _classification_rowid${metadata.length ? `,${metadata.join(",")}` : ""} FROM ${table} ${where} LIMIT 100001`,
			)
			.all(...(agentId && hasAgent ? (embedding ? [agentId, agentId] : [agentId]) : []));
		if (embedding)
			for (const row of rows)
				if (row.agent_id == null && row.source_type === "memory") {
					const memory = db.prepare("SELECT agent_id FROM memories WHERE id=?").get(row.source_id);
					if (typeof memory?.agent_id === "string") row.agent_id = memory.agent_id;
				}
		if (result.length + rows.length > 100000) throw new Error("classification_admission_limit");
		for (const row of rows) {
			const key =
				text(
					table === "session_transcripts"
						? row.session_key
						: table === "memory_artifacts"
							? row.source_path
							: (row.id ?? row.entry_id),
				) ?? String(row._classification_rowid);
			const kind =
				table === "memories"
					? "memory"
					: table === "session_transcripts"
						? "transcript"
						: table === "memory_artifacts"
							? "artifact"
							: table === "session_summaries"
								? "summary"
								: (Object.entries(DERIVED).find(([, t]) => t === table)?.[0] ?? null);
			result.push({ table, row, key, kind });
		}
	}
	return result;
}
const rowIndexes = new WeakMap<
	readonly ContentRow[],
	{ identities: Map<string, ContentRow>; pointers: Map<string, ContentRow[]>; transcripts: Map<string, ContentRow[]> }
>();
function rowIndex(rows: readonly ContentRow[]) {
	const cached = rowIndexes.get(rows);
	if (cached) return cached;
	const identities = new Map<string, ContentRow>(),
		pointers = new Map<string, ContentRow[]>(),
		transcripts = new Map<string, ContentRow[]>();
	for (const item of rows) {
		identities.set(JSON.stringify([item.table, item.row.agent_id, item.key]), item);
		if (["memory", "artifact", "transcript", "summary"].includes(item.kind ?? "")) {
			const key = JSON.stringify([item.row.agent_id, item.key]);
			const values = pointers.get(key) ?? [];
			values.push(item);
			pointers.set(key, values);
		}
		if (item.kind === "transcript") {
			const values = transcripts.get(item.key) ?? [];
			values.push(item);
			transcripts.set(item.key, values);
		}
	}
	const index = { identities, pointers, transcripts };
	rowIndexes.set(rows, index);
	return index;
}
function memoryRow(rows: readonly ContentRow[], agent: unknown, key: unknown): ContentRow | undefined {
	return rowIndex(rows).identities.get(JSON.stringify(["memories", agent, key]));
}
function covers(target: ClassificationTarget, item: ContentRow, rows: readonly ContentRow[]): boolean {
	const r = item.row,
		index = rowIndex(rows);
	if (item.table === "session_checkpoints")
		return (index.transcripts.get(String(r.session_key)) ?? []).some(
			(e) =>
				e.row.agent_id === target.agentId &&
				(target.kind === "agent" ||
					(target.kind === "session" && e.key === target.id) ||
					(target.kind === "source" && e.row.source_id === target.id)),
		);
	if (r.agent_id !== target.agentId) return false;
	if (target.kind === "agent") return true;
	if (target.kind === "memory") return item.table === "memories" && item.key === target.id;
	const evidence = [
		...(index.pointers.get(JSON.stringify([r.agent_id, r.source_id])) ?? []),
		...(index.pointers.get(JSON.stringify([r.agent_id, r.source_path])) ?? []),
	];
	if (target.kind === "session") {
		const keys = [target.id, `session:${target.id}`];
		if (keys.includes(String(r.session_key ?? r.session_id))) return true;
		return (
			item.table === "memories" &&
			(keys.includes(String(r.source_id)) ||
				evidence.some(
					(e) =>
						["transcript", "artifact", "summary"].includes(e.kind ?? "") &&
						keys.includes(String(e.row.session_key ?? e.row.session_id)),
				))
		);
	}
	if (
		(item.table === "embeddings" || item.table === "embeddings_staging") &&
		typeof r.source_id === "string" &&
		(r.source_id === target.id || r.source_id.startsWith(`${target.id}:`))
	)
		return true;
	if (
		[
			"memory_artifacts",
			"session_transcripts",
			"documents",
			"entities",
			"entity_attributes",
			"entity_dependencies",
		].includes(item.table) &&
		r.source_id === target.id
	)
		return true;
	return (
		item.table === "memories" &&
		evidence.some((e) => (e.kind === "transcript" || e.kind === "artifact") && e.row.source_id === target.id)
	);
}
function authorize(
	db: MigrationDb,
	target: ClassificationTarget,
	classification: string,
	actor: ClassificationActor,
	remove: boolean,
	rows: readonly ContentRow[],
): void {
	const def = db.prepare("SELECT * FROM classifications WHERE id=?").get(classification);
	if (!def) throw new Error("not_found");
	const targetAgent = db.prepare("SELECT id FROM agents WHERE id=? AND archived_at IS NULL").get(target.agentId);
	if (
		!targetAgent ||
		(target.kind === "agent" && target.id !== target.agentId) ||
		(target.kind !== "agent" && !rows.some((r) => covers(target, r, rows)))
	)
		throw new Error("not_found");
	if (!remove && def.archived_at) throw new Error("archived_classification");
	if (remove) {
		compliance(actor);
		return;
	}
	if (actor.compliance || actor.local) return;
	const agent = db.prepare("SELECT * FROM agents WHERE id=?").get(target.agentId);
	const teamOwner =
		agent?.kind === "team" &&
		db
			.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND role='owner'")
			.get(agent.owner_group_id, actor.userId) != null;
	const personalOwner = agent?.kind === "personal" && agent.owner_user_id === actor.userId;
	const targets = rows.filter(
		(r) =>
			covers(target, r, rows) &&
			(target.kind === "memory"
				? r.kind === "memory"
				: target.kind === "agent"
					? false
					: r.kind === "transcript" || r.kind === "artifact"),
	);
	const author =
		targets.length > 0 && targets.every((r) => (r.row.author_user_id ?? r.row.speaker_user_id) === actor.userId);
	if (!actor.userId || (!personalOwner && !teamOwner && !author)) throw new Error("not_owner");
	if (
		db.prepare("SELECT 1 FROM classification_appliers WHERE classification_id=? LIMIT 1").get(classification) &&
		!matches(db, "classification_appliers", classification, actor)
	)
		throw new Error("permission");
}
function effective(item: ContentRow, rows: readonly ContentRow[], assignments: readonly Row[]): Set<string> {
	const agent = text(item.row.agent_id);
	const labels = new Set<string>();
	for (const a of assignments)
		if (
			(a.agent_id === agent || item.table === "session_checkpoints") &&
			typeof a.classification_id === "string" &&
			covers(
				{
					kind:
						a.target_kind === "agent"
							? "agent"
							: a.target_kind === "session"
								? "session"
								: a.target_kind === "source"
									? "source"
									: "memory",
					id: String(a.target_id),
					agentId: typeof a.agent_id === "string" ? a.agent_id : "",
				},
				item,
				rows,
			)
		)
			labels.add(a.classification_id);
	return labels;
}
function passLabels(db: MigrationDb, item: ContentRow): string[] {
	const pass = text(item.row.pass_id ?? item.row.dreaming_pass_id);
	if (!pass) return [];
	return db
		.prepare(
			"SELECT cm.classification_id FROM dreaming_passes p JOIN compartment_members cm ON cm.compartment_id=p.compartment_id WHERE p.id=? AND p.agent_id=?",
		)
		.all(pass, item.row.agent_id)
		.flatMap((r) => (typeof r.classification_id === "string" ? [r.classification_id] : []));
}
function scopedLinks(
	db: MigrationDb,
	table: "classification_assignments" | "evidence_citations",
	rows: readonly ContentRow[],
	limit: number,
): Row[] {
	const agents = [...new Set(rows.flatMap((r) => (typeof r.row.agent_id === "string" ? [r.row.agent_id] : [])))];
	const result: Row[] = [];
	for (let start = 0; start < agents.length; start += 500) {
		const batch = agents.slice(start, start + 500);
		result.push(
			...db
				.prepare(`SELECT * FROM ${table} WHERE agent_id IN (${batch.map(() => "?").join(",")}) LIMIT ?`)
				.all(...batch, limit + 1 - result.length),
		);
		if (result.length > limit) throw new Error(`${table}_admission_limit`);
	}
	return result;
}
function recompute(db: MigrationDb, rows: readonly ContentRow[], selected: readonly ContentRow[]): number {
	const assignments = scopedLinks(db, "classification_assignments", rows, 100000);
	const labels = new Map<ContentRow, Set<string>>();
	for (const item of rows) labels.set(item, effective(item, rows, assignments));
	const changed = new Set(selected);
	const initial = new Set(
		selected.filter((r) => ["memory", "transcript", "artifact", "summary"].includes(r.kind ?? "")),
	);
	const citations = scopedLinks(db, "evidence_citations", rows, 1000000);
	const linksByRow = new Map<string, Row[]>();
	for (const citation of citations) {
		const key = JSON.stringify([DERIVED[String(citation.derived_kind)], citation.agent_id, citation.derived_id]);
		const links = linksByRow.get(key) ?? [];
		links.push(citation);
		linksByRow.set(key, links);
	}
	const index = rowIndex(rows);
	for (const item of rows) {
		const links = linksByRow.get(JSON.stringify([item.table, item.row.agent_id, item.key])) ?? [];
		for (const link of links)
			for (const evidence of index.pointers.get(JSON.stringify([link.agent_id, link.evidence_id])) ?? []) {
				if (evidence.kind !== link.evidence_kind) continue;
				for (const label of effective(evidence, rows, assignments)) labels.get(item)?.add(label);
				for (const label of passLabels(db, evidence)) labels.get(item)?.add(label);
				if (initial.has(evidence)) changed.add(item);
			}
		for (const label of passLabels(db, item)) labels.get(item)?.add(label);
	}

	for (const item of rows)
		if (item.table === "entity_attributes" && typeof item.row.memory_id === "string") {
			const memory = memoryRow(rows, item.row.agent_id, item.row.memory_id);
			if (memory) {
				for (const label of labels.get(item) ?? []) labels.get(memory)?.add(label);
				if (changed.has(item)) changed.add(memory);
			}
		}
	for (const item of rows)
		if (item.table === "embeddings" || item.table === "embeddings_staging" || item.table === "memory_hints") {
			const memory = memoryRow(rows, item.row.agent_id, item.row.memory_id ?? item.row.source_id);
			const evidence =
				memory ??
				(index.pointers.get(JSON.stringify([item.row.agent_id, item.row.source_id])) ?? []).find(
					(r) => r.kind === "artifact" || r.kind === "transcript",
				);
			if (evidence) {
				for (const label of labels.get(evidence) ?? []) labels.get(item)?.add(label);
				if (changed.has(evidence)) changed.add(item);
			}
		}
	const ensured = new Set<number>();
	for (const item of changed) {
		const c = compartmentFor(db, [...(labels.get(item) ?? [])]);
		if (c !== null && !ensured.has(c)) {
			ensureCompartmentShards(db, c, 0);
			ensured.add(c);
		}
		if (item.table === "embeddings" || item.table === "embeddings_staging")
			db.prepare(`UPDATE ${item.table} SET compartment_id=?,agent_id=? WHERE rowid=?`).run(
				c,
				item.row.agent_id,
				item.row._classification_rowid,
			);
		else db.prepare(`UPDATE ${item.table} SET compartment_id=? WHERE rowid=?`).run(c, item.row._classification_rowid);
		if (item.table === "embeddings" || item.table === "embeddings_staging")
			syncEmbeddingCompartment(db, item.table, item.key);
	}
	return changed.size;
}
function visibleCount(db: MigrationDb, rows: readonly ContentRow[], scope: ReadScope): number {
	let count = 0;
	for (const table of new Set(rows.map((r) => r.table))) {
		const cols = db.prepare(`PRAGMA table_info(${table})`).all();
		if (!cols.some((c) => c.name === "agent_id")) continue;
		const clause = readScopeSql("r", scope, {
			visibility: cols.some((c) => c.name === "visibility") ? "visibility" : null,
		});
		if (scope.projects !== null && !cols.some((c) => c.name === "project")) continue;
		const ids = rows.filter((r) => r.table === table).map((r) => r.row._classification_rowid);
		for (let start = 0; start < ids.length; start += 500) {
			const batch = ids.slice(start, start + 500);
			const row = db
				.prepare(`SELECT COUNT(*) n FROM ${table} r WHERE r.rowid IN (${batch.map(() => "?").join(",")}) ${clause.sql}`)
				.get(...batch, ...clause.args);
			if (typeof row?.n === "number") count += row.n;
		}
	}
	return count;
}
function preview(
	db: MigrationDb,
	rows: readonly ContentRow[],
	target: ClassificationTarget,
	scope: ReadScope,
): { evidence: number; derived: number } {
	const selected = rows.filter((r) => covers(target, r, rows));
	const citations = scopedLinks(db, "evidence_citations", rows, 1000000);
	const evidenceIds = new Set(selected.map((r) => JSON.stringify([r.kind, r.row.agent_id, r.key])));
	const derivedIds = new Set(
		citations
			.filter((c) => evidenceIds.has(JSON.stringify([c.evidence_kind, c.agent_id, c.evidence_id])))
			.map((c) => JSON.stringify([DERIVED[String(c.derived_kind)], c.agent_id, c.derived_id])),
	);
	const derived = rows.filter((r) => derivedIds.has(JSON.stringify([r.table, r.row.agent_id, r.key])));
	return {
		evidence: visibleCount(
			db,
			selected.filter((r) => ["memory", "transcript", "artifact", "summary"].includes(r.kind ?? "")),
			scope,
		),
		derived: visibleCount(db, derived, scope),
	};
}
export function executeClassification(db: MigrationDb, request: ClassificationRequest): unknown {
	if (request.op === "readable") return request.subject.local ? "all" : readable(db, request.subject);
	if (request.op === "recover") {
		db.prepare(
			"UPDATE org_jobs SET status='failed',error='interrupted_by_restart',finished_at=? WHERE kind IN ('classify','unclassify') AND status IN ('running','pending')",
		).run(new Date().toISOString());
		return { ok: true };
	}
	if (request.op === "list")
		return db
			.prepare(`SELECT c.* FROM classifications c WHERE ${DEFINITION_AUDIENCE} ORDER BY c.name`)
			.all(Number(request.actor.compliance || request.actor.local), request.actor.userId, request.actor.userId);
	if (request.op === "get") return definition(db, request.id ?? "", request.actor);
	if (request.op === "rebuild")
		return transaction(db, () => {
			backfillEvidenceCitations(db);
			const rows = loadRows(db, request.agentId);
			return { updated: recompute(db, rows, rows) };
		});
	if (request.op === "create") {
		compliance(request.actor);
		return transaction(db, () => {
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
		return preview(db, loadRows(db, request.target.agentId), request.target, request.scope);
	}
	if (request.op === "items") {
		definition(db, request.id, request.actor);
		const audience = matches(db, "classification_audience", request.id, request.actor);
		const predicate = readScopeSql("m", request.scope);
		const args: unknown[] = [request.id];
		let filter = "";
		if (audience) {
			const checks: string[] = [];
			for (const [kind, table, key] of [
				["memory", "memories", "id"],
				["session", "session_transcripts", "session_key"],
				["source", "memory_artifacts", "source_id"],
				["agent", "memories", "agent_id"],
			]) {
				if (!kind || !table || !key) continue;
				const clause = readScopeSql("r", request.scope, { visibility: table === "memories" ? "visibility" : null });
				checks.push(
					`(a.target_kind='${kind}' AND EXISTS(SELECT 1 FROM ${table} r WHERE r.${key}=a.target_id AND r.agent_id=a.agent_id ${clause.sql}))`,
				);
				args.push(...clause.args);
			}
			filter = ` AND (${checks.join(" OR ")})`;
		}
		let cursor: readonly string[] = ["", "", ""];
		if (request.cursor) {
			const value: unknown = JSON.parse(request.cursor);
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
			authorize(db, request.target, request.id, request.actor, request.remove, loadRows(db, request.target.agentId));
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
		const job = db
			.prepare("SELECT * FROM org_jobs WHERE id=? AND status='pending' AND kind IN ('classify','unclassify')")
			.get(request.jobId);
		if (!job || typeof job.params_json !== "string") throw new Error("job_not_pending");
		const parsed: unknown = JSON.parse(job.params_json);
		if (!isEnqueued(parsed)) throw new Error("invalid_job");
		db.prepare("UPDATE org_jobs SET status='running',started_at=? WHERE id=?").run(
			new Date().toISOString(),
			request.jobId,
		);
		try {
			return transaction(db, () => {
				const rows = loadRows(db, parsed.target.agentId);
				authorize(db, parsed.target, parsed.id, parsed.actor, parsed.remove, rows);
				if (parsed.remove)
					db.prepare(
						"DELETE FROM classification_assignments WHERE target_kind=? AND target_id=? AND agent_id=? AND classification_id=?",
					).run(parsed.target.kind, parsed.target.id, parsed.target.agentId, parsed.id);
				else
					db.prepare("INSERT OR IGNORE INTO classification_assignments VALUES (?,?,?,?,?,?)").run(
						parsed.target.kind,
						parsed.target.id,
						parsed.target.agentId,
						parsed.id,
						parsed.actor.userId,
						new Date().toISOString(),
					);
				const updated = recompute(
					db,
					rows,
					rows.filter((r) => covers(parsed.target, r, rows)),
				);
				audit(
					db,
					parsed.actor,
					parsed.remove ? "classification.remove" : "classification.apply",
					parsed.target,
					parsed.id,
					{ updated },
				);
				db.prepare("UPDATE org_jobs SET status='complete',progress_json=?,finished_at=? WHERE id=?").run(
					JSON.stringify({ updated }),
					new Date().toISOString(),
					request.jobId,
				);
				return { updated };
			});
		} catch (error) {
			db.prepare("UPDATE org_jobs SET status='failed',error=?,finished_at=? WHERE id=?").run(
				error instanceof Error ? error.message : "classification_failed",
				new Date().toISOString(),
				request.jobId,
			);
			throw error;
		}
	}
	throw new Error("unsupported_classification_operation");
}
function isEnqueued(value: unknown): value is Extract<ClassificationRequest, { op: "enqueue" }> {
	if (
		typeof value !== "object" ||
		value === null ||
		!("op" in value) ||
		value.op !== "enqueue" ||
		!("id" in value) ||
		typeof value.id !== "string" ||
		!("remove" in value) ||
		typeof value.remove !== "boolean" ||
		!("target" in value) ||
		typeof value.target !== "object" ||
		value.target === null ||
		!("actor" in value) ||
		typeof value.actor !== "object" ||
		value.actor === null
	)
		return false;
	const target = value.target,
		actor = value.actor;
	return (
		"kind" in target &&
		["memory", "session", "source", "agent"].includes(String(target.kind)) &&
		"id" in target &&
		typeof target.id === "string" &&
		"agentId" in target &&
		typeof target.agentId === "string" &&
		"userId" in actor &&
		(typeof actor.userId === "string" || actor.userId === null) &&
		"local" in actor &&
		typeof actor.local === "boolean" &&
		"compliance" in actor &&
		typeof actor.compliance === "boolean" &&
		"credential" in actor &&
		typeof actor.credential === "string" &&
		"groupIds" in actor &&
		Array.isArray(actor.groupIds) &&
		actor.groupIds.every((g) => typeof g === "string")
	);
}
