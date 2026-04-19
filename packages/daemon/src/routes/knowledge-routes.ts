import type { Hono } from "hono";

import { resolveAgentId } from "../agent-id";
import { requirePermission } from "../auth";
import { getDbAccessor } from "../db-accessor";
import { walkImpact } from "../graph-impact";
import {
	getAttributesForAspectFiltered,
	getEntityAspectsWithCounts,
	getEntityDependenciesDetailed,
	getEntityHealth,
	getKnowledgeEntityDetail,
	getKnowledgeGraphForConstellation,
	getKnowledgeStats,
	getPinnedEntities,
	listKnowledgeEntities,
	pinEntity,
	resolveNamedEntity,
	unpinEntity,
} from "../knowledge-graph";
import { type ResolvedMemoryConfig, loadMemoryConfig } from "../memory-config";
import { getTraversalStatus, resolveFocalEntities, traverseKnowledgeGraph } from "../pipeline/graph-traversal";
import { AGENTS_DIR, authConfig } from "./state";
import { resolveScopedAgentId, resolveScopedProject } from "./utils";

export function registerKnowledgeRoutes(app: Hono): void {
	app.get("/api/knowledge/entities", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
		const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
		const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
		const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;

		return c.json({
			items: listKnowledgeEntities(getDbAccessor(), {
				agentId,
				type: c.req.query("type") ?? undefined,
				query: c.req.query("q") ?? undefined,
				limit,
				offset,
			}),
			limit,
			offset,
		});
	});

	app.post("/api/knowledge/entities/:id/pin", async (c) => {
		const denied = await requirePermission("modify", authConfig)(c, () => Promise.resolve());
		if (denied) return denied;

		const agentId = c.req.query("agent_id") ?? "default";
		pinEntity(getDbAccessor(), c.req.param("id"), agentId);
		const entity = getKnowledgeEntityDetail(getDbAccessor(), c.req.param("id"), agentId);
		if (!entity?.entity.pinnedAt) {
			return c.json({ error: "Entity not found" }, 404);
		}
		return c.json({ pinned: true, pinnedAt: entity.entity.pinnedAt });
	});

	app.delete("/api/knowledge/entities/:id/pin", async (c) => {
		const denied = await requirePermission("modify", authConfig)(c, () => Promise.resolve());
		if (denied) return denied;

		const agentId = c.req.query("agent_id") ?? "default";
		unpinEntity(getDbAccessor(), c.req.param("id"), agentId);
		return c.json({ pinned: false });
	});

	app.get("/api/knowledge/entities/pinned", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		return c.json(getPinnedEntities(getDbAccessor(), agentId));
	});

	app.get("/api/knowledge/entities/health", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		const minComparisonsParam = Number.parseInt(c.req.query("min_comparisons") ?? "3", 10);
		return c.json(
			getEntityHealth(
				getDbAccessor(),
				agentId,
				c.req.query("since") ?? undefined,
				Number.isFinite(minComparisonsParam) ? Math.max(minComparisonsParam, 1) : 3,
			),
		);
	});

	app.get("/api/knowledge/entities/:id", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		const entity = getKnowledgeEntityDetail(getDbAccessor(), c.req.param("id"), agentId);
		if (!entity) {
			return c.json({ error: "Entity not found" }, 404);
		}
		return c.json(entity);
	});

	app.get("/api/knowledge/entities/:id/aspects", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		return c.json({
			items: getEntityAspectsWithCounts(getDbAccessor(), c.req.param("id"), agentId),
		});
	});

	app.get("/api/knowledge/entities/:id/aspects/:aspectId/attributes", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
		const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
		const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
		const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;
		const kind = c.req.query("kind");
		const status = c.req.query("status");

		return c.json({
			items: getAttributesForAspectFiltered(getDbAccessor(), {
				entityId: c.req.param("id"),
				aspectId: c.req.param("aspectId"),
				agentId,
				kind: kind === "attribute" || kind === "constraint" ? kind : undefined,
				status: status === "active" || status === "superseded" || status === "deleted" ? status : undefined,
				limit,
				offset,
			}),
			limit,
			offset,
		});
	});

	app.get("/api/knowledge/entities/:id/dependencies", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		const directionQuery = c.req.query("direction");
		const direction =
			directionQuery === "incoming" || directionQuery === "outgoing" || directionQuery === "both"
				? directionQuery
				: "both";
		return c.json({
			items: getEntityDependenciesDetailed(getDbAccessor(), {
				entityId: c.req.param("id"),
				agentId,
				direction,
			}),
		});
	});

	app.get("/api/knowledge/stats", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		return c.json(getKnowledgeStats(getDbAccessor(), agentId));
	});

	app.get("/api/knowledge/communities", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		const rows = getDbAccessor().withReadDb((db) => {
			return db
				.prepare(
					`SELECT id, name, cohesion, member_count, created_at, updated_at
					 FROM entity_communities
					 WHERE agent_id = ?
					 ORDER BY member_count DESC`,
				)
				.all(agentId) as ReadonlyArray<{
				id: string;
				name: string | null;
				cohesion: number;
				member_count: number;
				created_at: string;
				updated_at: string;
			}>;
		});
		return c.json({ items: rows, count: rows.length });
	});

	app.get("/api/knowledge/traversal/status", (c) => {
		return c.json({
			status: getTraversalStatus(),
		});
	});

	app.get("/api/knowledge/constellation", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		return c.json(getKnowledgeGraphForConstellation(getDbAccessor(), agentId));
	});

	app.post("/api/knowledge/expand", async (c) => {
		const denied = await requirePermission("recall", authConfig)(c, () => Promise.resolve());
		if (denied) return denied;

		const scopedAgent = resolveScopedAgentId(c, undefined, "default");
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const body = await c.req.json().catch(() => ({}));
		const entityName = typeof body.entity === "string" ? body.entity.trim() : "";
		const aspectFilter = typeof body.aspect === "string" ? body.aspect.trim() : undefined;
		const maxTokens = typeof body.maxTokens === "number" ? Math.min(body.maxTokens, 10000) : 2000;

		if (!entityName) {
			return c.json({ error: "entity name is required" }, 400);
		}

		const agentId = scopedAgent.agentId;
		const resolved = resolveNamedEntity(getDbAccessor(), {
			agentId,
			name: entityName,
		});
		const focal =
			resolved !== null
				? {
						entityIds: [resolved.id],
					}
				: getDbAccessor().withReadDb((db) =>
						resolveFocalEntities(db, agentId, {
							queryTokens: entityName.split(/\s+/),
						}),
					);

		if (focal.entityIds.length === 0) {
			return c.json(
				{
					error: `Entity "${entityName}" not found`,
					entity: null,
					constraints: [],
					aspects: [],
					dependencies: [],
					memoryCount: 0,
					memories: [],
				},
				404,
			);
		}

		const cfg = loadMemoryConfig(AGENTS_DIR);
		const traversalCfg = cfg.pipelineV2.traversal ?? {
			maxAspectsPerEntity: 10,
			maxAttributesPerAspect: 20,
			maxDependencyHops: 10,
			minDependencyStrength: 0.3,
			maxBranching: 4,
			maxTraversalPaths: 50,
			minConfidence: 0.5,
			timeoutMs: 500,
		};

		const primaryEntityId = focal.entityIds[0];

		return getDbAccessor().withReadDb((db) => {
			const traversal = traverseKnowledgeGraph(focal.entityIds, db, agentId, {
				maxAspectsPerEntity: traversalCfg.maxAspectsPerEntity,
				maxAttributesPerAspect: traversalCfg.maxAttributesPerAspect,
				maxDependencyHops: traversalCfg.maxDependencyHops,
				minDependencyStrength: traversalCfg.minDependencyStrength,
				maxBranching: traversalCfg.maxBranching,
				maxTraversalPaths: traversalCfg.maxTraversalPaths,
				minConfidence: traversalCfg.minConfidence,
				timeoutMs: traversalCfg.timeoutMs,
				aspectFilter: aspectFilter || undefined,
			});

			const entityRow = db
				.prepare(
					`SELECT id, name, entity_type, description
					 FROM entities WHERE id = ?`,
				)
				.get(primaryEntityId) as
				| {
						id: string;
						name: string;
						entity_type: string;
						description: string | null;
				  }
				| undefined;

			const aspectFilterClause = aspectFilter ? "AND ea.canonical_name LIKE ?" : "";
			const aspectArgs = aspectFilter
				? [primaryEntityId, agentId, `%${aspectFilter}%`, traversalCfg.maxAspectsPerEntity]
				: [primaryEntityId, agentId, traversalCfg.maxAspectsPerEntity];

			const aspects = db
				.prepare(
					`SELECT ea.id, ea.canonical_name, ea.weight
					 FROM entity_aspects ea
					 WHERE ea.entity_id = ? AND ea.agent_id = ?
					 ${aspectFilterClause}
					 ORDER BY ea.weight DESC
					 LIMIT ?`,
				)
				.all(...aspectArgs) as Array<{
				id: string;
				canonical_name: string;
				weight: number;
			}>;

			const aspectsWithAttributes = aspects.map((aspect) => {
				const attrs = db
					.prepare(
						`SELECT content, kind, importance, confidence
						 FROM entity_attributes
						 WHERE aspect_id = ? AND agent_id = ?
						   AND status = 'active'
						 ORDER BY importance DESC
						 LIMIT ?`,
					)
					.all(aspect.id, agentId, traversalCfg.maxAttributesPerAspect) as Array<{
					content: string;
					kind: string;
					importance: number;
					confidence: number;
				}>;
				return {
					name: aspect.canonical_name,
					weight: aspect.weight,
					attributes: attrs,
				};
			});

			const deps = db
				.prepare(
					`SELECT e.name as target, ed.dependency_type as type,
					        ed.strength
					 FROM entity_dependencies ed
					 JOIN entities e ON e.id = ed.target_entity_id
					 WHERE ed.source_entity_id = ?
					   AND ed.agent_id = ?
					   AND ed.strength >= ?
					 ORDER BY ed.strength DESC
					 LIMIT ?`,
				)
				.all(primaryEntityId, agentId, traversalCfg.minDependencyStrength, traversalCfg.maxDependencyHops) as Array<{
				target: string;
				type: string;
				strength: number;
			}>;

			let tokenBudget = maxTokens;
			const hydratedMemories: Array<{
				id: string;
				content: string;
			}> = [];
			for (const memId of traversal.memoryIds) {
				if (tokenBudget <= 0) break;
				const mem = db
					.prepare(
						`SELECT id, content FROM memories
						 WHERE id = ? AND is_deleted = 0`,
					)
					.get(memId) as { id: string; content: string } | undefined;
				if (mem) {
					const approxTokens = Math.ceil(mem.content.length / 4);
					if (approxTokens <= tokenBudget) {
						hydratedMemories.push(mem);
						tokenBudget -= approxTokens;
					}
				}
			}

			return c.json({
				entity: entityRow
					? {
							id: entityRow.id,
							name: entityRow.name,
							type: entityRow.entity_type,
							description: entityRow.description,
						}
					: null,
				constraints: traversal.constraints,
				aspects: aspectsWithAttributes,
				dependencies: deps,
				memoryCount: traversal.memoryIds.size,
				memories: hydratedMemories,
			});
		});
	});

	app.post("/api/knowledge/expand/session", async (c) => {
		const denied = await requirePermission("recall", authConfig)(c, () => Promise.resolve());
		if (denied) return denied;

		const body = await c.req.json().catch(() => ({}));
		const entityName = typeof body.entityName === "string" ? body.entityName.trim() : "";
		const scopedAgent = resolveScopedAgentId(
			c,
			resolveAgentId({
				agentId: typeof body.agentId === "string" ? body.agentId : c.req.header("x-signet-agent-id"),
				sessionKey: typeof body.sessionId === "string" ? body.sessionId : c.req.header("x-signet-session-key"),
			}),
		);
		if (scopedAgent.error) {
			return c.json({ error: scopedAgent.error }, 403);
		}
		const scopedProject = resolveScopedProject(c, undefined);
		if (scopedProject.error) {
			return c.json({ error: scopedProject.error }, 403);
		}
		const agentId = scopedAgent.agentId;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : undefined;
		const timeRange = typeof body.timeRange === "string" ? body.timeRange.trim() : undefined;
		const maxResults = typeof body.maxResults === "number" ? Math.max(1, Math.min(body.maxResults, 50)) : 10;

		if (!entityName) {
			return c.json({ error: "entityName is required" }, 400);
		}

		return getDbAccessor().withReadDb((db) => {
			const tbl = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'")
				.get() as { name: string } | undefined;
			if (!tbl) {
				return c.json({ entityName, summaries: [], total: 0 });
			}

			const entity = resolveNamedEntity(getDbAccessor(), {
				agentId,
				name: entityName,
			});

			if (!entity) {
				return c.json({ entityName, summaries: [], total: 0 });
			}

			const conditions = ["ss.agent_id = ?", "ss.kind = 'session'", "COALESCE(ss.source_type, 'summary') = 'summary'"];
			const args: Array<string | number> = [agentId];

			if (scopedProject.project) {
				conditions.push("ss.project = ?");
				args.push(scopedProject.project);
			}

			if (sessionId) {
				conditions.push("ss.session_key = ?");
				args.push(sessionId);
			}

			if (timeRange === "last_week") {
				conditions.push("ss.latest_at >= datetime('now', '-7 days')");
			} else if (timeRange === "last_month") {
				conditions.push("ss.latest_at >= datetime('now', '-30 days')");
			} else if (timeRange && timeRange.length > 0) {
				conditions.push("ss.latest_at >= ?");
				args.push(timeRange);
			}

			const cn = entity.canonicalName.toLowerCase().replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
			const useTextFallback = cn.length >= 4;
			const normalizedContent =
				`LOWER(' ' || REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(` +
				"REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ss.content," +
				`',', ' '), '.', ' '), '!', ' '), '?', ' '), ';', ' '), '"', ' '),` +
				`char(39), ' '), char(40), ' '), char(41), ' '),` +
				`char(10), ' '), char(9), ' '), ':', ' '), '-', ' ') || ' ')`;
			const fallbackClause = useTextFallback ? `OR ${normalizedContent} LIKE ? ESCAPE '\\'` : "";
			const fallbackArgs = useTextFallback ? [`% ${cn} %`] : [];
			const rows = db
				.prepare(
					`SELECT DISTINCT ss.id, ss.content, ss.session_key,
					        ss.harness, ss.earliest_at, ss.latest_at
					 FROM session_summaries ss
					 WHERE ${conditions.join(" AND ")}
					   AND (
							EXISTS (
								SELECT 1
								FROM session_summary_memories ssm
								JOIN memory_entity_mentions mem
								  ON mem.memory_id = ssm.memory_id
								WHERE ssm.summary_id = ss.id
								  AND mem.entity_id = ?
							)
							${fallbackClause}
					   )
					 ORDER BY ss.latest_at DESC
					 LIMIT ?`,
				)
				.all(...args, entity.id, ...fallbackArgs, maxResults) as Array<{
				id: string;
				content: string;
				session_key: string | null;
				harness: string | null;
				earliest_at: string;
				latest_at: string;
			}>;

			return c.json({
				entityName: entity.name,
				summaries: rows.map((row) => ({
					id: row.id,
					sessionKey: row.session_key,
					harness: row.harness,
					earliestAt: row.earliest_at,
					latestAt: row.latest_at,
					content: row.content,
				})),
				total: rows.length,
			});
		});
	});

	app.post("/api/graph/impact", async (c) => {
		const denied = await requirePermission("recall", authConfig)(c, () => Promise.resolve());
		if (denied) return denied;

		const body = await c.req.json().catch(() => ({}));
		const entityId = typeof body.entityId === "string" ? body.entityId.trim() : "";
		const direction = body.direction === "upstream" ? "upstream" : "downstream";
		const maxDepth = typeof body.maxDepth === "number" ? Math.max(1, Math.min(body.maxDepth, 10)) : 3;

		if (!entityId) {
			return c.json({ error: "entityId is required" }, 400);
		}

		const result = getDbAccessor().withReadDb((db) =>
			walkImpact(db, { entityId, direction, maxDepth, timeoutMs: 200 }),
		);
		return c.json(result);
	});
}
