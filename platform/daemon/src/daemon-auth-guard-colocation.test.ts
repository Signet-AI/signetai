import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbOwnerClient, DbOwnerJobHandle, DbOwnerSubmitOptions } from "./db-owner-client";
import type { DbOwnerRequest } from "./db-owner-protocol";
import type { RecallParams, RecallResponse } from "./memory-search";

/*
 * Regression test for auth guard co-location refactoring.
 *
 * Goal: verify each route file protects its own endpoints with
 * requirePermission guards. A fresh Hono app registers ONLY the
 * route module under test (no centralized daemon.ts guard block).
 * In team mode with no Bearer token, requirePermission → 403.
 * Routes missing their own guards reach the handler → non-403.
 *
 * Module initialisation:
 *   state.ts ← ../pipeline ← hooks ← daemon ← git-sync ← state (cycle).
 *   Importing daemon.ts first resolves AGENTS_DIR before git-sync
 *   needs it.  SIGNET_PATH is set at module scope so AGENTS_DIR
 *   points to the temp workspace from the very first evaluation.
 */

const prevSignetPath = process.env.SIGNET_PATH;
const tmpDir = join(tmpdir(), `signet-test-auth-coloc-${Date.now()}`);
mkdirSync(join(tmpDir, "memory"), { recursive: true });
mkdirSync(join(tmpDir, ".daemon"), { recursive: true });
writeFileSync(join(tmpDir, ".daemon", "auth-secret"), "test-secret-key-32-bytes-min!!");
writeFileSync(
	join(tmpDir, "agent.yaml"),
	`memory:
  pipelineV2:
    reranker:
      enabled: true
      useExtractionModel: true
auth:
  mode: team
  rateLimits:
    forget:
      windowMs: 60000
      max: 30
    modify:
      windowMs: 60000
      max: 60
    batchForget:
      windowMs: 60000
      max: 5
    admin:
      windowMs: 60000
      max: 10
    recallLlm:
      windowMs: 60000
      max: 60
`,
);
process.env.SIGNET_PATH = tmpDir;
let closeAccessor: (() => void) | null = null;

afterAll(() => {
	closeAccessor?.();
	if (prevSignetPath === undefined) {
		Reflect.deleteProperty(process.env, "SIGNET_PATH");
	}
	if (prevSignetPath !== undefined) process.env.SIGNET_PATH = prevSignetPath;
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("auth guard co-location", () => {
	beforeAll(async () => {
		// Import daemon to warm the full module graph and break the
		// circular dependency chain (state → pipeline → hooks → daemon → git-sync → state).
		await import("./daemon");
		const { closeDbAccessor, initDbAccessor } = await import("./db-accessor");
		closeDbAccessor();
		initDbAccessor(join(tmpDir, "memory", "memories.db"));
		closeAccessor = closeDbAccessor;

		// Switch to team mode.  The initial parseAuthConfig(undefined, ...)
		// always defaults to local.  reloadAuthState reads agent.yaml from
		// disk which has mode: team.  Within the module graph, ESM live
		// bindings propagate the update to route modules.
		const state = await import("./routes/state.js");
		state.reloadAuthState(tmpDir);
	});

	async function makeApp(): Promise<InstanceType<typeof import("hono").Hono>> {
		const { Hono } = await import("hono");
		return new Hono();
	}

	async function status(app: InstanceType<typeof import("hono").Hono>, method: string, path: string): Promise<number> {
		const res = await app.request(path, { method });
		return res.status;
	}

	function sessionDeps(): import("./routes/session-routes").SessionRoutesDeps {
		return {
			gitConfig: {
				enabled: false,
				autoCommit: false,
				autoSync: false,
				syncInterval: 0,
				remote: "",
				branch: "",
			},
			stopGitSyncTimer: async () => {},
			startGitSyncTimer: () => {},
			getGitStatus: async () => ({}),
			gitPull: async () => ({}),
			gitPush: async () => ({}),
			gitSync: async () => ({}),
		};
	}

	describe("memory routes have own guards", () => {
		function rejectingRecallOwner(error: Error): DbOwnerClient {
			return {
				start: async () => {},
				submit<Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> {
					return {
						job: {
							id: "test-recall-job",
							operation: options.operation,
							lane: options.lane,
							enqueuedAt: 0,
							deadlineAt: options.deadlineMs,
							estimatedWorkUnits: options.estimatedWorkUnits ?? 1,
							cancellation: "pending",
							request,
						},
						result: Promise.reject(error),
						cancel: () => {},
					};
				},
				awaitResult<Result>(handle: DbOwnerJobHandle<Result>): Promise<Result> {
					return handle.result;
				},
				cancel: () => {},
				health: () => ({
					state: "ready",
					pid: null,
					generation: 1,
					queuedJobs: 0,
					activeJobId: null,
					lastError: null,
					deadlineKills: 0,
				}),
				close: async () => {},
			};
		}

		it("maps configured reranker provider-down failures to HTTP 503 through recall routes", async () => {
			const state = await import("./routes/state.js");
			const { Hono } = await import("hono");
			const { createAuthMiddleware, createToken } = await import("./auth");
			const { getOrCreateInferenceRouter } = await import("./inference-router");
			const { registerMemoryRoutes } = await import("./routes/memory-routes");
			const secret = state.authSecret;
			if (!secret) throw new Error("expected auth secret for team-mode recall test");
			const token = createToken(secret, { sub: "reranker-recall", role: "readonly", scope: {} }, 60);
			const server = Bun.serve({
				port: 0,
				fetch(request) {
					if (new URL(request.url).pathname.endsWith("/models")) {
						return new Response(JSON.stringify({ data: [] }), { status: 200 });
					}
					return new Response(JSON.stringify({ error: "provider unavailable" }), { status: 503 });
				},
			});
			try {
				writeFileSync(
					join(tmpDir, "agent.yaml"),
					`${readFileSync(join(tmpDir, "agent.yaml"), "utf8")}
inference:
  defaultPolicy: recall
  targets:
    local:
      executor: openai-compatible
      endpoint: http://127.0.0.1:${server.port}/v1
      models:
        default:
          model: test-model
  policies:
    recall:
      mode: strict
      defaultTargets:
        - local/default
  workloads:
    memoryExtraction:
      policy: recall
`,
				);
				const router = getOrCreateInferenceRouter(tmpDir);
				const provider = router.createWorkloadProvider("memory_extraction", "default");
				if (!provider.generateWithUsage) throw new Error("expected routed provider usage generation");
				let routedFailure: unknown;
				try {
					await provider.generateWithUsage("production-shaped reranker request");
				} catch (error) {
					routedFailure = error;
				}
				if (!(routedFailure instanceof Error)) throw new Error("expected routed provider failure");

				const app = new Hono();
				app.use("*", createAuthMiddleware(state.authConfig, secret));
				registerMemoryRoutes(app, { recallOwner: rejectingRecallOwner(routedFailure) });
				const response = await app.request("/api/memory/recall", {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ query: "provider down" }),
				});

				expect(response.status).toBe(503);
				expect(await response.json()).toEqual({ error: "Recall failed", results: [] });
			} finally {
				server.stop();
			}
		});

		it("keeps generic recall failures at HTTP 500", async () => {
			const state = await import("./routes/state.js");
			const { Hono } = await import("hono");
			const { createAuthMiddleware, createToken } = await import("./auth");
			const { registerMemoryRoutes } = await import("./routes/memory-routes");
			const secret = state.authSecret;
			if (!secret) throw new Error("expected auth secret for team-mode recall test");
			const token = createToken(secret, { sub: "internal-recall", role: "readonly", scope: {} }, 60);
			const app = new Hono();
			app.use("*", createAuthMiddleware(state.authConfig, secret));
			registerMemoryRoutes(app, { recallOwner: rejectingRecallOwner(new Error("database read failed")) });
			const response = await app.request("/api/memory/recall", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ query: "internal failure" }),
			});

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({ error: "Recall failed", results: [] });
		});

		it("records the FTS cause for a partial direct recall", async () => {
			const state = await import("./routes/state.js");
			const { Hono } = await import("hono");
			const { createAuthMiddleware, createToken } = await import("./auth");
			const { registerMemoryRoutes } = await import("./routes/memory-routes");
			const { setActiveTelemetry } = await import("./telemetry");
			const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
			setActiveTelemetry({
				record: (event: string, properties: Readonly<Record<string, string | number | boolean | null>>) =>
					events.push({ event, properties: { ...properties } }),
				recordFirstUse: () => {},
			} as never);
			const secret = state.authSecret;
			if (!secret) throw new Error("expected auth secret for team-mode recall test");
			const hybridRecallMock = mock(
				async (params: RecallParams): Promise<RecallResponse> => ({
					results: [],
					query: params.query,
					method: "hybrid",
					meta: {
						totalReturned: 0,
						hasSupplementary: false,
						noHits: true,
						partial: true,
						timings: { totalMs: 0, stages: [] },
					},
				}),
			);
			try {
				const app = new Hono();
				app.use("*", createAuthMiddleware(state.authConfig, secret));
				registerMemoryRoutes(app, { hybridRecall: hybridRecallMock, fetchEmbedding: async () => null });
				const token = createToken(secret, { sub: "partial-recall", role: "readonly", scope: {} }, 60);
				const response = await app.request("/api/memory/recall", {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ query: "partial direct recall" }),
				});

				expect(response.status).toBe(200);
				expect(hybridRecallMock).toHaveBeenCalledTimes(1);
				const operation = events.find((event) => event.event === "pipeline.operation");
				expect(operation?.properties).toMatchObject({
					operationClass: "recall",
					outcome: "partial",
					causeFamily: "fts_index_incomplete",
				});
			} finally {
				setActiveTelemetry(undefined);
			}
		});

		it("records the FTS cause for a partial aggregate recall", async () => {
			const state = await import("./routes/state.js");
			const { Hono } = await import("hono");
			const { aggregateRecall } = await import("./aggregate-recall");
			const { createAuthMiddleware, createToken } = await import("./auth");
			const { registerMemoryRoutes } = await import("./routes/memory-routes");
			const { setActiveTelemetry } = await import("./telemetry");
			const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
			setActiveTelemetry({
				record: (event: string, properties: Readonly<Record<string, string | number | boolean | null>>) =>
					events.push({ event, properties: { ...properties } }),
				recordFirstUse: () => {},
			} as never);
			const secret = state.authSecret;
			if (!secret) throw new Error("expected auth secret for team-mode aggregate recall test");
			const aggregateRecallWithPartialHybrid: typeof aggregateRecall = async (params, cfg, deps) =>
				aggregateRecall(params, cfg, {
					...deps,
					router: null,
					hybridRecall: async (recallParams) => ({
						results: [],
						query: recallParams.query,
						method: "hybrid",
						meta: {
							totalReturned: 0,
							hasSupplementary: false,
							noHits: true,
							partial: true,
							timings: { totalMs: 0, stages: [] },
						},
					}),
				});
			try {
				const app = new Hono();
				app.use("*", createAuthMiddleware(state.authConfig, secret));
				registerMemoryRoutes(app, {
					aggregateRecall: aggregateRecallWithPartialHybrid,
					getInferenceRouterOrNull: () => null,
					fetchEmbedding: async () => null,
				});
				const token = createToken(secret, { sub: "partial-aggregate-recall", role: "readonly", scope: {} }, 60);
				const response = await app.request("/api/memory/recall", {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ query: "partial aggregate recall", aggregate: true, saveAggregate: false }),
				});

				expect(response.status).toBe(200);
				expect((await response.json()).meta.partial).toBe(true);
				const operation = events.find((event) => event.event === "pipeline.operation");
				expect(operation?.properties).toMatchObject({
					operationClass: "recall",
					outcome: "partial",
					causeFamily: "fts_index_incomplete",
				});
			} finally {
				setActiveTelemetry(undefined);
			}
		});

		it("POST /api/memory/remember returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerMemoryRoutes } = await import("./routes/memory-routes");
			registerMemoryRoutes(app);
			expect(await status(app, "POST", "/api/memory/remember")).toBe(403);
		});

		it("POST /api/memory/remember rejects zero-length validity windows", async () => {
			const app = await makeApp();
			const state = await import("./routes/state.js");
			const { createAuthMiddleware, createToken } = await import("./auth");
			const { registerMemoryRoutes } = await import("./routes/memory-routes");
			const secret = state.authSecret;
			if (!secret) throw new Error("expected auth secret for team-mode remember test");

			app.use("*", createAuthMiddleware(state.authConfig, secret));
			registerMemoryRoutes(app);
			const token = createToken(secret, { sub: "remember-operator", role: "operator", scope: {} }, 60);
			const res = await app.request("/api/memory/remember", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					content: "Validity windows must have positive duration.",
					validFrom: "2026-05-13T00:00:00.000Z",
					validUntil: "2026-05-13T00:00:00.000Z",
				}),
			});

			expect(res.status).toBe(400);
			const body = (await res.json()) as { error?: string };
			expect(body.error).toContain("validUntil must be after validFrom");
		});

		it("POST /api/memory/recall aggregate save requires remember permission", async () => {
			const app = await makeApp();
			const state = await import("./routes/state.js");
			const { createAuthMiddleware, createToken } = await import("./auth");
			const { registerMemoryRoutes } = await import("./routes/memory-routes");
			const secret = state.authSecret;
			if (!secret) throw new Error("expected auth secret for team-mode recall test");

			app.use("*", createAuthMiddleware(state.authConfig, secret));
			registerMemoryRoutes(app);
			const token = createToken(secret, { sub: "readonly-recall", role: "readonly", scope: {} }, 60);
			const res = await app.request("/api/memory/recall", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					query: "aggregate save should need write permission",
					aggregate: true,
				}),
			});

			expect(res.status).toBe(403);
			const body = (await res.json()) as { error?: string };
			expect(body.error).toContain("remember");
		});

		it("POST /api/memory/recall forwards read-only aggregate options", async () => {
			const app = await makeApp();
			const state = await import("./routes/state.js");
			const { createAuthMiddleware, createToken } = await import("./auth");
			const { registerMemoryRoutes } = await import("./routes/memory-routes");
			const secret = state.authSecret;
			if (!secret) throw new Error("expected auth secret for team-mode recall test");

			let captured: RecallParams | null = null;
			const aggregateRecallMock = mock(async (params: RecallParams): Promise<RecallResponse> => {
				captured = params;
				return {
					results: [],
					query: params.query,
					method: "hybrid",
					meta: {
						totalReturned: 0,
						hasSupplementary: false,
						noHits: true,
						timings: { totalMs: 0, stages: [] },
					},
					aggregate: {
						savedMemoryId: null,
						saved: false,
						deduped: false,
						budget: "large",
						queries: [params.query],
						sourceMemoryIds: [],
						stoppedReason: "no_evidence",
					},
				};
			});

			app.use("*", createAuthMiddleware(state.authConfig, secret));
			registerMemoryRoutes(app, {
				aggregateRecall: aggregateRecallMock,
				getInferenceRouterOrNull: () => null,
				fetchEmbedding: async () => null,
			});
			const token = createToken(secret, { sub: "readonly-recall", role: "readonly", scope: {} }, 60);
			const res = await app.request("/api/memory/recall", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					query: "read-only aggregate should not save",
					aggregate: true,
					aggregateBudget: "large",
					saveAggregate: false,
				}),
			});

			expect(res.status).toBe(200);
			expect(aggregateRecallMock).toHaveBeenCalledTimes(1);
			expect(captured).toMatchObject({
				query: "read-only aggregate should not save",
				aggregate: true,
				aggregateBudget: "large",
				aggregate_budget: "large",
				saveAggregate: false,
				save_aggregate: false,
			});
			const body = (await res.json()) as RecallResponse;
			expect(body.aggregate?.saved).toBe(false);
		});

		it("POST /api/memory/recall rejects invalid aggregate budgets before aggregation", async () => {
			const app = await makeApp();
			const state = await import("./routes/state.js");
			const { createAuthMiddleware, createToken } = await import("./auth");
			const { registerMemoryRoutes } = await import("./routes/memory-routes");
			const secret = state.authSecret;
			if (!secret) throw new Error("expected auth secret for team-mode recall test");

			const aggregateRecallMock = mock(async (_params: RecallParams): Promise<RecallResponse> => {
				throw new Error("aggregateRecall should not run for invalid budgets");
			});

			app.use("*", createAuthMiddleware(state.authConfig, secret));
			registerMemoryRoutes(app, {
				aggregateRecall: aggregateRecallMock,
				getInferenceRouterOrNull: () => null,
				fetchEmbedding: async () => null,
			});
			const token = createToken(secret, { sub: "readonly-recall", role: "readonly", scope: {} }, 60);
			const res = await app.request("/api/memory/recall", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					query: "bad aggregate budget",
					aggregate: true,
					aggregateBudget: "maximum",
					saveAggregate: false,
				}),
			});

			expect(res.status).toBe(400);
			expect(aggregateRecallMock).toHaveBeenCalledTimes(0);
			const body = (await res.json()) as { error?: string };
			expect(body.error).toContain("aggregateBudget");
		});

		it("POST /api/memory/recall rejects invalid temporal ranges before recall", async () => {
			const app = await makeApp();
			const state = await import("./routes/state.js");
			const { createAuthMiddleware, createToken } = await import("./auth");
			const { registerMemoryRoutes } = await import("./routes/memory-routes");
			const secret = state.authSecret;
			if (!secret) throw new Error("expected auth secret for team-mode recall test");

			const hybridRecallMock = mock(async (_params: RecallParams): Promise<RecallResponse> => {
				throw new Error("hybridRecall should not run for invalid time ranges");
			});

			app.use("*", createAuthMiddleware(state.authConfig, secret));
			registerMemoryRoutes(app, {
				hybridRecall: hybridRecallMock,
				fetchEmbedding: async () => null,
			});
			const token = createToken(secret, { sub: "readonly-recall", role: "readonly", scope: {} }, 60);

			for (const [time, expectedError] of [
				[{ start: "not-a-date" }, "time.start"],
				[
					{
						start: "2026-05-14T00:00:00.000Z",
						end: "2026-05-13T00:00:00.000Z",
					},
					"time.end must be after time.start",
				],
			] as const) {
				const res = await app.request("/api/memory/recall", {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						query: "temporal recall",
						time,
					}),
				});

				expect(res.status).toBe(400);
				const body = (await res.json()) as { error?: string };
				expect(body.error).toContain(expectedError);
			}
			expect(hybridRecallMock).toHaveBeenCalledTimes(0);
		});
	});

	describe("session routes need guards", () => {
		it("GET /api/sessions/summaries returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerSessionRoutes } = await import("./routes/session-routes");
			registerSessionRoutes(app, sessionDeps());
			expect(await status(app, "GET", "/api/sessions/summaries")).toBe(403);
		});

		it("POST /api/git/sync returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerSessionRoutes } = await import("./routes/session-routes");
			registerSessionRoutes(app, sessionDeps());
			expect(await status(app, "POST", "/api/git/sync")).toBe(403);
		});
	});

	describe("misc routes have config guards", () => {
		it("POST /api/config returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerMiscRoutes } = await import("./routes/misc-routes");
			registerMiscRoutes(app);
			expect(await status(app, "POST", "/api/config")).toBe(403);
		});

		it("POST /api/config rejects oversized payloads before body parsing", async () => {
			const app = await makeApp();
			const { registerMiscRoutes } = await import("./routes/misc-routes");
			registerMiscRoutes(app);
			const res = await app.request("/api/config", {
				method: "POST",
				headers: { "content-length": "1048577" },
			});
			expect(res.status).toBe(413);
		});

		it("POST /api/config rejects retired memory routing before writing", async () => {
			const app = await makeApp();
			const state = await import("./routes/state.js");
			const { createAuthMiddleware, createToken } = await import("./auth");
			const { registerMiscRoutes } = await import("./routes/misc-routes");
			const secret = state.authSecret;
			if (!secret) throw new Error("expected auth secret for team-mode config test");
			app.use("*", createAuthMiddleware(state.authConfig, secret));
			registerMiscRoutes(app);
			const original = readFileSync(join(tmpDir, "agent.yaml"), "utf-8");
			const token = createToken(secret, { sub: "config-admin", role: "admin", scope: {} }, 60);
			const response = await app.request("/api/config", {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({
					file: "agent.yaml",
					content: "memory:\n  pipelineV2:\n    extractionProvider: ollama\n",
				}),
			});
			expect(response.status).toBe(400);
			expect((await response.json()) as { error: string }).toMatchObject({
				error: "memory.pipelineV2.extractionProvider is retired; configure the canonical inference workload instead.",
			});
			expect(readFileSync(join(tmpDir, "agent.yaml"), "utf-8")).toBe(original);
		});
		it("POST /api/agents distinguishes omitted, null, valid, and invalid policy_group", async () => {
			const app = await makeApp();
			const { registerMiscRoutes } = await import("./routes/misc-routes");
			registerMiscRoutes(app);
			const cases = [
				[{ name: "agent-omitted" }, 201],
				[{ name: "agent-null-isolated", read_policy: "isolated", policy_group: null }, 201],
				[{ name: "agent-null-shared", read_policy: "shared", policy_group: null }, 201],
				[{ name: "agent-valid", read_policy: "group", policy_group: "workers" }, 201],
				[{ name: "agent-number", policy_group: 42 }, 400],
				[{ name: "agent-empty", policy_group: "" }, 400],
				[{ name: "agent-oversize", policy_group: "x".repeat(129) }, 400],
			] as const;
			for (const [body, expectedStatus] of cases) {
				const response = await app.request("/api/agents", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				expect(response.status).toBe(expectedStatus);
				if (expectedStatus === 201) {
					const created = (await response.json()) as { policy_group: string | null };
					expect(created.policy_group).toBe((body as { policy_group?: string | null }).policy_group ?? null);
				}
			}
		});
	});

	describe("knowledge routes need guards", () => {
		it("POST /api/knowledge/expand returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerKnowledgeRoutes } = await import("./routes/knowledge-routes");
			registerKnowledgeRoutes(app);
			expect(await status(app, "POST", "/api/knowledge/expand")).toBe(403);
		});
	});

	describe("ontology routes need guards", () => {
		it("POST /api/ontology/proposals returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerOntologyRoutes } = await import("./routes/ontology-routes");
			registerOntologyRoutes(app);
			expect(await status(app, "POST", "/api/ontology/proposals")).toBe(403);
		});

		it("POST /api/ontology/proposals/batch returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerOntologyRoutes } = await import("./routes/ontology-routes");
			registerOntologyRoutes(app);
			expect(await status(app, "POST", "/api/ontology/proposals/batch")).toBe(403);
		});

		it("POST /api/ontology/operations/apply returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerOntologyRoutes } = await import("./routes/ontology-routes");
			registerOntologyRoutes(app);
			expect(await status(app, "POST", "/api/ontology/operations/apply")).toBe(403);
		});

		it("POST /api/ontology/operations/batch returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerOntologyRoutes } = await import("./routes/ontology-routes");
			registerOntologyRoutes(app);
			expect(await status(app, "POST", "/api/ontology/operations/batch")).toBe(403);
		});

		it("GET /api/ontology/proposals/:id/evidence returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerOntologyRoutes } = await import("./routes/ontology-routes");
			registerOntologyRoutes(app);
			expect(await status(app, "GET", "/api/ontology/proposals/test/evidence")).toBe(403);
		});

		it("GET /api/ontology/proposals/conflicts returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerOntologyRoutes } = await import("./routes/ontology-routes");
			registerOntologyRoutes(app);
			expect(await status(app, "GET", "/api/ontology/proposals/conflicts")).toBe(403);
		});

		it("POST /api/ontology/extract returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerOntologyRoutes } = await import("./routes/ontology-routes");
			registerOntologyRoutes(app);
			expect(await status(app, "POST", "/api/ontology/extract")).toBe(403);
		});

		it("POST /api/ontology/consolidate returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerOntologyRoutes } = await import("./routes/ontology-routes");
			registerOntologyRoutes(app);
			expect(await status(app, "POST", "/api/ontology/consolidate")).toBe(403);
		});

		it("GET /api/ontology/claims/evidence returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerOntologyRoutes } = await import("./routes/ontology-routes");
			registerOntologyRoutes(app);
			expect(await status(app, "GET", "/api/ontology/claims/evidence")).toBe(403);
		});

		it("GET /api/ontology/links/:id/evidence returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerOntologyRoutes } = await import("./routes/ontology-routes");
			registerOntologyRoutes(app);
			expect(await status(app, "GET", "/api/ontology/links/link-1/evidence")).toBe(403);
		});

		it("POST /api/ontology/proposals/repair/duplicates returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerOntologyRoutes } = await import("./routes/ontology-routes");
			registerOntologyRoutes(app);
			expect(await status(app, "POST", "/api/ontology/proposals/repair/duplicates")).toBe(403);
		});
	});

	describe("dream routes need guards", () => {
		it("dream status, quality, pass traces, trigger, evidence requeue, capability registry, and agent operations return 403 without auth", async () => {
			const app = await makeApp();
			const { registerPipelineRoutes } = await import("./routes/pipeline-routes");
			registerPipelineRoutes(app);
			expect(await status(app, "GET", "/api/dream/status")).toBe(403);
			expect(await status(app, "GET", "/api/dream/quality")).toBe(403);
			expect(await status(app, "POST", "/api/dream/trigger")).toBe(403);
			expect(await status(app, "POST", "/api/dream/exclusions/requeue")).toBe(403);
			expect(await status(app, "GET", "/api/dream/passes/pass-1/tools")).toBe(403);
			expect(await status(app, "POST", "/api/dream/operations")).toBe(403);
			expect(await status(app, "GET", "/api/dream/tools")).toBe(403);
			expect(await status(app, "POST", "/api/dream/tools/search_entities")).toBe(403);
		});

		it("binds agent-scoped Dreaming writes to the credential agent", async () => {
			const app = await makeApp();
			const state = await import("./routes/state.js");
			const { createAuthMiddleware, createToken } = await import("./auth");
			const { registerPipelineRoutes } = await import("./routes/pipeline-routes");
			const secret = state.authSecret;
			if (!secret) throw new Error("expected auth secret for team-mode Dreaming test");
			app.use("*", createAuthMiddleware(state.authConfig, secret));
			registerPipelineRoutes(app);
			const token = createToken(secret, { sub: "dreaming-agent-a", role: "agent", scope: { agent: "agent-a" } }, 60);
			const res = await app.request("/api/dream/operations", {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ agentId: "agent-b", operations: [{ operation: "create_entity", payload: {} }] }),
			});
			expect(res.status).toBe(403);
			const toolRes = await app.request("/api/dream/tools/search_entities", {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ agentId: "agent-b", input: { query: "Atlas" } }),
			});
			expect(toolRes.status).toBe(403);
			const manifestRes = await app.request("/api/dream/tools", {
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(manifestRes.status).toBe(200);
			const scopedToolRes = await app.request("/api/dream/tools/search_entities", {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ input: { agentId: "agent-a", query: "Atlas" } }),
			});
			expect(scopedToolRes.status).toBe(200);
			expect(await scopedToolRes.json()).toMatchObject({ tool: "search_entities", ok: true, agentId: "agent-a" });
		});
	});

	describe("connector routes need guards", () => {
		it("POST /api/connectors returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerConnectorRoutes } = await import("./routes/connectors-routes");
			registerConnectorRoutes(app);
			expect(await status(app, "POST", "/api/connectors")).toBe(403);
		});
	});

	describe("repair routes need guards", () => {
		it("POST /api/repair/requeue-dead returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerRepairRoutes } = await import("./routes/repair-routes");
			registerRepairRoutes(app);
			expect(await status(app, "POST", "/api/repair/requeue-dead")).toBe(403);
		});
	});

	describe("telemetry routes need analytics guards", () => {
		it("GET /api/telemetry/health returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerTelemetryRoutes } = await import("./routes/telemetry-routes");
			registerTelemetryRoutes(app);
			expect(await status(app, "GET", "/api/telemetry/health")).toBe(403);
		});

		it("GET /api/telemetry/memory-search returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerTelemetryRoutes } = await import("./routes/telemetry-routes");
			registerTelemetryRoutes(app);
			expect(await status(app, "GET", "/api/telemetry/memory-search")).toBe(403);
		});

		it("scopes memory search telemetry list and export to the authenticated token", async () => {
			const app = await makeApp();
			const state = await import("./routes/state.js");
			const { createAuthMiddleware, createToken } = await import("./auth");
			const { getDbAccessor } = await import("./db-accessor");
			const { recordMemorySearchTelemetry } = await import("./memory-search-telemetry");
			const { registerTelemetryRoutes } = await import("./routes/telemetry-routes");
			const secret = state.authSecret;
			if (!secret) throw new Error("expected auth secret for team-mode telemetry test");

			const response = {
				query: "recall scoped telemetry",
				method: "hybrid" as const,
				results: [],
				meta: {
					totalReturned: 0,
					hasSupplementary: false,
					noHits: true,
					timings: { totalMs: 1, stages: [] },
				},
			};
			await recordMemorySearchTelemetry(getDbAccessor(), {
				route: "GET /api/memory/search",
				agentId: "telemetry-agent-a",
				sessionKey: "telemetry-session-a",
				project: "/allowed-telemetry-project",
				params: {
					query: "recall scoped telemetry",
					agentId: "telemetry-agent-a",
					project: "/allowed-telemetry-project",
				},
				response,
				retentionDays: 90,
			});
			await recordMemorySearchTelemetry(getDbAccessor(), {
				route: "GET /api/memory/search",
				agentId: "telemetry-agent-b",
				sessionKey: "telemetry-session-b",
				project: "/other-telemetry-project",
				params: { query: "recall scoped telemetry", agentId: "telemetry-agent-b", project: "/other-telemetry-project" },
				response,
				retentionDays: 90,
			});

			app.use("*", createAuthMiddleware(state.authConfig, secret));
			registerTelemetryRoutes(app);
			const token = createToken(
				secret,
				{
					sub: "telemetry-operator",
					role: "operator",
					scope: { agent: "telemetry-agent-a", project: "/allowed-telemetry-project" },
				},
				60,
			);
			const headers = { authorization: `Bearer ${token}` };

			const list = await app.request("/api/telemetry/memory-search", { headers });
			expect(list.status).toBe(200);
			const body = (await list.json()) as { items: Array<{ agent_id: string; project: string | null }> };
			expect(body.items.map((item) => item.agent_id)).toEqual(["telemetry-agent-a"]);
			expect(body.items[0]?.project).toBe("/allowed-telemetry-project");

			const wrongAgent = await app.request("/api/telemetry/memory-search/export?agent_id=telemetry-agent-b", {
				headers,
			});
			expect(wrongAgent.status).toBe(403);
			const wrongProject = await app.request("/api/telemetry/memory-search/export?project=/other-telemetry-project", {
				headers,
			});
			expect(wrongProject.status).toBe(403);
		});
	});

	describe("database diagnostics routes need diagnostics guards", () => {
		it("GET /api/diagnostics/database/schema returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerDatabaseDiagnosticsRoutes } = await import("./routes/database-diagnostics");
			registerDatabaseDiagnosticsRoutes(app);
			expect(await status(app, "GET", "/api/diagnostics/database/schema")).toBe(403);
		});
	});

	describe("plugin routes need guards", () => {
		it("GET /api/plugins returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerPluginRoutes } = await import("./routes/plugins-routes");
			registerPluginRoutes(app);
			expect(await status(app, "GET", "/api/plugins")).toBe(403);
		});
	});

	describe("secret routes need guards", () => {
		it("GET /api/secrets returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerSecretRoutes } = await import("./routes/secrets-routes");
			registerSecretRoutes(app);
			expect(await status(app, "GET", "/api/secrets")).toBe(403);
		});
	});
});
