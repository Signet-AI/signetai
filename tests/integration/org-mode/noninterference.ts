import { Database } from "bun:sqlite";
import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { findSqliteVecExtension } from "../../../platform/core/dist/index";
import { OrgDaemon } from "./daemon";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { type Fixture, hrMarker, rankingQuery } from "./fixture";
import { record, request, type Credential } from "./http";

const probeVolatile = new Set([
	"requestId",
	"request_id",
	"durationMs",
	"duration_ms",
	"elapsedMs",
	"latencyMs",
	"generatedAt",
	"serverTime",
	"at",
	"timings",
]);
export function normalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalize);
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value);
		const probe = entries.some(
			([key, item]) =>
				["key", "sessionKey", "session_key"].includes(key) &&
				typeof item === "string" &&
				item.startsWith("org-read-probe-"),
		);
		return Object.fromEntries(
			entries
				.filter(([key]) => !probeVolatile.has(key))
				.map(([key, item]) => [key, probe && /(?:At|_at)$/.test(key) ? "<probe-time>" : normalize(item)]),
		);
	}
	return value;
}
export function normalizeMcp(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeMcp);
	if (value !== null && typeof value === "object") {
		const row = Object.fromEntries(Object.entries(value));
		if (row.type === "text" && typeof row.text === "string" && /^[\s]*[[{]/.test(row.text)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.text);
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error;
				return normalize(row);
			}
			return normalize({ ...row, text: parsed });
		}
		return normalize(Object.fromEntries(Object.entries(row).map(([key, item]) => [key, normalizeMcp(item)])));
	}
	return value;
}
export function assertUnchanged(before: unknown, after: unknown, surface: string): void {
	assert.deepStrictEqual(after, before, `Hidden-material non-interference violated: ${surface}`);
}
export interface Surface {
	name: string;
	path: string;
	method?: "GET" | "POST";
	body?: object;
	positive: "content" | "change" | "unavailable";
	needles?: string[];
	adminOnly?: boolean;
	audienceBody?: object;
	audiencePath?: string;
	minimumVisible?: number;
}
function rankingControls(surface: Surface): Partial<Surface> {
	if (surface.name === "recall")
		return { minimumVisible: 3, audienceBody: { ...surface.body, query: hrMarker, limit: 50 } };
	if (surface.name === "search" || surface.name === "search legacy")
		return {
			minimumVisible: 3,
			audiencePath: surface.path
				.replace(encodeURIComponent(rankingQuery), encodeURIComponent(hrMarker))
				.replace("limit=3", "limit=50"),
		};
	if (surface.name === "similar") return { minimumVisible: 2 };
	if (surface.name === "prompt-submit injection") return { audienceBody: { ...surface.body, userMessage: hrMarker } };
	if (surface.name === "MCP memory_search")
		return {
			audienceBody: {
				...surface.body,
				params: {
					name: "memory_search",
					arguments: { query: hrMarker, agent_id: "default", project: "atlas", save_aggregate: false, limit: 50 },
				},
			},
		};
	return {};
}
export function catalogue(fixture: Fixture): Surface[] {
	const session = encodeURIComponent(fixture.hrSession);
	const query = encodeURIComponent(hrMarker);
	const sharedQuery = encodeURIComponent(rankingQuery);
	const claim = `entity=${query}&aspect=HR&group=general&claim=award`;
	const get = (name: string, path: string, positive: "content" | "change" = "content"): Surface => ({
		name,
		path: `${path}${path.includes("?") ? "&" : "?"}agent_id=default`,
		positive,
	});
	const post = (name: string, path: string, body: object, positive: "content" | "change" = "content"): Surface => ({
		name,
		path,
		method: "POST",
		body,
		positive,
	});
	const surfaces: Surface[] = [
		post("recall", "/api/memory/recall", {
			query: rankingQuery,
			agentId: "default",
			project: "atlas",
			limit: 3,
			saveAggregate: false,
		}),
		get("get-by-id", `/api/memory/${fixture.hrMemory}`),
		get("lists", "/api/memories?limit=100"),
		get("search legacy", `/memory/search?q=${sharedQuery}&limit=3`),
		get("search", `/api/memory/search?q=${sharedQuery}&limit=3`),
		get("similar", `/memory/similar?id=${fixture.publicMemory}&k=2`),
		get("embedding hits", "/api/embeddings?limit=100&vectors=true", "change"),
		get("embedding projection", "/api/embeddings/projection", "change"),
		get("constellation", "/api/knowledge/constellation"),
		get("knowledge entities", "/api/knowledge/entities"),
		get("knowledge entity detail", `/api/knowledge/entities/${fixture.hrEntity}`),
		get("knowledge entity aspects", `/api/knowledge/entities/${fixture.hrEntity}/aspects`),
		get("knowledge attributes", `/api/knowledge/entities/${fixture.hrEntity}/aspects/${fixture.hrAspect}/attributes`),
		get("knowledge dependencies", `/api/knowledge/entities/${fixture.hrEntity}/dependencies`),
		post("knowledge expand", "/api/knowledge/expand", { entity: hrMarker, agentId: "default", maxTokens: 2000 }),
		post("graph impact", "/api/graph/impact", { entityId: fixture.hrEntity, agentId: "default" }),
		get("knowledge stats", "/api/knowledge/stats", "change"),
		get("knowledge communities", "/api/knowledge/communities", "change"),
		get("navigation entities", "/api/knowledge/navigation/entities"),
		get("navigation entity", `/api/knowledge/navigation/entity?name=${query}`),
		get("navigation tree", `/api/knowledge/navigation/tree?entity=${query}`),
		get("navigation aspects", `/api/knowledge/navigation/aspects?entity=${query}`),
		get("navigation groups", `/api/knowledge/navigation/groups?entity=${query}&aspect=HR`),
		get("navigation claims", `/api/knowledge/navigation/claims?entity=${query}&aspect=HR&group=compensation`),
		get("navigation attributes", `/api/knowledge/navigation/attributes?${claim}`),
		get("ontology proposals", "/api/ontology/proposals"),
		get("ontology evidence", `/api/ontology/claims/evidence?${claim}`),
		get("ontology explain", `/api/ontology/claims/explain?${claim}`),
		get("ontology versions", `/api/ontology/claims/versions?${claim}`),
		get("ontology version", `/api/ontology/claims/version?${claim}&version=1`),
		get("ontology assertions", "/api/ontology/assertions"),
		get("sessions", "/api/sessions"),
		get("session detail", `/api/sessions/${session}`),
		get("session transcript", `/api/sessions/${session}/transcript`),
		get("session blackbox", `/api/sessions/${session}/blackbox`),
		get("sessions blackbox", "/api/sessions/blackbox"),
		get("session summaries", "/api/sessions/summaries"),
		post("session search", "/api/sessions/search", { query: hrMarker, agentId: "default", limit: 20 }),
		get("sources", "/api/sources"),
		get("source health", `/api/sources/${fixture.hrSource}/health`),
		get("documents", "/api/documents"),
		get("document detail", `/api/documents/${fixture.hrDocument}`),
		get("document chunks", `/api/documents/${fixture.hrDocument}/chunks`),
		get("dream status", "/api/dream/status", "change"),
		get("dream passes", "/api/dream/passes/active"),
		get("dream pass events", "/api/dream/passes/org-hr-completed-pass/events"),
		get("dream pass tools", `/api/dream/passes/${fixture.hrPass}/tools`),
		get("dream pass policy", `/api/dream/passes/${fixture.hrPass}/policy`),
		{ ...get("dream quality", "/api/dream/quality", "change"), positive: "unavailable" },
		{ ...get("dream evidence coverage", "/api/dream/evidence/coverage", "change"), positive: "unavailable" },
		post("dream history", "/api/dream/tools/zoom_history", {
			agentId: fixture.user("carol").agentId,
			input: { agentId: fixture.user("carol").agentId, id: 0, n: 1 },
		}),
		get("reflections", "/api/reflections"),
		get("reflection today", "/api/reflections/today"),
		get("transcript export", "/api/sources/imports/export/transcripts"),
		{ name: "per-user export", path: "/api/org/export?author=__SELF__", positive: "content" },
		post("MCP memory_search", "/mcp?agentId=default", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "memory_search",
				arguments: { query: rankingQuery, agent_id: "default", project: "atlas", save_aggregate: false, limit: 3 },
			},
		}),
		post("session-start injection", "/api/hooks/session-start", {
			harness: "codex",
			sessionKey: "__PROBE__",
			agentId: "default",
			project: "atlas",
		}),
		post("prompt-submit injection", "/api/hooks/user-prompt-submit", {
			harness: "codex",
			sessionKey: "__PROBE__",
			agentId: "default",
			project: "atlas",
			userMessage: rankingQuery,
		}),
	];
	return surfaces.map((surface) => ({
		...surface,
		adminOnly: surface.name.startsWith("dream") || surface.name === "embedding projection",
		...rankingControls(surface),
		needles:
			surface.name.startsWith("dream") || surface.name.startsWith("reflection")
				? [hrMarker]
				: surface.name === "session summaries"
					? ["org-hr-summary"]
					: surface.name === "documents" || surface.name === "document detail"
						? [fixture.hrDocument]
						: surface.name.startsWith("source")
							? [fixture.hrSource]
							: surface.name.startsWith("session")
								? [fixture.hrSession, "73000", "74000"]
								: surface.name.includes("aspects")
									? [fixture.hrAspect, "HR"]
									: surface.name === "navigation groups"
										? ["general"]
										: surface.name === "document chunks"
											? [fixture.hrMemory]
											: [
													fixture.hrMemory,
													fixture.hrEntity,
													fixture.hrRelatedEntity,
													fixture.hrAttribute,
													"73000",
													"74000",
												],
	}));
}
export interface Observation {
	status: number;
	body: unknown;
	etag: string | null;
}
export type Snapshot = Record<string, Observation>;
async function isolatedPrompt(workspace: string, path: string, credential: Credential, body: object) {
	const clone = await OrgDaemon.create();
	try {
		await clone.stop();
		const target = join(clone.workspace, "data/signet.db");
		await rm(target);
		const db = new Database(join(workspace, "data/signet.db"), { readonly: true });
		try {
			const extension = findSqliteVecExtension();
			assert(extension);
			db.loadExtension(extension);
			db.prepare("VACUUM INTO ?").run(target);
		} finally {
			db.close();
		}
		for (const name of ["agent.yaml", "runtime/auth-secret"])
			await copyFile(join(workspace, name), join(clone.workspace, name));
		await clone.start();
		return await request(clone.origin, path, credential, "POST", { ...body, sessionKey: "org-read-probe-prompt" });
	} finally {
		await clone.dispose();
	}
}

export async function snapshot(
	origin: string,
	surfaces: Surface[],
	credential: Credential,
	userId = "baseline",
	audience = false,
	workspace?: string,
): Promise<Snapshot> {
	const result: Snapshot = {};
	for (const surface of surfaces) {
		const path = (audience ? (surface.audiencePath ?? surface.path) : surface.path).replace(
			"__SELF__",
			encodeURIComponent(userId),
		);
		const input = audience ? (surface.audienceBody ?? surface.body) : surface.body;
		const body = input ? { ...input } : undefined;
		if (body && "sessionKey" in body && body.sessionKey === "__PROBE__") delete body.sessionKey;
		const reply =
			workspace && surface.name === "prompt-submit injection" && body
				? await isolatedPrompt(workspace, path, credential, body)
				: await request(origin, path, credential, surface.method, body);
		assert(reply.status < 500, `${surface.name}: ${surface.path} returned HTTP ${reply.status}`);
		let payload = surface.name === "MCP memory_search" ? normalizeMcp(reply.body) : normalize(reply.body);
		if (surface.name === "prompt-submit injection") {
			const fields = record(payload);
			delete fields.clockContext;
			payload = fields;
		}
		result[surface.name] = {
			status: reply.status,
			body: payload,
			etag: reply.headers.get("etag"),
		};
	}
	return result;
}
function privateTokens(fixture: Fixture): string[] {
	return [
		hrMarker,
		"73000",
		"74000",
		fixture.hrEntity,
		fixture.hrRelatedEntity,
		fixture.hrAspect,
		fixture.hrAttribute,
		fixture.hrSource,
		fixture.hrDocument,
		fixture.hrPass,
		fixture.hrSession,
		fixture.extraSession,
		fixture.hrId,
		...fixture.hiddenMemoryIds,
		"org-hr-",
		"org-read-vector-hidden-",
	];
}
function replaceTokens(value: string, tokens: string[], absent: boolean): string {
	let result = value;
	for (const [index, token] of tokens.entries()) {
		const replacement = `<input-${index}>`;
		if (absent) result = result.replaceAll(`org-absent-control-${index}`, replacement);
		else result = result.replaceAll(encodeURIComponent(token), replacement).replaceAll(token, replacement);
	}
	return result;
}
function absentSurface(surface: Surface, tokens: string[]): Surface | undefined {
	const encoded = JSON.stringify({ path: surface.path, body: surface.body });
	let changed = encoded;
	for (const [index, token] of tokens.entries())
		changed = changed
			.replaceAll(encodeURIComponent(token), `org-absent-control-${index}`)
			.replaceAll(token, `org-absent-control-${index}`);
	if (changed === encoded) return undefined;
	const input = record(JSON.parse(changed));
	return { ...surface, path: String(input.path), body: input.body === undefined ? undefined : record(input.body) };
}
function visibleResults(value: unknown): number {
	if (value === null || typeof value !== "object") return 0;
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + visibleResults(item), 0);
	return Object.entries(value).reduce(
		(sum, [key, item]) => sum + (key === "results" && Array.isArray(item) ? item.length : visibleResults(item)),
		0,
	);
}
export async function checkNoninterference(fixture: Fixture): Promise<void> {
	const all = catalogue(fixture);
	const cohorts = [
		{
			name: "member",
			outside: fixture.user("alice").session,
			outsideId: fixture.user("alice").id,
			inside: fixture.user("carol").session,
			insideId: fixture.user("carol").id,
			surfaces: all.filter((surface) => !surface.adminOnly),
		},
		{
			name: "admin",
			outside: fixture.admin,
			outsideId: "admin",
			inside: fixture.user("audra").session,
			insideId: fixture.user("audra").id,
			surfaces: all.filter((surface) => surface.adminOnly),
		},
	];
	for (const credential of [fixture.admin, fixture.user("cora").session]) {
		const hidden = await request(fixture.daemon.origin, `/api/memory/${fixture.hrMemory}?agent_id=default`, credential);
		const absent = await request(
			fixture.daemon.origin,
			"/api/memory/nonexistent-hr-control?agent_id=default",
			credential,
		);
		assert.equal(hidden.status, 404, "Admin/compliance outside the HR audience must not bypass classification");
		assertUnchanged(absent.body, hidden.body, "non-audience privileged read equals absent");
	}
	const baselines: { before: Snapshot; audienceBefore: Snapshot }[] = [];
	for (const cohort of cohorts) {
		const before = await snapshot(
			fixture.daemon.origin,
			cohort.surfaces,
			cohort.outside,
			cohort.outsideId,
			false,
			fixture.daemon.workspace,
		);
		const audienceBefore = await snapshot(
			fixture.daemon.origin,
			cohort.surfaces,
			cohort.inside,
			cohort.insideId,
			true,
			fixture.daemon.workspace,
		);
		assertUnchanged(
			before,
			await snapshot(
				fixture.daemon.origin,
				cohort.surfaces,
				cohort.outside,
				cohort.outsideId,
				false,
				fixture.daemon.workspace,
			),
			`${cohort.name} baseline stability without hidden perturbation`,
		);
		baselines.push({ before, audienceBefore });
	}
	await fixture.perturbHidden();
	const tokens = privateTokens(fixture);
	const failures: string[] = [];
	for (const [index, cohort] of cohorts.entries()) {
		const baseline = baselines[index];
		assert(baseline);
		const after = await snapshot(
			fixture.daemon.origin,
			cohort.surfaces,
			cohort.outside,
			cohort.outsideId,
			false,
			fixture.daemon.workspace,
		);
		const audienceAfter = await snapshot(
			fixture.daemon.origin,
			cohort.surfaces,
			cohort.inside,
			cohort.insideId,
			true,
			fixture.daemon.workspace,
		);
		for (const surface of cohort.surfaces) {
			try {
				const before = baseline.before[surface.name];
				const outside = after[surface.name];
				assert(before && outside);
				assertUnchanged(before, outside, `${cohort.name} ${surface.name} ${surface.path}`);
				if (surface.minimumVisible !== undefined) {
					assert.equal(outside.status, 200, `${surface.name}: visible ranking control must succeed`);
					assert(
						visibleResults(outside.body) >= surface.minimumVisible,
						`${surface.name}: visible top-k was starved by hidden competitors`,
					);
				}
				if (["MCP memory_search", "session-start injection", "prompt-submit injection"].includes(surface.name))
					assert(
						JSON.stringify(outside.body).includes("atlasrankpublic"),
						`${surface.name}: public ranking control is empty`,
					);
				const missing = absentSurface(surface, tokens);
				if (missing) {
					const control = await snapshot(
						fixture.daemon.origin,
						[missing],
						cohort.outside,
						cohort.outsideId,
						false,
						fixture.daemon.workspace,
					);
					assertUnchanged(
						replaceTokens(JSON.stringify(control[surface.name]), tokens, true),
						replaceTokens(JSON.stringify(outside), tokens, false),
						`${surface.name}: hidden detail must equal absent`,
					);
				} else {
					assert(
						!tokens.some((token) => JSON.stringify(outside).includes(token)),
						`${surface.name}: private HR identifier or content leaked`,
					);
				}
				const positive = audienceAfter[surface.name];
				assert(
					positive && positive.status >= 200 && positive.status < 300,
					`${surface.name}: HR audience positive control failed at ${surface.path} (HTTP ${positive?.status})`,
				);
				if (surface.positive === "unavailable") {
					assert.equal(positive.status, 200);
					const diagnostic = record(positive.body);
					assert(
						diagnostic.unavailable === true ||
							(diagnostic.status === "unavailable" && diagnostic.reason === "scoped_totals_omitted"),
					);
					assertUnchanged(
						baseline.audienceBefore[surface.name],
						positive,
						`${surface.name}: unavailable diagnostics must be invariant for the audience too`,
					);
				} else if (surface.positive === "content")
					assert(
						(surface.needles ?? [hrMarker]).some((needle) => JSON.stringify(positive.body).includes(needle)),
						`${surface.name}: positive control lacks HR fixture content at ${surface.path}`,
					);
				else
					assert(
						!isDeepStrictEqual(baseline.audienceBefore[surface.name], positive),
						`${surface.name}: hidden perturbation did not reach the HR audience at ${surface.path}`,
					);
			} catch (error) {
				failures.push(error instanceof Error ? error.message : String(error));
			}
		}
	}
	assert.equal(failures.length, 0, failures.join("\n"));
}
