import { registerPublicReadResponse, publicReadValue } from "../public-read-response";
import { reconcileAgentSources } from "../auth/agent-access";
import { resolveRouteReadScope } from "./read-scope";
import { knowledgeReadOwner, getKnowledgeCommunities, expandKnowledgeSessions } from "../knowledge-graph-hygiene";
import type { Hono } from "hono";
import { etag } from "hono/etag";
import { resolveAgentId, resolveDaemonAgentId } from "../agent-id";
import { requirePermission } from "../auth";
import { getDbAccessor, getDbAccessorPath } from "../db-accessor";
import { getDbOwner } from "../db-owner-runtime";
import { walkImpact } from "../graph-impact";
import { expandKnowledgeGraphViaOwner } from "../knowledge-expansion";
import {
	getAttributesForAspectFiltered,
	getEntityAspectsByName,
	getEntityAspectsWithCounts,
	getEntityDependenciesDetailed,
	getEntityHealth,
	getEntityKnowledgeTree,
	getKnowledgeEntityByName,
	getKnowledgeEntityDetail,
	getKnowledgeGraphForConstellation,
	getKnowledgeStats,
	getPinnedEntities,
	listEntityAttributesByPath,
	listEntityClaims,
	listEntityGroups,
	listKnowledgeEntities,
	MAX_CONSTELLATION_ATTRIBUTES,
	resolveNamedEntity,
} from "../knowledge-graph";
import { getKnowledgeHygieneReport } from "../knowledge-graph-hygiene";
import { loadMemoryConfig } from "../memory-config";
import { applyOntologyOperation, OntologyProposalError } from "../ontology-proposals";
import { probeDreamingEpisodicBacklog } from "../pipeline/dreaming";
import {
	getTraversalStatus,
	resolveFocalEntitiesViaOwner,
	traverseKnowledgeGraphViaOwner,
} from "../pipeline/graph-traversal";
import { jsonBody } from "../request-body";
import { AGENTS_DIR, authConfig } from "./state";
import { resolveMutationActor, resolveScopedAgentId, resolveScopedProject } from "./utils";

export function registerKnowledgeRoutes(app: Hono): void {
	registerPublicReadResponse(app, "/api/knowledge/*");
	const parseNavigationLimit = (value: string | undefined, fallback: number, max: number): number => {
		const parsed = Number.parseInt(value ?? String(fallback), 10);
		return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), max) : fallback;
	};

	app.get("/api/knowledge/entities", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
		const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
		const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
		const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;

		return c.json({
			items: await listKnowledgeEntities(
				getDbAccessor(),
				{
					agentId,
					type: c.req.query("type") ?? undefined,
					query: c.req.query("q") ?? undefined,
					limit,
					offset,
				},
				readScope,
			),
			limit,
			offset,
		});
	});

	app.get("/api/knowledge/navigation/entities", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
		const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
		const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
		const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;

		return c.json({
			items: await listKnowledgeEntities(
				getDbAccessor(),
				{
					agentId,
					type: c.req.query("type") ?? undefined,
					query: c.req.query("q") ?? undefined,
					limit,
					offset,
				},
				readScope,
			),
			limit,
			offset,
		});
	});

	app.get("/api/knowledge/navigation/entity", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const name = c.req.query("name")?.trim();
		if (!name) return c.json({ error: "name is required" }, 400);
		const entity = await getKnowledgeEntityByName(getDbAccessor(), { agentId, name }, readScope);
		if (!entity) return c.json({ error: "Entity not found" }, 404);
		return c.json(entity);
	});

	app.get("/api/knowledge/navigation/tree", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const entity = c.req.query("entity")?.trim();
		if (!entity) return c.json({ error: "entity is required" }, 400);
		const result = await getEntityKnowledgeTree(
			getDbAccessor(),
			{
				agentId,
				entity,
				maxAspects: parseNavigationLimit(c.req.query("max_aspects"), 20, 100),
				maxGroups: parseNavigationLimit(c.req.query("max_groups"), 20, 100),
				maxClaims: parseNavigationLimit(c.req.query("max_claims"), 50, 200),
				maxTotalClaims: parseNavigationLimit(c.req.query("max_total_claims"), 1_000, 10_000),
				depth: parseNavigationLimit(c.req.query("depth"), 3, 3),
			},
			readScope,
		);
		if (!result) return c.json({ error: "Entity not found" }, 404);
		return c.json(result);
	});

	app.get("/api/knowledge/navigation/aspects", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const entity = c.req.query("entity")?.trim();
		if (!entity) return c.json({ error: "entity is required" }, 400);
		const result = await getEntityAspectsByName(getDbAccessor(), { agentId, entity }, readScope);
		if (!result) return c.json({ error: "Entity not found" }, 404);
		return c.json(result);
	});

	app.get("/api/knowledge/navigation/groups", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const entity = c.req.query("entity")?.trim();
		const aspect = c.req.query("aspect")?.trim();
		if (!entity) return c.json({ error: "entity is required" }, 400);
		if (!aspect) return c.json({ error: "aspect is required" }, 400);
		const result = await listEntityGroups(getDbAccessor(), { agentId, entity, aspect }, readScope);
		if (!result) return c.json({ error: "Entity or aspect not found" }, 404);
		return c.json(result);
	});

	app.get("/api/knowledge/navigation/claims", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const entity = c.req.query("entity")?.trim();
		const aspect = c.req.query("aspect")?.trim();
		const group = c.req.query("group")?.trim();
		if (!entity) return c.json({ error: "entity is required" }, 400);
		if (!aspect) return c.json({ error: "aspect is required" }, 400);
		if (!group) return c.json({ error: "group is required" }, 400);
		const limit = parseNavigationLimit(c.req.query("limit"), 50, 200);
		const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
		const offset = Number.isFinite(offsetParam) ? Math.min(Math.max(offsetParam, 0), Number.MAX_SAFE_INTEGER) : 0;
		const result = await listEntityClaims(
			getDbAccessor(),
			{ agentId, entity, aspect, group, limit, offset },
			readScope,
		);
		if (!result) return c.json({ error: "Entity or aspect not found" }, 404);
		return c.json(result);
	});

	app.get("/api/knowledge/navigation/attributes", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const entity = c.req.query("entity")?.trim();
		const aspect = c.req.query("aspect")?.trim();
		const group = c.req.query("group")?.trim();
		const claim = c.req.query("claim")?.trim();
		if (!entity) return c.json({ error: "entity is required" }, 400);
		if (!aspect) return c.json({ error: "aspect is required" }, 400);
		if (!group) return c.json({ error: "group is required" }, 400);
		if (!claim) return c.json({ error: "claim is required" }, 400);
		const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
		const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
		const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
		const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;
		const kindQuery = c.req.query("kind");
		const statusQuery = c.req.query("status");
		const kind = kindQuery === "attribute" || kindQuery === "constraint" ? kindQuery : undefined;
		const status =
			statusQuery === "active" || statusQuery === "superseded" || statusQuery === "deleted" || statusQuery === "all"
				? statusQuery
				: undefined;
		const result = await listEntityAttributesByPath(
			getDbAccessor(),
			{
				agentId,
				entity,
				aspect,
				group,
				claim,
				kind,
				status,
				limit,
				offset,
			},
			readScope,
		);
		if (!result) return c.json({ error: "Entity or aspect not found" }, 404);
		return c.json({ ...result, limit, offset });
	});

	app.post("/api/knowledge/entities/:id/pin", async (c) => {
		const denied = await requirePermission("modify", authConfig)(c, () => Promise.resolve());
		if (denied) return denied;

		const scopedAgent = resolveScopedAgentId(c, c.req.query("agent_id"), "default");
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const agentId = scopedAgent.agentId;
		try {
			const { result } = await applyOntologyOperation(getDbAccessor(), {
				agentId,
				author: c.get("author"),
				actor: resolveMutationActor(c, "operator").changedBy,
				operation: "pin_entity",
				payload: { id: c.req.param("id") },
			});
			return c.json({ pinned: true, pinnedAt: result?.pinnedAt });
		} catch (err) {
			if (err instanceof OntologyProposalError && err.status === 404) return c.json({ error: "Entity not found" }, 404);
			throw err;
		}
	});

	app.delete("/api/knowledge/entities/:id/pin", async (c) => {
		const denied = await requirePermission("modify", authConfig)(c, () => Promise.resolve());
		if (denied) return denied;

		const scopedAgent = resolveScopedAgentId(c, c.req.query("agent_id"), "default");
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const agentId = scopedAgent.agentId;
		try {
			await applyOntologyOperation(getDbAccessor(), {
				agentId,
				author: c.get("author"),
				actor: resolveMutationActor(c, "operator").changedBy,
				operation: "unpin_entity",
				payload: { id: c.req.param("id") },
			});
		} catch (err) {
			if (err instanceof OntologyProposalError && err.status === 404) return c.json({ pinned: false });
			throw err;
		}
		return c.json({ pinned: false });
	});

	app.get("/api/knowledge/entities/pinned", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		return c.json(await getPinnedEntities(getDbAccessor(), agentId, readScope));
	});

	app.get("/api/knowledge/entities/health", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const minComparisonsParam = Number.parseInt(c.req.query("min_comparisons") ?? "3", 10);
		return c.json(
			await getEntityHealth(
				getDbAccessor(),
				agentId,
				c.req.query("since") ?? undefined,
				Number.isFinite(minComparisonsParam) ? Math.max(minComparisonsParam, 1) : 3,
				readScope,
			),
		);
	});

	app.get("/api/knowledge/hygiene", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		return c.json(
			await getKnowledgeHygieneReport(
				getDbAccessor(),
				{
					agentId,
					limit: parseNavigationLimit(c.req.query("limit"), 50, 500),
					memoryLimit: parseNavigationLimit(c.req.query("memory_limit"), 200, 1000),
				},
				readScope,
			),
		);
	});

	app.get("/api/knowledge/entities/:id", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const entity = await getKnowledgeEntityDetail(getDbAccessor(), c.req.param("id"), agentId, readScope);
		if (!entity) {
			return c.json({ error: "Entity not found" }, 404);
		}
		return c.json(entity);
	});

	app.get("/api/knowledge/entities/:id/aspects", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		return c.json({
			items: await getEntityAspectsWithCounts(getDbAccessor(), c.req.param("id"), agentId, readScope),
		});
	});

	app.get("/api/knowledge/entities/:id/aspects/:aspectId/attributes", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
		const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
		const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
		const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;
		const kind = c.req.query("kind");
		const status = c.req.query("status");

		return c.json({
			items: await getAttributesForAspectFiltered(
				getDbAccessor(),
				{
					entityId: c.req.param("id"),
					aspectId: c.req.param("aspectId"),
					agentId,
					kind: kind === "attribute" || kind === "constraint" || kind === "claim" ? kind : undefined,
					status: status === "active" || status === "superseded" || status === "deleted" ? status : undefined,
					limit,
					offset,
				},
				readScope,
			),
			limit,
			offset,
		});
	});

	app.get("/api/knowledge/entities/:id/dependencies", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const directionQuery = c.req.query("direction");
		const direction =
			directionQuery === "incoming" || directionQuery === "outgoing" || directionQuery === "both"
				? directionQuery
				: "both";
		return c.json({
			items: await getEntityDependenciesDetailed(
				getDbAccessor(),
				{
					entityId: c.req.param("id"),
					agentId,
					direction,
				},
				readScope,
			),
		});
	});

	app.get("/api/knowledge/stats", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		return c.json(await getKnowledgeStats(getDbAccessor(), agentId, readScope));
	});

	app.get("/api/knowledge/communities", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		const agentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const rows = await getKnowledgeCommunities(agentId, readScope);
		return c.json({ items: rows, count: rows.length });
	});

	app.get("/api/knowledge/traversal/status", async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		const readScope = await resolveRouteReadScope(c, requestedReadAgent);

		return c.json({
			status: readScope.reach.kind === "all" && readScope.compartments === "all" ? getTraversalStatus() : null,
		});
	});
	app.get("/api/knowledge/constellation", etag(), async (c) => {
		const requestedReadAgent = c.req.query("agent_id") ?? c.req.query("agentId");
		let readScope = await resolveRouteReadScope(c, requestedReadAgent === "all" ? undefined : requestedReadAgent);

		const requested = c.req.query("agent_id") ?? c.req.query("agentId");
		const allAgents = requested === "all";
		if (allAgents && !c.get("organization")) readScope = { ...readScope, reach: { kind: "all" } };
		if (allAgents) {
			const denied = await requirePermission("admin", authConfig)(c, () => Promise.resolve());
			if (denied) return denied;
		}
		const scopedAgent = allAgents
			? undefined
			: {
					agentId: readScope.reach.kind === "all" ? "default" : readScope.reach.agentId,
					error: undefined,
					response: undefined,
				};
		if (scopedAgent?.error) return c.json({ error: scopedAgent.error }, 403);
		const agentId = scopedAgent?.agentId ?? resolveDaemonAgentId();
		const accessor = getDbAccessor();
		const backlogProbe =
			!c.get("organization") || (readScope.reach.kind === "all" && readScope.compartments === "all")
				? await probeDreamingEpisodicBacklog(accessor, agentId, loadMemoryConfig(AGENTS_DIR).dreaming.tokenThreshold)
				: undefined;
		return c.body(
			JSON.stringify(
				publicReadValue(
					await getKnowledgeGraphForConstellation(
						accessor,
						agentId,
						{
							limit: parseNavigationLimit(c.req.query("limit"), 150, 1000),
							maxAspectsPerEntity: parseNavigationLimit(c.req.query("max_aspects_per_entity"), 6, 25),
							maxAttributesPerAspect: parseNavigationLimit(c.req.query("max_attributes_per_aspect"), 4, 250),
							maxAttributes: parseNavigationLimit(
								c.req.query("max_attributes"),
								MAX_CONSTELLATION_ATTRIBUTES,
								MAX_CONSTELLATION_ATTRIBUTES,
							),
							dependencyLimit: parseNavigationLimit(c.req.query("dependency_limit"), 500, 2000),
							assertionLimit: parseNavigationLimit(c.req.query("assertion_limit"), 250, 1000),
							backlogProbe,
							allAgents,
						},
						readScope,
					),
					Boolean(c.get("organization")),
				),
			),
			200,
			{ "Content-Type": "application/json; charset=UTF-8" },
		);
	});

	app.post("/api/knowledge/expand", async (c) => {
		const denied = await requirePermission("recall", authConfig)(c, () => Promise.resolve());
		if (denied) return denied;
		const readScope = await resolveRouteReadScope(c);

		const resolvedReadAgentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const body = await jsonBody(c)().catch((): Record<string, unknown> => ({}));
		const entityName = typeof body.entity === "string" ? body.entity.trim() : "";
		const aspectFilter = typeof body.aspect === "string" ? body.aspect.trim() : undefined;
		const maxTokens = typeof body.maxTokens === "number" ? Math.min(body.maxTokens, 10000) : 2000;

		if (!entityName) {
			return c.json({ error: "entity name is required" }, 400);
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
		const traversalDeadlineAt = Date.now() + traversalCfg.timeoutMs;
		const agentId = resolvedReadAgentId;

		try {
			const baseOwner = await getDbOwner(getDbAccessorPath());
			const owner = await knowledgeReadOwner(baseOwner, readScope);
			const resolved = await resolveNamedEntity(
				getDbAccessor(),
				{
					agentId,
					name: entityName,
					deadlineAt: traversalDeadlineAt,
				},
				readScope,
			);
			const focal: Awaited<ReturnType<typeof resolveFocalEntitiesViaOwner>> =
				resolved !== null
					? {
							entityIds: [resolved.id],
							entityNames: [resolved.name],
							pinnedEntityIds: [],
							source: "query",
						}
					: await resolveFocalEntitiesViaOwner(owner, agentId, {
							queryTokens: entityName.split(/\s+/),
							deadlineAt: traversalDeadlineAt,
						});

			if (focal.error) {
				return c.json({ error: "Knowledge graph expansion unavailable.", code: "knowledge_graph_unavailable" }, 503);
			}
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

			const traversal = await traverseKnowledgeGraphViaOwner(focal.entityIds, owner, agentId, {
				maxAspectsPerEntity: traversalCfg.maxAspectsPerEntity,
				maxAttributesPerAspect: traversalCfg.maxAttributesPerAspect,
				maxDependencyHops: traversalCfg.maxDependencyHops,
				minDependencyStrength: traversalCfg.minDependencyStrength,
				maxBranching: traversalCfg.maxBranching,
				maxTraversalPaths: traversalCfg.maxTraversalPaths,
				minConfidence: traversalCfg.minConfidence,
				timeoutMs: traversalCfg.timeoutMs,
				deadlineAt: traversalDeadlineAt,
				aspectFilter: aspectFilter || undefined,
			});

			return c.json(
				await expandKnowledgeGraphViaOwner(
					baseOwner,
					{
						primaryEntityId: focal.entityIds[0],
						agentId,
						maxTokens,
						aspectFilter,
						traversalConfig: traversalCfg,
						traversal,
					},
					readScope,
				),
			);
		} catch {
			return c.json({ error: "Knowledge graph expansion unavailable.", code: "knowledge_graph_unavailable" }, 503);
		}
	});

	app.post("/api/knowledge/expand/session", async (c) => {
		const denied = await requirePermission("recall", authConfig)(c, () => Promise.resolve());
		if (denied) return denied;

		const body = await jsonBody(c)().catch((): Record<string, unknown> => ({}));
		const requestedAgent = typeof body.agentId === "string" ? body.agentId : c.req.header("x-signet-agent-id");
		const requestedSession = typeof body.sessionId === "string" ? body.sessionId : c.req.header("x-signet-session-key");
		const sessionAgent = requestedSession?.startsWith("agent:") ? requestedSession.split(":")[1] : undefined;
		const reconciled = reconcileAgentSources([requestedAgent, c.req.query("agent_id"), sessionAgent]);
		if (!reconciled.ok)
			return c.json({ error: reconciled.error.error, reason: reconciled.error.reason }, reconciled.error.status);
		const readScope = await resolveRouteReadScope(
			c,
			c.get("organization")
				? reconciled.value
				: resolveAgentId({ agentId: reconciled.value, sessionKey: requestedSession }),
		);

		const entityName = typeof body.entityName === "string" ? body.entityName.trim() : "";
		const resolvedReadAgentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const scopedProject = resolveScopedProject(c, undefined);
		if (scopedProject.error) {
			return c.json({ error: scopedProject.error }, 403);
		}
		const agentId = resolvedReadAgentId;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : undefined;
		const timeRange = typeof body.timeRange === "string" ? body.timeRange.trim() : undefined;
		const maxResults = typeof body.maxResults === "number" ? Math.max(1, Math.min(body.maxResults, 50)) : 10;

		if (!entityName) {
			return c.json({ error: "entityName is required" }, 400);
		}

		const entity = await resolveNamedEntity(
			getDbAccessor(),
			{
				agentId,
				name: entityName,
			},
			readScope,
		);
		if (!entity) return c.json({ entityName, summaries: [], total: 0 });

		return c.json(
			await expandKnowledgeSessions(
				{ agentId, entity, project: scopedProject.project, sessionId, timeRange, maxResults },
				readScope,
			),
		);
	});

	app.post("/api/graph/impact", async (c) => {
		const denied = await requirePermission("recall", authConfig)(c, () => Promise.resolve());
		if (denied) return denied;

		const body = await jsonBody(c)().catch((): Record<string, unknown> => ({}));
		const readScope = await resolveRouteReadScope(
			c,
			typeof body.agentId === "string" ? body.agentId : (c.req.query("agent_id") ?? c.req.header("x-signet-agent-id")),
		);

		const resolvedReadAgentId = readScope.reach.kind === "all" ? "default" : readScope.reach.agentId;
		const entityId = typeof body.entityId === "string" ? body.entityId.trim() : "";
		const direction = body.direction === "upstream" ? "upstream" : "downstream";
		const maxDepth = typeof body.maxDepth === "number" ? Math.max(1, Math.min(body.maxDepth, 10)) : 3;

		if (!entityId) {
			return c.json({ error: "entityId is required" }, 400);
		}

		const result = await walkImpact(
			getDbAccessor(),
			{ entityId, agentId: resolvedReadAgentId, direction, maxDepth, timeoutMs: 200 },
			readScope,
		);
		return c.json(result);
	});
}
