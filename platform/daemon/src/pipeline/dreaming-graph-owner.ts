import { attempt } from "@signet/core";
import { prepareTypedStatement, type ReadDb } from "../db-accessor";
import { classifyEntityQuality } from "../entity-quality";
import { readScopeSql, type ReadScope } from "../read-scope";
import { detectProspectiveContradictionRisk } from "./antonyms";

interface GraphInput {
	readonly agentId: string;
	readonly readScope: ReadScope;
}
interface PageInput {
	readonly limit?: number;
	readonly offset?: number;
}
export interface DreamingGraphOutput {
	readonly ok: boolean;
	readonly [key: string]: unknown;
}
function page(input: PageInput, fallback = 50, maximum = 200): readonly [number, number] {
	const limit = input.limit !== undefined && Number.isFinite(input.limit) ? Math.floor(input.limit) : fallback;
	const offset = input.offset !== undefined && Number.isFinite(input.offset) ? Math.floor(input.offset) : 0;
	return [Math.max(1, Math.min(maximum, limit)), Math.max(0, offset)];
}
function graphScope(input: GraphInput) {
	if (!input.agentId.trim()) throw new Error("agent_required");
	const args: unknown[] = [];
	const predicate = (alias: string, source: string | null = null) => {
		const scope =
			input.readScope.projects !== null
				? { sql: " AND 0", args: [] }
				: readScopeSql(alias, input.readScope, { visibility: null, memory: null, session: null, source });
		args.push(input.agentId, ...scope.args);
		return `${alias}.agent_id = ? ${scope.sql} AND COALESCE(${alias}.status,'active') = 'active'`;
	};
	const sql = `WITH visible_entities AS (
		SELECT e.* FROM entities e WHERE ${predicate("e", "source_id")}
	), visible_aspects AS (
		SELECT asp.* FROM entity_aspects asp JOIN visible_entities e ON e.id=asp.entity_id AND e.agent_id=asp.agent_id
		WHERE ${predicate("asp")}
	), visible_attributes AS (
		SELECT attr.* FROM entity_attributes attr JOIN visible_aspects asp ON asp.id=attr.aspect_id AND asp.agent_id=attr.agent_id
		WHERE ${predicate("attr", "source_id")}
	), visible_dependencies AS (
		SELECT dep.* FROM entity_dependencies dep
		JOIN visible_entities src ON src.id=dep.source_entity_id AND src.agent_id=dep.agent_id
		JOIN visible_entities dst ON dst.id=dep.target_entity_id AND dst.agent_id=dep.agent_id
		WHERE ${predicate("dep")} AND (dep.aspect_id IS NULL OR EXISTS (
			SELECT 1 FROM visible_aspects asp WHERE asp.id=dep.aspect_id AND asp.agent_id=dep.agent_id
		))
	), visible_contradictions AS (
		SELECT c.* FROM ontology_contradictions c
		JOIN visible_aspects asp ON asp.id=c.aspect_id AND asp.entity_id=c.entity_id AND asp.agent_id=c.agent_id
		JOIN visible_attributes l ON l.id=c.left_attribute_id AND l.aspect_id=asp.id AND l.agent_id=c.agent_id
		JOIN visible_attributes r ON r.id=c.right_attribute_id AND r.aspect_id=asp.id AND r.agent_id=c.agent_id
		WHERE ${predicate("c")}
	)`;
	return { sql, args };
}
const entityProjection = `e.id,e.name,e.canonical_name AS canonicalName,e.entity_type AS entityType,
	e.agent_id AS agentId,substr(e.description,1,2000) AS description,e.mentions,e.pinned,e.pinned_at AS pinnedAt,
	e.status,e.created_at AS createdAt,e.updated_at AS updatedAt,
	json_array_length(CASE WHEN json_valid(e.proposal_evidence) THEN e.proposal_evidence ELSE '[]' END) AS proposalEvidenceCount`;
const entityCounts = `
	(SELECT COUNT(*) FROM visible_aspects asp WHERE asp.entity_id=e.id) AS aspectCount,
	(SELECT COUNT(*) FROM visible_attributes attr JOIN visible_aspects asp ON asp.id=attr.aspect_id WHERE asp.entity_id=e.id AND attr.kind='attribute') AS attributeCount,
	(SELECT COUNT(*) FROM visible_attributes attr JOIN visible_aspects asp ON asp.id=attr.aspect_id WHERE asp.entity_id=e.id AND attr.kind='constraint') AS constraintCount,
	(SELECT COUNT(*) FROM visible_dependencies dep WHERE dep.source_entity_id=e.id OR dep.target_entity_id=e.id) AS dependencyCount`;
const entityOrder = "e.pinned DESC,e.pinned_at DESC,e.mentions DESC,e.updated_at DESC,e.name ASC,e.id ASC";

export function searchEntitiesInDb(
	db: ReadDb,
	input: GraphInput & PageInput & { readonly query?: string; readonly type?: string },
): DreamingGraphOutput {
	const scope = graphScope(input);
	const args = [...scope.args];
	let filters = "";
	if (input.query?.trim()) {
		filters += " AND instr(e.canonical_name,?)>0";
		args.push(input.query.trim().toLowerCase());
	}
	if (input.type) {
		filters += " AND e.entity_type=?";
		args.push(input.type);
	}
	const rows = prepareTypedStatement<Record<string, unknown>>(
		db,
		`${scope.sql}
		SELECT ${entityProjection},${entityCounts} FROM visible_entities e WHERE 1=1 ${filters}
		ORDER BY ${entityOrder} LIMIT ? OFFSET ?`,
	).all(...args, ...page(input, 20, 100));
	return { ok: true, items: rows.map((row) => ({ ...row, pinned: row.pinned === 1 })) };
}
export function entityDetailInDb(
	db: ReadDb,
	input: GraphInput &
		PageInput & {
			readonly entityId: string;
			readonly include?: readonly string[];
			readonly direction?: "incoming" | "outgoing" | "both";
		},
): DreamingGraphOutput {
	const scope = graphScope(input);
	const entity = prepareTypedStatement<Record<string, unknown>>(
		db,
		`${scope.sql}
		SELECT ${entityProjection},${entityCounts} FROM visible_entities e WHERE e.id=?`,
	).get(...scope.args, input.entityId);
	if (!entity) return { ok: false, error: "Entity not found" };
	const result: Record<string, unknown> = {
		ok: true,
		entity: { ...entity, pinned: entity.pinned === 1 },
		pinned: entity.pinned === 1,
		aspectCount: entity.aspectCount,
		attributeCount: entity.attributeCount,
		constraintCount: entity.constraintCount,
		dependencyCount: entity.dependencyCount,
	};
	const [limit, offset] = page(input);
	if (input.include?.includes("aspects")) {
		const aspects = prepareTypedStatement<Record<string, unknown>>(
			db,
			`${scope.sql}
			SELECT asp.id,substr(asp.name,1,2000) AS name,
			(SELECT COUNT(*) FROM visible_attributes attr WHERE attr.aspect_id=asp.id AND attr.kind='attribute') AS attributeCount,
			(SELECT COUNT(*) FROM visible_attributes attr WHERE attr.aspect_id=asp.id AND attr.kind='constraint') AS constraintCount
			FROM visible_aspects asp WHERE asp.entity_id=? ORDER BY asp.weight DESC,asp.name,asp.id LIMIT ? OFFSET ?`,
		).all(...scope.args, input.entityId, limit, offset);
		result.aspects = aspects;
		result.aspectsOffset = offset;
		result.aspectsTruncated = offset + aspects.length < Number(entity.aspectCount);
	}
	if (input.include?.includes("links")) {
		const direction = input.direction ?? "both";
		const filter =
			direction === "incoming"
				? "dep.target_entity_id=?"
				: direction === "outgoing"
					? "dep.source_entity_id=?"
					: "(dep.source_entity_id=? OR dep.target_entity_id=?)";
		const ids = direction === "both" ? [input.entityId, input.entityId] : [input.entityId];
		const links = prepareTypedStatement<Record<string, unknown>>(
			db,
			`${scope.sql}
			SELECT dep.id,CASE WHEN dep.source_entity_id=? THEN 'outgoing' ELSE 'incoming' END AS direction,
			dep.dependency_type AS dependencyType,dep.strength,dep.aspect_id AS aspectId,substr(dep.reason,1,2000) AS reason,
			dep.source_entity_id AS sourceEntityId,src.name AS sourceEntityName,dep.target_entity_id AS targetEntityId,dst.name AS targetEntityName,
			dep.created_at AS createdAt,dep.updated_at AS updatedAt
			FROM visible_dependencies dep JOIN visible_entities src ON src.id=dep.source_entity_id JOIN visible_entities dst ON dst.id=dep.target_entity_id
			WHERE ${filter} ORDER BY dep.strength DESC,dep.updated_at DESC,dep.id LIMIT ? OFFSET ?`,
		).all(...scope.args, input.entityId, ...ids, limit, offset);
		const count =
			prepareTypedStatement<{ count: number }>(
				db,
				`${scope.sql} SELECT COUNT(*) AS count FROM visible_dependencies dep WHERE ${filter}`,
			).get(...scope.args, ...ids)?.count ?? 0;
		result.links = links;
		result.linksOffset = offset;
		result.linksTruncated = offset + links.length < count;
	}
	return { ok: true, ...result };
}
function proposalEvidence(value: unknown): readonly unknown[] {
	if (typeof value !== "string") return [];
	const parsed: unknown = attempt(() => JSON.parse(value));
	return Array.isArray(parsed) ? parsed : [];
}
export function aspectClaimsInDb(
	db: ReadDb,
	input: GraphInput &
		PageInput & { readonly entityId: string; readonly aspectId: string; readonly include?: readonly string[] },
): DreamingGraphOutput {
	const scope = graphScope(input);
	const args = [...scope.args, input.entityId, input.aspectId];
	const items = prepareTypedStatement<Record<string, unknown>>(
		db,
		`${scope.sql}
		SELECT attr.id,attr.aspect_id AS aspectId,attr.agent_id AS agentId,attr.kind,attr.status,attr.content,
		attr.confidence,attr.importance,attr.source_kind AS sourceKind,attr.source_id AS sourceId,attr.proposal_evidence AS proposalEvidence
		FROM visible_attributes attr JOIN visible_aspects asp ON asp.id=attr.aspect_id
		WHERE asp.entity_id=? AND asp.id=? AND attr.kind='attribute'
		ORDER BY attr.importance DESC,attr.created_at DESC,attr.id LIMIT ? OFFSET ?`,
	).all(...args, ...page(input));
	const claims = items.map((item) => ({ ...item, proposalEvidence: proposalEvidence(item.proposalEvidence) }));
	if (!input.include?.includes("contradictions")) return { ok: true, items: claims };
	const contradictions = prepareTypedStatement<Record<string, unknown>>(
		db,
		`${scope.sql}
		SELECT c.id,c.left_attribute_id AS leftAttributeId,c.right_attribute_id AS rightAttributeId,
		c.left_content AS leftContent,c.right_content AS rightContent,c.reason
		FROM visible_contradictions c WHERE c.entity_id=? AND c.aspect_id=? ORDER BY c.updated_at DESC,c.id LIMIT ? OFFSET ?`,
	).all(...args, ...page(input));
	const count =
		prepareTypedStatement<{ count: number }>(
			db,
			`${scope.sql} SELECT COUNT(*) AS count FROM visible_contradictions c WHERE c.entity_id=? AND c.aspect_id=?`,
		).get(...args)?.count ?? 0;
	return { ok: true, items: claims, contradictions: { count, items: contradictions } };
}
export function validateProposalInDb(
	db: ReadDb,
	input: GraphInput & {
		readonly name?: string;
		readonly type?: string;
		readonly entityId?: string;
		readonly aspectId?: string;
		readonly value?: string;
	},
): DreamingGraphOutput {
	const scope = graphScope(input);
	const result: Record<string, unknown> = { ok: true };
	if (input.name !== undefined) {
		result.label = classifyEntityQuality(input.name, input.type);
		result.duplicates = prepareTypedStatement<Record<string, unknown>>(
			db,
			`${scope.sql}
			SELECT e.id,e.name,e.entity_type AS entityType FROM visible_entities e WHERE e.canonical_name=? ORDER BY ${entityOrder} LIMIT 100`,
		).all(...scope.args, input.name.trim().toLowerCase().replace(/\s+/g, " "));
	}
	if (input.entityId !== undefined && input.aspectId !== undefined && input.value !== undefined) {
		const value = input.value;
		const items = prepareTypedStatement<{ attributeId: string; content: string }>(
			db,
			`${scope.sql}
			SELECT attr.id AS attributeId,attr.content FROM visible_attributes attr JOIN visible_aspects asp ON asp.id=attr.aspect_id
			WHERE asp.entity_id=? AND asp.id=? AND attr.kind='attribute' ORDER BY attr.importance DESC,attr.created_at DESC,attr.id LIMIT 200`,
		).all(...scope.args, input.entityId, input.aspectId);
		result.contradiction = items.map((item) => ({
			...item,
			...detectProspectiveContradictionRisk(value, item.content),
		}));
	}
	return { ok: true, ...result };
}
