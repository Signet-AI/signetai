import type { OntologyContradiction, OntologyContradictionStatus } from "@signet/core";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { tableExists } from "./db-helpers";
import { detectProspectiveContradictionRisk } from "./pipeline/antonyms";

export interface ListOntologyContradictionsParams {
	readonly agentId: string;
	readonly entity?: string;
	readonly entityId?: string;
	readonly aspectId?: string;
	readonly groupKey?: string;
	readonly claimKey?: string;
	readonly sourceId?: string;
	readonly status?: OntologyContradictionStatus | "all";
	readonly limit?: number;
	readonly offset?: number;
}

export interface ListOntologyContradictionsResult {
	readonly items: readonly OntologyContradiction[];
	readonly count: number;
	readonly limit: number;
	readonly offset: number;
}

export interface ReconcileOntologyContradictionsParams {
	readonly agentId: string;
	readonly entityId?: string;
	readonly aspectId?: string;
	readonly groupKey?: string;
	readonly claimKey?: string;
	readonly sourceId?: string;
}

interface ClaimRow {
	readonly id: string;
	readonly entityId: string;
	readonly entityName: string;
	readonly aspectId: string;
	readonly aspectName: string;
	readonly groupKey: string;
	readonly claimKey: string;
	readonly kind: string;
	readonly content: string;
	readonly confidence: number;
	readonly memoryId: string | null;
	readonly scope: string | null;
	readonly visibility: string | null;
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly sourceRoot: string | null;
	readonly evidence: readonly unknown[];
}

interface ClaimSnapshot {
	readonly id: string;
	readonly content: string;
	readonly confidence: number;
	readonly scope: string | null;
	readonly visibility: string | null;
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly sourceRoot: string | null;
	readonly evidence: readonly unknown[];
}

interface ContradictionRow {
	readonly id: string;
	readonly agent_id: string;
	readonly entity_id: string | null;
	readonly entity_name: string;
	readonly aspect_id: string | null;
	readonly aspect_name: string;
	readonly group_key: string;
	readonly claim_key: string;
	readonly left_attribute_id: string | null;
	readonly right_attribute_id: string | null;
	readonly left_content: string;
	readonly right_content: string;
	readonly left_confidence: number;
	readonly right_confidence: number;
	readonly left_scope: string | null;
	readonly right_scope: string | null;
	readonly left_visibility: string | null;
	readonly right_visibility: string | null;
	readonly left_source_kind: string | null;
	readonly left_source_id: string | null;
	readonly left_source_path: string | null;
	readonly left_source_root: string | null;
	readonly right_source_kind: string | null;
	readonly right_source_id: string | null;
	readonly right_source_path: string | null;
	readonly right_source_root: string | null;
	readonly left_evidence: string;
	readonly right_evidence: string;
	readonly detector: "lexical" | "semantic" | "manual";
	readonly reason: string;
	readonly confidence: number;
	readonly status: OntologyContradictionStatus;
	readonly detected_at: string;
	readonly resolved_at: string | null;
	readonly resolution_reason: string | null;
	readonly created_at: string;
	readonly updated_at: string;
}

const CONTRADICTION_SELECT = `
	SELECT
		c.*
	FROM ontology_contradictions c`;

function parseJsonArray(value: unknown): readonly unknown[] {
	if (typeof value !== "string") return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [{ raw: value, parseError: "invalid_json_array" }];
	}
}

function trim(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(Math.max(value, 0), 1);
}

function rowToContradiction(row: ContradictionRow): OntologyContradiction {
	return {
		id: row.id,
		agentId: row.agent_id,
		entityId: row.entity_id,
		entityName: row.entity_name,
		aspectId: row.aspect_id,
		aspectName: row.aspect_name,
		groupKey: row.group_key,
		claimKey: row.claim_key,
		leftAttributeId: row.left_attribute_id,
		rightAttributeId: row.right_attribute_id,
		leftContent: row.left_content,
		rightContent: row.right_content,
		leftConfidence: row.left_confidence,
		rightConfidence: row.right_confidence,
		leftScope: row.left_scope,
		rightScope: row.right_scope,
		leftVisibility: row.left_visibility,
		rightVisibility: row.right_visibility,
		leftSourceKind: row.left_source_kind,
		leftSourceId: row.left_source_id,
		leftSourcePath: row.left_source_path,
		leftSourceRoot: row.left_source_root,
		rightSourceKind: row.right_source_kind,
		rightSourceId: row.right_source_id,
		rightSourcePath: row.right_source_path,
		rightSourceRoot: row.right_source_root,
		leftEvidence: parseJsonArray(row.left_evidence),
		rightEvidence: parseJsonArray(row.right_evidence),
		detector: row.detector,
		reason: row.reason,
		confidence: row.confidence,
		status: row.status,
		detectedAt: row.detected_at,
		resolvedAt: row.resolved_at,
		resolutionReason: row.resolution_reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function claimSelect(): string {
	return `
		SELECT
			attr.id,
			asp.entity_id AS entity_id,
			e.name AS entity_name,
			asp.id AS aspect_id,
			asp.name AS aspect_name,
			COALESCE(attr.group_key, 'general') AS group_key,
			attr.claim_key,
			COALESCE(attr.kind, 'attribute') AS kind,
			attr.content,
			attr.confidence,
			attr.memory_id,
			mem.scope,
			mem.visibility,
			attr.source_kind,
			attr.source_id,
			attr.source_path,
			attr.source_root,
			attr.proposal_evidence
		FROM entity_attributes attr
		JOIN entity_aspects asp ON asp.id = attr.aspect_id AND asp.agent_id = attr.agent_id
		JOIN entities e ON e.id = asp.entity_id AND e.agent_id = asp.agent_id
		LEFT JOIN memories mem ON mem.id = attr.memory_id AND mem.agent_id = attr.agent_id`;
}

function claimFromRow(row: Record<string, unknown>): ClaimRow | null {
	const id = trim(row.id);
	const entityId = trim(row.entity_id);
	const entityName = trim(row.entity_name);
	const aspectId = trim(row.aspect_id);
	const aspectName = trim(row.aspect_name);
	const claimKey = trim(row.claim_key);
	const content = trim(row.content);
	if (id === null || entityId === null || entityName === null || aspectId === null || aspectName === null) return null;
	if (claimKey === null || content === null) return null;
	return {
		id,
		entityId,
		entityName,
		aspectId,
		aspectName,
		groupKey: trim(row.group_key) ?? "general",
		claimKey,
		kind: trim(row.kind) ?? "attribute",
		content,
		confidence: clamp01(typeof row.confidence === "number" ? row.confidence : 0),
		memoryId: trim(row.memory_id),
		scope: trim(row.scope),
		visibility: trim(row.visibility),
		sourceKind: trim(row.source_kind),
		sourceId: trim(row.source_id),
		sourcePath: trim(row.source_path),
		sourceRoot: trim(row.source_root),
		evidence: parseJsonArray(row.proposal_evidence),
	};
}

function claimSnapshot(claim: ClaimRow): ClaimSnapshot {
	const evidence = [...claim.evidence];
	if (claim.sourceKind !== null || claim.sourceId !== null || claim.sourcePath !== null || claim.sourceRoot !== null) {
		evidence.push({
			source_kind: claim.sourceKind,
			source_id: claim.sourceId,
			source_path: claim.sourcePath,
			source_root: claim.sourceRoot,
		});
	}
	if (claim.memoryId !== null) evidence.push({ memory_id: claim.memoryId });
	return {
		id: claim.id,
		content: claim.content,
		confidence: claim.confidence,
		scope: claim.scope,
		visibility: claim.visibility,
		sourceKind: claim.sourceKind,
		sourceId: claim.sourceId,
		sourcePath: claim.sourcePath,
		sourceRoot: claim.sourceRoot,
		evidence,
	};
}

function canonicalPair(
	first: ClaimRow,
	second: ClaimRow,
): { readonly left: ClaimSnapshot; readonly right: ClaimSnapshot } {
	const firstSnapshot = claimSnapshot(first);
	const secondSnapshot = claimSnapshot(second);
	if (first.id < second.id) return { left: firstSnapshot, right: secondSnapshot };
	return { left: secondSnapshot, right: firstSnapshot };
}

function readActiveClaim(db: ReadDb | WriteDb, agentId: string, attributeId: string | null): ClaimRow | null {
	if (attributeId === null) return null;
	const row = db
		.prepare(`${claimSelect()}
			WHERE attr.id = ? AND attr.agent_id = ? AND attr.status = 'active'
			  AND COALESCE(asp.status, 'active') = 'active'
			  AND COALESCE(e.status, 'active') = 'active'`)
		.get(attributeId, agentId) as Record<string, unknown> | undefined | null;
	return row == null ? null : claimFromRow(row);
}

function readClaim(db: WriteDb, agentId: string, attributeId: string): ClaimRow | null {
	const row = db
		.prepare(`${claimSelect()}
			WHERE attr.id = ? AND attr.agent_id = ?`)
		.get(attributeId, agentId) as Record<string, unknown> | undefined | null;
	return row == null ? null : claimFromRow(row);
}

function insertOrReactivateContradiction(
	db: WriteDb,
	input: {
		readonly agentId: string;
		readonly entityId: string;
		readonly entityName: string;
		readonly aspectId: string;
		readonly aspectName: string;
		readonly groupKey: string;
		readonly claimKey: string;
		readonly left: ClaimSnapshot;
		readonly right: ClaimSnapshot;
		readonly reason: string;
	},
): string {
	const existing = db
		.prepare(
			`SELECT id, status FROM ontology_contradictions
			 WHERE agent_id = ? AND left_attribute_id = ? AND right_attribute_id = ?`,
		)
		.get(input.agentId, input.left.id, input.right.id) as
		| { id: string; status: OntologyContradictionStatus }
		| null
		| undefined;
	const timestamp = new Date().toISOString();
	if (existing != null) {
		db.prepare(
			`UPDATE ontology_contradictions
			 SET entity_id = ?, entity_name = ?, aspect_id = ?, aspect_name = ?,
			     group_key = ?, claim_key = ?, left_content = ?, right_content = ?,
			     left_confidence = ?, right_confidence = ?, left_scope = ?, right_scope = ?,
			     left_visibility = ?, right_visibility = ?, left_source_kind = ?, left_source_id = ?,
			     left_source_path = ?, left_source_root = ?, right_source_kind = ?, right_source_id = ?,
			     right_source_path = ?, right_source_root = ?, left_evidence = ?, right_evidence = ?,
			     detector = 'lexical', reason = ?, confidence = 1.0, status = 'active',
			     detected_at = ?, resolved_at = NULL, resolution_reason = NULL, updated_at = ?
			 WHERE id = ? AND agent_id = ?`,
		).run(
			input.entityId,
			input.entityName,
			input.aspectId,
			input.aspectName,
			input.groupKey,
			input.claimKey,
			input.left.content,
			input.right.content,
			input.left.confidence,
			input.right.confidence,
			input.left.scope,
			input.right.scope,
			input.left.visibility,
			input.right.visibility,
			input.left.sourceKind,
			input.left.sourceId,
			input.left.sourcePath,
			input.left.sourceRoot,
			input.right.sourceKind,
			input.right.sourceId,
			input.right.sourcePath,
			input.right.sourceRoot,
			JSON.stringify(input.left.evidence),
			JSON.stringify(input.right.evidence),
			input.reason,
			timestamp,
			timestamp,
			existing.id,
			input.agentId,
		);
		return existing.id;
	}

	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO ontology_contradictions
		 (id, agent_id, entity_id, entity_name, aspect_id, aspect_name, group_key, claim_key,
		  left_attribute_id, right_attribute_id, left_content, right_content,
		  left_confidence, right_confidence, left_scope, right_scope, left_visibility, right_visibility,
		  left_source_kind, left_source_id, left_source_path, left_source_root,
		  right_source_kind, right_source_id, right_source_path, right_source_root,
		  left_evidence, right_evidence, detector, reason, confidence, status,
		  detected_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
		         'lexical', ?, 1.0, 'active', ?, ?, ?)`,
	).run(
		id,
		input.agentId,
		input.entityId,
		input.entityName,
		input.aspectId,
		input.aspectName,
		input.groupKey,
		input.claimKey,
		input.left.id,
		input.right.id,
		input.left.content,
		input.right.content,
		input.left.confidence,
		input.right.confidence,
		input.left.scope,
		input.right.scope,
		input.left.visibility,
		input.right.visibility,
		input.left.sourceKind,
		input.left.sourceId,
		input.left.sourcePath,
		input.left.sourceRoot,
		input.right.sourceKind,
		input.right.sourceId,
		input.right.sourcePath,
		input.right.sourceRoot,
		JSON.stringify(input.left.evidence),
		JSON.stringify(input.right.evidence),
		input.reason,
		timestamp,
		timestamp,
		timestamp,
	);
	return id;
}

export function recordOntologyContradictionsForAttributeInTx(
	db: WriteDb,
	input: { readonly agentId: string; readonly attributeId: string },
): readonly string[] {
	if (!tableExists(db, "ontology_contradictions")) return [];
	const candidate = readClaim(db, input.agentId, input.attributeId);
	if (candidate === null || candidate.kind === "constraint") return [];
	const rows = db
		.prepare(`${claimSelect()}
			WHERE attr.agent_id = ? AND attr.aspect_id = ? AND attr.id != ?
			  AND attr.status = 'active'
			  AND COALESCE(asp.status, 'active') = 'active'
			  AND COALESCE(e.status, 'active') = 'active'
			  AND COALESCE(attr.group_key, 'general') = ?
			  AND attr.claim_key = ?
			  AND COALESCE(attr.kind, 'attribute') != 'constraint'`)
		.all(input.agentId, candidate.aspectId, candidate.id, candidate.groupKey, candidate.claimKey) as Array<
		Record<string, unknown>
	>;
	const contradictionIds: string[] = [];
	for (const row of rows) {
		const other = claimFromRow(row);
		if (other === null) continue;
		const detection = detectProspectiveContradictionRisk(candidate.content, other.content);
		if (!detection.detected || detection.reason === null) continue;
		contradictionIds.push(
			insertOrReactivateContradiction(db, {
				agentId: input.agentId,
				entityId: candidate.entityId,
				entityName: candidate.entityName,
				aspectId: candidate.aspectId,
				aspectName: candidate.aspectName,
				groupKey: candidate.groupKey,
				claimKey: candidate.claimKey,
				...canonicalPair(candidate, other),
				reason: detection.reason,
			}),
		);
	}
	return contradictionIds;
}

function contradictionScopeWhere(params: ReconcileOntologyContradictionsParams): {
	readonly where: string[];
	readonly args: unknown[];
} {
	const where = ["c.agent_id = ?", "c.status = 'active'"];
	const args: unknown[] = [params.agentId];
	if (params.entityId !== undefined) {
		where.push("c.entity_id = ?");
		args.push(params.entityId);
	}
	if (params.aspectId !== undefined) {
		where.push("c.aspect_id = ?");
		args.push(params.aspectId);
	}
	if (params.groupKey !== undefined) {
		where.push("c.group_key = ?");
		args.push(params.groupKey);
	}
	if (params.claimKey !== undefined) {
		where.push("c.claim_key = ?");
		args.push(params.claimKey);
	}
	if (params.sourceId !== undefined) {
		where.push("(c.left_source_id = ? OR c.right_source_id = ?)");
		args.push(params.sourceId, params.sourceId);
	}
	return { where, args };
}

export function reconcileOntologyContradictionsInTx(
	db: WriteDb,
	params: ReconcileOntologyContradictionsParams,
): number {
	if (!tableExists(db, "ontology_contradictions")) return 0;
	const scope = contradictionScopeWhere(params);
	const rows = db
		.prepare(`${CONTRADICTION_SELECT}
			WHERE ${scope.where.join(" AND ")}`)
		.all(...scope.args) as Array<ContradictionRow>;
	let resolved = 0;
	for (const row of rows) {
		const left = readActiveClaim(db, params.agentId, row.left_attribute_id);
		const right = readActiveClaim(db, params.agentId, row.right_attribute_id);
		const stillContradictory =
			left !== null &&
			right !== null &&
			left.entityId === right.entityId &&
			left.aspectId === right.aspectId &&
			left.groupKey === right.groupKey &&
			left.claimKey === right.claimKey &&
			left.kind !== "constraint" &&
			right.kind !== "constraint" &&
			detectProspectiveContradictionRisk(left.content, right.content).detected;
		if (stillContradictory) continue;
		const reason =
			left === null || right === null ? "one competing claim is no longer active" : "claims no longer conflict";
		const timestamp = new Date().toISOString();
		db.prepare(
			`UPDATE ontology_contradictions
			 SET status = 'resolved', resolved_at = ?, resolution_reason = ?, updated_at = ?
			 WHERE id = ? AND agent_id = ? AND status = 'active'`,
		).run(timestamp, reason, timestamp, row.id, params.agentId);
		resolved++;
	}
	return resolved;
}

export function reconcileOntologyContradictions(
	accessor: DbAccessor,
	params: ReconcileOntologyContradictionsParams,
): number {
	return accessor.withWriteTx((db) => reconcileOntologyContradictionsInTx(db, params));
}

export function listOntologyContradictions(
	accessor: DbAccessor,
	params: ListOntologyContradictionsParams,
): ListOntologyContradictionsResult {
	const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
	const offset = Math.max(params.offset ?? 0, 0);
	reconcileOntologyContradictions(accessor, { agentId: params.agentId, sourceId: params.sourceId });
	return accessor.withReadDb((db) => {
		const where = ["c.agent_id = ?"];
		const args: unknown[] = [params.agentId];
		if (params.status !== "all") {
			where.push("c.status = ?");
			args.push(params.status ?? "active");
		}
		if (params.entityId !== undefined) {
			where.push("c.entity_id = ?");
			args.push(params.entityId);
		}
		if (params.entity !== undefined) {
			where.push("LOWER(c.entity_name) = LOWER(?)");
			args.push(params.entity);
		}
		if (params.aspectId !== undefined) {
			where.push("c.aspect_id = ?");
			args.push(params.aspectId);
		}
		if (params.groupKey !== undefined) {
			where.push("c.group_key = ?");
			args.push(params.groupKey);
		}
		if (params.claimKey !== undefined) {
			where.push("c.claim_key = ?");
			args.push(params.claimKey);
		}
		if (params.sourceId !== undefined) {
			where.push("(c.left_source_id = ? OR c.right_source_id = ?)");
			args.push(params.sourceId, params.sourceId);
		}
		const clause = where.join(" AND ");
		const rows = db
			.prepare(`${CONTRADICTION_SELECT}
				WHERE ${clause}
				ORDER BY CASE WHEN c.status = 'active' THEN 0 ELSE 1 END, c.updated_at DESC
				LIMIT ? OFFSET ?`)
			.all(...args, limit, offset) as Array<ContradictionRow>;
		const count = db.prepare(`SELECT COUNT(*) AS count FROM ontology_contradictions c WHERE ${clause}`).get(...args) as
			| { count: number }
			| undefined;
		return {
			items: rows.map(rowToContradiction),
			count: count?.count ?? rows.length,
			limit,
			offset,
		};
	});
}

export function getOntologyContradiction(
	accessor: DbAccessor,
	params: { readonly agentId: string; readonly id: string },
): OntologyContradiction | null {
	reconcileOntologyContradictions(accessor, { agentId: params.agentId });
	return accessor.withReadDb((db) => {
		const row = db
			.prepare(`${CONTRADICTION_SELECT}
				WHERE c.id = ? AND c.agent_id = ?`)
			.get(params.id, params.agentId) as ContradictionRow | undefined | null;
		return row == null ? null : rowToContradiction(row);
	});
}

export function parseOntologyContradictionStatus(
	value: string | undefined,
): OntologyContradictionStatus | "all" | undefined {
	const normalized = value?.trim();
	if (normalized === "all") return "all";
	if (normalized === "active" || normalized === "resolved") return normalized;
	return undefined;
}
