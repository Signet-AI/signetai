import { randomUUID } from "node:crypto";
import { prepareTypedStatement, type DbAccessor, type ReadDb, type WriteDb } from "../db-accessor";
import { ownerQueryAll } from "../db-owner-maintenance";
import { getDbOwnerForAccessor } from "../db-owner-runtime";
import { readScopeSql, type ReadScope } from "../read-scope";
import { timestampMillis } from "../episodic-sources";

export const DREAMING_ATTENTION_KINDS = [
	"review_due",
	"hygiene",
	"contested_claim",
	"evidence_requeue",
	"surprisal",
] as const;
export type DreamingAttentionKind = (typeof DREAMING_ATTENTION_KINDS)[number];
export const DREAMING_CONTENT_ATTENTION_KINDS = [
	"review_due",
	"contested_claim",
	"evidence_requeue",
	"surprisal",
] as const;

const AGENT_FACING_ATTENTION_FILTER = "AND NOT (kind = 'evidence_requeue' AND subject_ref LIKE 'source:%')";

export interface DreamingAttention {
	readonly id: string;
	readonly kind: DreamingAttentionKind;
	readonly subjectRef: string;
	readonly details: Readonly<Record<string, string>>;
	readonly priority: number;
	readonly createdAt: string;
}

export interface DreamingAttentionSnapshot extends DreamingAttention {
	readonly generation: number;
}

export interface DreamingAttentionWorkloadDiagnostics {
	readonly pending: number;
	readonly oldestAgeMs: number | null;
}

function parseDetails(value: string): Readonly<Record<string, string>> {
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).flatMap(([key, detail]) =>
				typeof detail === "string" && key.length <= 64 && detail.length <= 1_000 ? [[key, detail]] : [],
			),
		);
	} catch {
		return {};
	}
}

function boundedPriority(priority: number | undefined): number {
	if (!Number.isFinite(priority)) return 0;
	return Math.max(0, Math.min(100, Math.floor(priority ?? 0)));
}

function normalizedSubjectRef(subjectRef: string): string {
	const normalized = subjectRef.trim();
	if (!normalized || normalized.length > 512) {
		throw new Error("Dreaming attention subjectRef must be between 1 and 512 characters");
	}
	return normalized;
}

function normalizedDetails(details: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Object.entries(details ?? {}).flatMap(([key, value]) =>
			typeof value === "string" && key.length <= 64 && value.length <= 1_000 ? [[key, value]] : [],
		),
	);
}

function promptJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function attentionScope(readScope?: ReadScope): { sql: string; args: (string | number)[] } {
	if (!readScope) return { sql: "", args: [] };
	if (readScope.projects !== null) return { sql: " AND 0", args: [] };
	const scope = readScopeSql("", readScope, { visibility: null, memory: null, session: null, source: null });
	return {
		...scope,
		args: scope.args.map((value) => {
			if (typeof value === "string" || typeof value === "number") return value;
			throw new Error("Invalid read scope parameter");
		}),
	};
}

function getDreamingAttentionSnapshotsInDb(
	db: ReadDb,
	agentId: string,
	limit = 20,
	readScope?: ReadScope,
): readonly DreamingAttentionSnapshot[] {
	const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
	const scope = attentionScope(readScope);
	const rows = prepareTypedStatement<{
		id: string;
		kind: DreamingAttentionKind;
		subjectRef: string;
		detailsJson: string;
		priority: number;
		createdAt: string;
		generation: number;
	}>(
		db,
		`SELECT id, kind, subject_ref AS subjectRef, details_json AS detailsJson,
		priority, created_at AS createdAt, generation FROM dreaming_attention
		WHERE agent_id = ? AND resolved_at IS NULL ${scope.sql}
		ORDER BY priority DESC, created_at ASC, id ASC LIMIT ?`,
	).all(agentId, ...scope.args, boundedLimit);
	return rows.map(({ detailsJson, ...attention }) => ({ ...attention, details: parseDetails(detailsJson) }));
}

export function getDreamingAttentionInDb(
	db: ReadDb,
	agentId: string,
	limit = 20,
	readScope?: ReadScope,
): readonly DreamingAttention[] {
	return getDreamingAttentionSnapshotsInDb(db, agentId, limit, readScope).map(
		({ generation: _, ...attention }) => attention,
	);
}

export function hasDreamingAttentionKindInDb(
	db: ReadDb,
	agentId: string,
	kinds: readonly DreamingAttentionKind[],
	readScope?: ReadScope,
): boolean {
	if (kinds.length === 0) return false;
	const scope = attentionScope(readScope);
	const placeholders = kinds.map(() => "?").join(", ");
	return (
		db
			.prepare(
				`SELECT 1 FROM dreaming_attention
				 WHERE agent_id = ? AND resolved_at IS NULL AND kind IN (${placeholders}) ${scope.sql}
				 LIMIT 1`,
			)
			.get(agentId, ...kinds, ...scope.args) != null
	);
}

export function getDreamingAttention(
	accessor: DbAccessor,
	agentId: string,
	limit?: number,
	readScope?: ReadScope,
): readonly DreamingAttention[] {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb(
		(db: import("../db-accessor").ReadDb) => getDreamingAttentionInDb(db, agentId, limit, readScope),
		"pipeline/dreaming-attention.ts:159",
	);
}

export function getDreamingAttentionWorkloadDiagnostics(
	accessor: DbAccessor,
	agentId: string,
	nowMs = Date.now(),
	readScope?: ReadScope,
): DreamingAttentionWorkloadDiagnostics {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
		const scope = attentionScope(readScope);
		const row = prepareTypedStatement<{ pending: number; oldestCreatedAt: string | null }>(
			db,
			`SELECT COUNT(*) AS pending, MIN(created_at) AS oldestCreatedAt
				 FROM dreaming_attention
				 WHERE agent_id = ? AND resolved_at IS NULL ${scope.sql}`,
		).get(agentId, ...scope.args);
		if (!row || row.pending === 0 || row.oldestCreatedAt === null) {
			return { pending: 0, oldestAgeMs: null };
		}
		const oldestMs = timestampMillis(row.oldestCreatedAt);
		return {
			pending: row.pending,
			oldestAgeMs: oldestMs > 0 ? Math.max(0, nowMs - oldestMs) : null,
		};
	}, "pipeline/dreaming-attention.ts:172");
}
export async function getDreamingAttentionScoped(
	accessor: DbAccessor,
	agentId: string,
	options: {
		readonly kind?: string;
		readonly status?: "pending" | "resolved";
		readonly limit?: number;
		readonly agentFacing?: boolean;
		readonly readScope?: ReadScope;
	},
): Promise<readonly DreamingAttention[]> {
	const scope = attentionScope(options.readScope);
	const boundedLimit = Math.max(1, Math.min(Math.floor(options.limit ?? 20), 100));
	const kindFilter = typeof options.kind === "string" && options.kind.length > 0 ? "AND kind = ?" : "";
	const statusFilter = options.status === "resolved" ? "AND resolved_at IS NOT NULL" : "AND resolved_at IS NULL";
	const audienceFilter = options.agentFacing === true ? AGENT_FACING_ATTENTION_FILTER : "";
	const params: (string | number)[] = [agentId, ...scope.args];
	if (kindFilter && options.kind !== undefined) params.push(options.kind);
	const rows = await ownerQueryAll<{
		id: string;
		kind: DreamingAttentionKind;
		subjectRef: string;
		detailsJson: string;
		priority: number;
		createdAt: string;
	}>(
		await getDbOwnerForAccessor(accessor),
		"dreaming.attention.scoped",
		`SELECT id, kind, subject_ref AS subjectRef, details_json AS detailsJson, priority, created_at AS createdAt
		 FROM dreaming_attention
		 WHERE agent_id = ? ${scope.sql} ${kindFilter} ${statusFilter} ${audienceFilter}
		 ORDER BY priority DESC, created_at ASC, id ASC
		 LIMIT ?`,
		[...params, boundedLimit],
		{ deadlineMs: 30_000, estimatedWorkUnits: 1 },
	);
	return rows.map(({ detailsJson, ...attention }) => ({
		...attention,
		details: parseDetails(detailsJson),
	}));
}
export function getDreamingAttentionAcrossScopes(
	accessor: DbAccessor,
	options: {
		readonly kind?: string;
		readonly status?: "pending" | "resolved";
		readonly limit?: number;
		readonly agentFacing?: boolean;
		readonly readScope?: ReadScope;
	},
): readonly (DreamingAttention & { readonly agentId: string })[] {
	const scope = attentionScope(options.readScope);
	const boundedLimit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 200));
	const kindFilter = typeof options.kind === "string" && options.kind.length > 0 ? "AND kind = ?" : "";
	const statusFilter = options.status === "resolved" ? "AND resolved_at IS NOT NULL" : "AND resolved_at IS NULL";
	const audienceFilter = options.agentFacing === true ? AGENT_FACING_ATTENTION_FILTER : "";
	const params: unknown[] = [...scope.args];
	if (kindFilter) params.push(options.kind);
	params.push(boundedLimit);
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
		const rows = prepareTypedStatement<{
			agentId: string;
			id: string;
			kind: DreamingAttentionKind;
			subjectRef: string;
			detailsJson: string;
			priority: number;
			createdAt: string;
		}>(
			db,
			`SELECT agent_id AS agentId, id, kind, subject_ref AS subjectRef, details_json AS detailsJson,
				        priority, created_at AS createdAt
				 FROM dreaming_attention
				 WHERE 1=1 ${scope.sql} ${kindFilter} ${statusFilter} ${audienceFilter}
				 ORDER BY priority DESC, created_at ASC, id ASC
				 LIMIT ?`,
		).all(...params);
		return rows.map(({ detailsJson, ...attention }) => ({
			...attention,
			details: parseDetails(detailsJson),
		}));
	}, "pipeline/dreaming-attention.ts:250");
}

export function getDreamingAttentionById(
	accessor: DbAccessor,
	input: { readonly agentId: string; readonly id: string; readonly readScope?: ReadScope },
): DreamingAttention | null {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
		const scope = attentionScope(input.readScope);
		const row = prepareTypedStatement<{
			id: string;
			kind: DreamingAttentionKind;
			subjectRef: string;
			detailsJson: string;
			priority: number;
			createdAt: string;
		}>(
			db,
			`SELECT id, kind, subject_ref AS subjectRef, details_json AS detailsJson, priority, created_at AS createdAt
			FROM dreaming_attention WHERE id = ? AND agent_id = ? AND resolved_at IS NULL ${scope.sql}`,
		).get(input.id, input.agentId, ...scope.args);
		if (!row) return null;
		return {
			id: row.id,
			kind: row.kind,
			subjectRef: row.subjectRef,
			details: parseDetails(row.detailsJson),
			priority: row.priority,
			createdAt: row.createdAt,
		};
	}, "pipeline/dreaming-attention.ts:280");
}

export function getDreamingAttentionSnapshots(
	accessor: DbAccessor,
	agentId: string,
	limit?: number,
	readScope?: ReadScope,
): readonly DreamingAttentionSnapshot[] {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb(
		(db: import("../db-accessor").ReadDb) => getDreamingAttentionSnapshotsInDb(db, agentId, limit, readScope),
		"pipeline/dreaming-attention.ts:313",
	);
}

function attentionSourceInDb(db: WriteDb, agentId: string, subjectRef: string) {
	const colon = subjectRef.indexOf(":");
	const kind = subjectRef.slice(0, colon);
	const sourceId = subjectRef.slice(colon + 1);
	const definitions: Readonly<Record<string, readonly [string, string, string]>> = {
		memory: ["memories", "id", "memory"],
		transcript: ["session_transcripts", "session_key", "transcript"],
		artifact: ["memory_artifacts", "source_path", "artifact"],
		summary: ["session_summaries", "id", "summary"],
		entity: ["entities", "id", "attribute"],
		aspect: ["entity_aspects", "id", "attribute"],
		attribute: ["entity_attributes", "id", "attribute"],
		claim: ["entity_attributes", "id", "attribute"],
		link: ["entity_dependencies", "id", "attribute"],
	};
	const definition = definitions[kind];
	if (colon < 1 || !sourceId || !definition) return null;
	const [table, key, evidenceKind] = definition;
	const row = prepareTypedStatement<{ compartment_id: number | null }>(
		db,
		`SELECT compartment_id FROM ${table} WHERE ${key}=? AND agent_id=?`,
	).get(sourceId, agentId);
	return row ? { evidenceKind, sourceId, compartmentId: row.compartment_id } : null;
}

export function enqueueDreamingAttentionInTx(
	db: WriteDb,
	input: {
		readonly agentId: string;
		readonly kind: DreamingAttentionKind;
		readonly subjectRef: string;
		readonly details?: Readonly<Record<string, string>>;
		readonly priority?: number;
		readonly reopen?: boolean;
		readonly compartmentId?: number | null;
		readonly passId?: string;
	},
): string {
	if (!DREAMING_ATTENTION_KINDS.includes(input.kind)) {
		throw new Error(`Unsupported Dreaming attention kind: ${input.kind}`);
	}
	const subjectRef = normalizedSubjectRef(input.subjectRef);
	const source = attentionSourceInDb(db, input.agentId, subjectRef);
	const compartmentId = input.compartmentId === undefined ? (source?.compartmentId ?? null) : input.compartmentId;
	const details = JSON.stringify(normalizedDetails(input.details));
	const reopen = input.reopen !== false ? 1 : 0;
	const attentionId = randomUUID();
	db.prepare(
		`INSERT INTO dreaming_attention
		 (id, agent_id, kind, subject_ref, details_json, priority, compartment_id, dreaming_pass_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(agent_id, kind, subject_ref) DO UPDATE SET
		   details_json = excluded.details_json,
		   compartment_id = excluded.compartment_id,
		   dreaming_pass_id = COALESCE(excluded.dreaming_pass_id, dreaming_attention.dreaming_pass_id),
		   priority = MAX(dreaming_attention.priority, excluded.priority),
		   generation = CASE WHEN ? = 1 OR dreaming_attention.details_json <> excluded.details_json THEN dreaming_attention.generation + 1 ELSE dreaming_attention.generation END,
		   resolved_at = CASE WHEN ? = 1 OR dreaming_attention.details_json <> excluded.details_json THEN NULL ELSE dreaming_attention.resolved_at END,
		   resolved_by_pass_id = CASE WHEN ? = 1 OR dreaming_attention.details_json <> excluded.details_json THEN NULL ELSE dreaming_attention.resolved_by_pass_id END`,
	).run(
		attentionId,
		input.agentId,
		input.kind,
		subjectRef,
		details,
		boundedPriority(input.priority),
		compartmentId,
		input.passId ?? null,
		reopen,
		reopen,
		reopen,
	);
	const stored = prepareTypedStatement<{ id: string }>(
		db,
		"SELECT id FROM dreaming_attention WHERE agent_id = ? AND kind = ? AND subject_ref = ?",
	).get(input.agentId, input.kind, subjectRef);
	const id = stored?.id ?? attentionId;
	if (source)
		db.prepare(
			"INSERT INTO evidence_citations(derived_kind,derived_id,agent_id,evidence_kind,evidence_id) VALUES('attention',?,?,?,?) ON CONFLICT DO NOTHING",
		).run(id, input.agentId, source.evidenceKind, source.sourceId);
	return id;
}

export function resolveDreamingAttentionInTx(
	db: WriteDb,
	agentId: string,
	passId: string,
	attention: readonly DreamingAttentionSnapshot[],
): void {
	const statement = db.prepare(
		`UPDATE dreaming_attention
		 SET resolved_at = datetime('now'), resolved_by_pass_id = ?
		 WHERE id = ? AND agent_id = ? AND generation = ? AND resolved_at IS NULL`,
	);
	for (const item of attention) statement.run(passId, item.id, agentId, item.generation);
}

export function renderDreamingAttentionForPrompt(attention: readonly DreamingAttention[]): string {
	if (attention.length === 0) return "";
	return attention
		.map(
			(item) =>
				`- ${promptJson({ id: item.id, kind: item.kind, subjectRef: item.subjectRef, details: item.details, priority: item.priority })}`,
		)
		.join("\n");
}
