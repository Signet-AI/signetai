import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
	`auth:
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

afterAll(() => {
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
		const { initDbAccessor } = await import("./db-accessor");
		initDbAccessor(join(tmpDir, "memory", "memories.db"));

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
		it("POST /api/memory/remember returns 403 without auth", async () => {
			const app = await makeApp();
			const { registerMemoryRoutes } = await import("./routes/memory-routes");
			registerMemoryRoutes(app);
			expect(await status(app, "POST", "/api/memory/remember")).toBe(403);
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
			recordMemorySearchTelemetry(getDbAccessor(), {
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
			recordMemorySearchTelemetry(getDbAccessor(), {
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
