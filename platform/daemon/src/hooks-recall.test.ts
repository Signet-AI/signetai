import { getSyncDbAccessor } from "../legacy-sync/db-accessor-sync";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createConcurrencyAdmission } from "./concurrency-admission";
import { setFtsIndexIncomplete } from "./fts-index-state";
import {
	__setPromptSubmitAdmissionForTests,
	__setStopAdmissionForTests,
	createPromptSubmitAdmission,
	preferHookRecallCause,
} from "./routes/hooks-routes";
import { claimRecallItemsAsync } from "./session-recall-dedupe";
import {
	clearSessionStartDedupe,
	hasSessionStartDedupe,
	markSessionStartDedupe,
	recallSessionKey,
} from "./session-start-state";
import { resetSessionEndTelemetry } from "./session-end-state";
import { createTelemetryCollector, setActiveTelemetry } from "./telemetry";

let app: Hono;
let dir = "";
let prev: string | undefined;
let closeDbAccessor: (() => Promise<void>) | undefined;
let getDbAccessor: (() => import("./db-accessor").DbAccessor) | undefined;
let bypassSession: ((sessionKey: string, opts?: { readonly allowUnknown?: boolean }) => boolean) | undefined;
let releaseSession: ((sessionKey: string) => void) | undefined;
let getSessionPath: ((sessionKey: string) => "plugin" | "legacy" | undefined) | undefined;
let getEndedSession: ((sessionKey: string) => { readonly runtimePath?: "plugin" | "legacy" } | undefined) | undefined;

function skillTranscript(sessionId: string, toolUseId: string, skillName: string): string {
	return [
		JSON.stringify({
			sessionId,
			timestamp: "2024-01-01T00:00:00.000Z",
			cwd: "/tmp/project",
			message: { content: [{ type: "tool_use", name: "Skill", id: toolUseId, input: { skill: skillName } }] },
		}),
		JSON.stringify({
			sessionId,
			timestamp: "2024-01-01T00:00:01.000Z",
			cwd: "/tmp/project",
			message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: false }] },
		}),
	].join("\n");
}

async function waitForSkillInvocation(toolUseId: string): Promise<{ agent_id: string } | undefined> {
	for (let i = 0; i < 20; i++) {
		const row = getSyncDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT agent_id FROM skill_invocations WHERE tool_use_id = ?").get(toolUseId) as
					| { agent_id: string }
					| undefined,
		);
		if (row) return row;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return undefined;
}

describe("/api/hooks/recall", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-hooks-recall-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`embedding:
  provider: none
search:
  rehearsal_enabled: false
memory:
  pipelineV2:
    enabled: false
`,
		);
		process.env.SIGNET_PATH = dir;

		const dbAccessor = await import("./db-accessor");
		dbAccessor.initDbAccessor(join(dir, "memory", "memories.db"));
		closeDbAccessor = dbAccessor.closeDbAccessor;
		getDbAccessor = () => dbAccessor.getDbAccessor();
		const tracker = await import("./session-tracker");
		bypassSession = tracker.bypassSession;
		releaseSession = tracker.releaseSession;
		getSessionPath = tracker.getSessionPath;
		getEndedSession = tracker.getEndedSession;

		const daemon = await import("./daemon");
		app = daemon.app;
	});

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
		if (prev === undefined) {
			Reflect.deleteProperty(process.env as Record<string, string | undefined>, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = prev;
		}
		await closeDbAccessor?.();
		await (await import("./native-embedding")).shutdownNativeProvider();
		await (await import("./native-rerank")).shutdownNativeReranker();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	});

	it("returns 200 on valid recall request", async () => {
		bypassSession?.("valid-recall-fast", { allowUnknown: true });
		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: "openclaw",
				query: "test query",
				limit: 5,
				sessionKey: "valid-recall-fast",
			}),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.error).not.toBe("Hook execution failed");
		expect(body.meta?.noHits).toBeTrue();
		expect(body.memories).toEqual(body.results);
		expect(body.count).toBe(body.results.length);
		expect(body.message).toBe("No matching memories found.");
	});

	it("advances the session-start recall epoch after compaction", async () => {
		const sessionKey = `compaction-recall-${crypto.randomUUID()}`;
		const harness = "openclaw";
		const cwd = "/tmp/project";
		const sessionRecallKey = recallSessionKey({ harness, sessionKey });
		if (sessionRecallKey === null) throw new Error("expected a durable recall key");
		markSessionStartDedupe({ harness, cwd, sessionKey, agentId: "default" });
		expect(hasSessionStartDedupe({ harness, cwd, sessionKey, agentId: "default" })).toBeTrue();

		try {
			const first = await claimRecallItemsAsync({
				sessionKey: sessionRecallKey,
				agentId: "default",
				surface: "test",
				mode: "automatic",
				items: [{ id: "compaction-recall-memory" }],
			});
			expect(first.items).toHaveLength(1);

			const response = await app.request("/api/hooks/compaction-complete", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({ harness, cwd, sessionKey, summary: "compaction summary" }),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ success: true, contextEpoch: 1, dedupeDegraded: false });
			expect(hasSessionStartDedupe({ harness, cwd, sessionKey, agentId: "default" })).toBeFalse();

			const second = await claimRecallItemsAsync({
				sessionKey: sessionRecallKey,
				agentId: "default",
				surface: "test",
				mode: "automatic",
				items: [{ id: "compaction-recall-memory" }],
			});
			expect(second.items).toHaveLength(1);
		} finally {
			clearSessionStartDedupe({ harness, cwd, sessionKey, agentId: "default" });
			releaseSession?.(sessionKey);
		}
	});

	it("delivers prompt recall again after compaction", async () => {
		const sessionKey = `compaction-prompt-${crypto.randomUUID()}`;
		const harness = "openclaw";
		const now = new Date().toISOString();
		const config = readFileSync(join(dir, "agent.yaml"), "utf8");
		await getDbAccessor?.().withWriteTxAsync((db) => {
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-kestrel', 'Kestrel', 'kestrel', 'project', 'default', 10, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO memories (id, content, type, agent_id, updated_by, created_at, updated_at)
				 VALUES ('kestrel-deploy', 'Kestrel deploys through the canary pipeline.', 'fact', 'default', 'test', ?, ?)`,
			).run(now, now);
		});
		writeFileSync(
			join(dir, "agent.yaml"),
			`${config}hooks:\n  userPromptSubmit:\n    minScore: 0\n`.replace(
				"embedding:\n  provider: none\n",
				"embedding:\n  provider: none\n  promptSubmitTimeoutMs: 10000\n",
			),
		);
		const hook = async (route: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
			const response = await app.request(`/api/hooks/${route}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-signet-runtime-path": "plugin" },
				body: JSON.stringify({ harness, sessionKey, ...body }),
			});
			expect(response.status).toBe(200);
			return (await response.json()) as Record<string, unknown>;
		};
		const prompt = { userPrompt: "How does Kestrel deploy its pipeline?" };
		try {
			expect(await hook("user-prompt-submit", prompt)).toMatchObject({ engine: "entity-recall", memoryCount: 1 });
			expect(await hook("user-prompt-submit", prompt)).toMatchObject({ engine: "deduped", memoryCount: 0 });
			expect(await hook("compaction-complete", { summary: "compaction summary" })).toMatchObject({
				success: true,
				contextEpoch: 1,
			});
			expect(await hook("user-prompt-submit", prompt)).toMatchObject({ engine: "entity-recall", memoryCount: 1 });
		} finally {
			writeFileSync(join(dir, "agent.yaml"), config);
			releaseSession?.(sessionKey);
		}
	}, 30_000);

	it("shares one delivery ledger between hook recall and prompt recall", async () => {
		const sessionKey = `shared-ledger-${crypto.randomUUID()}`;
		const harness = "openclaw";
		const now = new Date().toISOString();
		const config = readFileSync(join(dir, "agent.yaml"), "utf8");
		await getDbAccessor?.().withWriteTxAsync((db) => {
			db.prepare(
				`INSERT OR IGNORE INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-osprey', 'Osprey', 'osprey', 'project', 'default', 10, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT OR IGNORE INTO memories (id, content, type, agent_id, updated_by, created_at, updated_at)
				 VALUES ('osprey-deploy', 'Osprey deploys through the blue pipeline.', 'fact', 'default', 'test', ?, ?)`,
			).run(now, now);
		});
		writeFileSync(
			join(dir, "agent.yaml"),
			`${config}hooks:\n  userPromptSubmit:\n    minScore: 0\n`.replace(
				"embedding:\n  provider: none\n",
				"embedding:\n  provider: none\n  promptSubmitTimeoutMs: 10000\n",
			),
		);
		const hook = async (route: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
			const response = await app.request(`/api/hooks/${route}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-signet-runtime-path": "plugin" },
				body: JSON.stringify({ harness, sessionKey, ...body }),
			});
			expect(response.status).toBe(200);
			return (await response.json()) as Record<string, unknown>;
		};
		try {
			const recalled = await hook("recall", { query: "Osprey deploys pipeline", limit: 5 });
			expect(JSON.stringify(recalled.results)).toContain("osprey-deploy");
			expect(await hook("user-prompt-submit", { userPrompt: "How does Osprey deploy its pipeline?" })).toMatchObject({
				engine: "deduped",
				memoryCount: 0,
			});
		} finally {
			writeFileSync(join(dir, "agent.yaml"), config);
			releaseSession?.(sessionKey);
		}
	}, 30_000);

	it("delivers a fresh memory ranked below ones the session already received", async () => {
		const sessionKey = `falcon-${crypto.randomUUID()}`;
		const now = new Date().toISOString();
		const config = readFileSync(join(dir, "agent.yaml"), "utf8");
		await getDbAccessor?.().withWriteTxAsync((db) => {
			db.prepare(
				`INSERT OR IGNORE INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-falcon', 'Falcon', 'falcon', 'project', 'default', 10, ?, ?)`,
			).run(now, now);
			const memory = db.prepare(
				`INSERT OR IGNORE INTO memories (id, content, type, agent_id, updated_by, created_at, updated_at)
				 VALUES (?, ?, 'fact', 'default', 'test', ?, ?)`,
			);
			const event = db.prepare(
				`INSERT INTO session_recall_events (session_key, agent_id, context_epoch, item_kind, item_id, surface, mode)
				 VALUES (?, 'default', 0, 'memory', ?, 'api.hooks.user-prompt-submit', 'automatic')`,
			);
			for (let i = 0; i < 15; i++) {
				memory.run(
					`falcon-${i}`,
					`Falcon deploy pipeline step ${i}: Falcon deploys its pipeline in stage ${i}.`,
					now,
					now,
				);
				event.run(`${sessionKey}\0openclaw`, `falcon-${i}`);
			}
			for (let i = 0; i < 250; i++) event.run(`${sessionKey}\0openclaw`, `unrelated-${i}`);
			db.prepare(
				"UPDATE session_recall_events SET created_at = datetime('now', '+1 hour') WHERE item_id LIKE 'unrelated-%'",
			).run();
			memory.run(
				"falcon-fresh",
				"A long note about lunch, weather, and travel plans also says the Falcon deploy pipeline exists.",
				now,
				now,
			);
		});
		writeFileSync(
			join(dir, "agent.yaml"),
			`${config}hooks:\n  userPromptSubmit:\n    minScore: 0\n    recallLimit: 10\n`.replace(
				"embedding:\n  provider: none\n",
				"embedding:\n  provider: none\n  promptSubmitTimeoutMs: 10000\n",
			),
		);
		try {
			const response = await app.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-signet-runtime-path": "plugin" },
				body: JSON.stringify({ harness: "openclaw", sessionKey, userPrompt: "How does Falcon deploy its pipeline?" }),
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as { engine?: string; inject?: string };
			expect(body.engine).toBe("entity-recall");
			expect(body.inject).toContain("(falcon-fresh)");
		} finally {
			writeFileSync(join(dir, "agent.yaml"), config);
			releaseSession?.(sessionKey);
		}
	}, 30_000);

	it("labels partial FTS recall separately from provider outages", async () => {
		setFtsIndexIncomplete(true);
		try {
			const resp = await app.request("/api/hooks/recall", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ harness: "openclaw", query: "partial index", limit: 5 }),
			});

			expect(resp.status).toBe(200);
			expect(resp.headers.get("x-signet-operation-degraded")).toBe("1");
			expect(resp.headers.get("x-signet-operation-cause")).toBe("fts_index_incomplete");
		} finally {
			setFtsIndexIncomplete(false);
		}
	});

	it("keeps provider_unavailable when FTS and provider degradation coexist", () => {
		expect(preferHookRecallCause("fts_index_incomplete", "provider_unavailable")).toBe("provider_unavailable");
		expect(preferHookRecallCause("provider_unavailable", "fts_index_incomplete")).toBe("provider_unavailable");
	});

	it("records recall attempt and outcome telemetry at the hook boundary", async () => {
		if (!getDbAccessor) throw new Error("db accessor unavailable");
		const collector = createTelemetryCollector(
			getDbAccessor(),
			{
				posthogHost: "",
				posthogApiKey: "",
				flushIntervalMs: 60000,
				flushBatchSize: 50,
				retentionDays: 90,
				memorySearchQaEnabled: false,
			},
			"0.0.0-test",
		);
		setActiveTelemetry(collector);
		try {
			const resp = await app.request("/api/hooks/recall", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					harness: "openclaw",
					query: "telemetry boundary",
					limit: 5,
				}),
			});
			expect(resp.status).toBe(200);

			await collector.flush();
			const events = await collector.query();
			expect(
				events.some((event) => event.event === "recall.attempted" && event.properties.surface === "tool_call"),
			).toBeTrue();
			expect(
				events.some((event) => event.event === "recall.outcome" && event.properties.surface === "tool_call"),
			).toBeTrue();
		} finally {
			setActiveTelemetry(undefined);
		}
	});

	it("keeps explicit recall independent of the prompt-submit low-signal gate", async () => {
		if (!getDbAccessor) throw new Error("db accessor unavailable");
		const collector = createTelemetryCollector(
			getDbAccessor(),
			{
				posthogHost: "",
				posthogApiKey: "",
				flushIntervalMs: 60000,
				flushBatchSize: 50,
				retentionDays: 90,
				memorySearchQaEnabled: false,
			},
			"0.0.0-test",
		);
		setActiveTelemetry(collector);
		try {
			const resp = await app.request("/api/hooks/recall", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ harness: "openclaw", query: "okay", limit: 5 }),
			});

			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.error).not.toBe("Hook execution failed");
			expect(body.meta).toBeDefined();

			await collector.flush();
			const events = await collector.query();
			expect(
				events.some((event) => event.event === "recall.attempted" && event.properties.surface === "tool_call"),
			).toBeTrue();
			const outcome = events.find(
				(event) => event.event === "recall.outcome" && event.properties.surface === "tool_call",
			);
			expect(outcome).toBeDefined();
			expect(outcome?.properties.reason).toBeUndefined();
		} finally {
			setActiveTelemetry(undefined);
		}
	});

	it("records session.deleted as one real session.end at the route boundary", async () => {
		if (!getDbAccessor) throw new Error("db accessor unavailable");
		const collector = createTelemetryCollector(
			getDbAccessor(),
			{
				posthogHost: "",
				posthogApiKey: "test-key",
				flushIntervalMs: 60000,
				flushBatchSize: 50,
				retentionDays: 90,
				memorySearchQaEnabled: false,
			},
			"0.0.0-test",
		);
		setActiveTelemetry(collector);
		resetSessionEndTelemetry();
		try {
			const sessionKey = "opencode-route-boundary";
			const headers = { "Content-Type": "application/json" };
			const start = await app.request("/api/hooks/session-start", {
				method: "POST",
				headers,
				body: JSON.stringify({ harness: "opencode", sessionKey }),
			});
			expect(start.status).toBe(200);

			const end = await app.request("/api/hooks/session-end", {
				method: "POST",
				headers,
				body: JSON.stringify({ harness: "opencode", sessionKey, reason: "session.deleted" }),
			});
			expect(end.status).toBe(200);

			const duplicate = await app.request("/api/hooks/session-end", {
				method: "POST",
				headers,
				body: JSON.stringify({ harness: "opencode", sessionKey, reason: "session.deleted" }),
			});
			expect(duplicate.status).toBe(200);

			await collector.flush();
			const events = await collector.query();
			const ends = events.filter((event) => event.event === "session.end");
			expect(ends).toHaveLength(1);
			expect(ends[0]?.properties.reason).toBe("session.deleted");
			expect(
				events.some((event) => event.event === "recall.attempted" && event.properties.surface === "prompt_injection"),
			).toBeTrue();
			expect(
				events.some((event) => event.event === "recall.outcome" && event.properties.surface === "prompt_injection"),
			).toBeTrue();
		} finally {
			setActiveTelemetry(undefined);
			resetSessionEndTelemetry();
		}
	});

	it("treats a non-string session-end reason as a non-boundary call", async () => {
		const resp = await app.request("/api/hooks/session-end", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ harness: "opencode", sessionKey: "malformed-reason", reason: 123 }),
		});

		expect(resp.status).toBe(200);
	});

	it("rejects requests missing harness", async () => {
		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "test" }),
		});

		expect(resp.status).toBe(400);
	});

	it("rejects requests missing query", async () => {
		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ harness: "openclaw" }),
		});

		expect(resp.status).toBe(400);
	});

	it("rejects invalid aggregate budgets", async () => {
		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: "openclaw",
				query: "project history",
				aggregate: true,
				aggregate_budget: "maximum",
				saveAggregate: false,
			}),
		});

		expect(resp.status).toBe(400);
		const body = (await resp.json()) as { error?: string };
		expect(body.error).toContain("aggregateBudget");
	});

	it("returns the normalized no-op shape for internal calls", async () => {
		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-signet-no-hooks": "1",
			},
			body: JSON.stringify({
				harness: "openclaw",
				query: "test query",
			}),
		});

		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body).toMatchObject({
			results: [],
			memories: [],
			count: 0,
			query: "",
			method: "hybrid",
			meta: {
				totalReturned: 0,
				hasSupplementary: false,
				noHits: true,
			},
			message: "No matching memories found.",
			internal: true,
		});
	});

	it("returns the normalized no-op shape for bypassed sessions", async () => {
		bypassSession?.("session-bypass", { allowUnknown: true });

		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: "openclaw",
				query: "test query",
				sessionKey: "session-bypass",
			}),
		});

		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body).toMatchObject({
			results: [],
			memories: [],
			count: 0,
			query: "test query",
			method: "hybrid",
			meta: {
				totalReturned: 0,
				hasSupplementary: false,
				noHits: true,
			},
			message: "No matching memories found.",
			bypassed: true,
		});
	});

	it("reclaims a restarted session without rebuilding startup context (#1243)", async () => {
		const sessionKey = "claim-only-recovery";
		try {
			const resp = await app.request("/api/hooks/session-start", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({ harness: "hermes-agent", sessionKey, claimOnly: true }),
			});

			expect(resp.status).toBe(200);
			expect(await resp.json()).toEqual({ sessionKnown: true });
			expect(getSessionPath?.(sessionKey)).toBe("plugin");
		} finally {
			releaseSession?.(sessionKey);
		}
	});

	it("rejects claim-only recovery without a runtime path (#1243)", async () => {
		const sessionKey = "claim-only-missing-runtime-path";
		const resp = await app.request("/api/hooks/session-start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ harness: "hermes-agent", sessionKey, claimOnly: true }),
		});

		expect(resp.status).toBe(400);
		expect(await resp.json()).toEqual({ error: "claimOnly requires a runtime path" });
		expect(getSessionPath?.(sessionKey)).toBeUndefined();
	});

	it("skips duplicate user-prompt-submit calls from a conflicting runtime path", async () => {
		const sessionKey = "duplicate-runtime-session";
		try {
			const first = await app.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					userMessage: "deploy checklist",
					sessionKey,
				}),
			});

			expect(first.status).toBe(200);
			const firstBody = await first.json();
			expect(firstBody.duplicateRuntimePath).not.toBe(true);

			const duplicate = await app.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "legacy",
				},
				body: JSON.stringify({
					harness: "claude-code",
					userMessage: "deploy checklist",
					sessionKey,
				}),
			});

			expect(duplicate.status).toBe(200);
			const duplicateBody = await duplicate.json();
			expect(duplicateBody).toMatchObject({
				inject: "",
				memoryCount: 0,
				skipped: true,
				duplicateRuntimePath: true,
				claimedBy: "plugin",
				sessionKnown: true,
			});
		} finally {
			releaseSession?.(sessionKey);
		}
	});

	it("does not let a duplicate session-end release the owning runtime claim", async () => {
		const sessionKey = "duplicate-session-end";
		try {
			const first = await app.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					userMessage: "deploy checklist",
					sessionKey,
				}),
			});

			expect(first.status).toBe(200);
			expect(getSessionPath?.(sessionKey)).toBe("plugin");

			const duplicateEnd = await app.request("/api/hooks/session-end", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "legacy",
				},
				body: JSON.stringify({
					harness: "claude-code",
					sessionKey,
					transcript: "user: deploy checklist",
				}),
			});

			expect(duplicateEnd.status).toBe(200);
			expect(await duplicateEnd.json()).toMatchObject({
				memoriesSaved: 0,
				skipped: true,
				duplicateRuntimePath: true,
				claimedBy: "plugin",
			});
			expect(getSessionPath?.(sessionKey)).toBe("plugin");
		} finally {
			releaseSession?.(sessionKey);
		}
	});

	it("rejects skill invocation posts from a conflicting runtime path", async () => {
		const sessionKey = "duplicate-skill-invocation-runtime";
		try {
			const first = await app.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					userMessage: "deploy checklist",
					sessionKey,
				}),
			});
			expect(first.status).toBe(200);

			const duplicate = await app.request("/api/hooks/skill-invocation", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "legacy",
				},
				body: JSON.stringify({
					harness: "claude-code",
					skillName: "web-search",
					sessionKey,
					toolUseId: "toolu_conflict",
				}),
			});

			expect(duplicate.status).toBe(409);
		} finally {
			releaseSession?.(sessionKey);
		}
	});

	it("rejects malformed skill invocation timestamps", async () => {
		const resp = await app.request("/api/hooks/skill-invocation", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: "claude-code",
				skillName: "web-search",
				createdAt: "not-a-date",
			}),
		});

		expect(resp.status).toBe(400);
		expect(await resp.json()).toMatchObject({ error: "createdAt must be an ISO timestamp" });
	});

	it("rejects malformed skill invocation latency", async () => {
		const resp = await app.request("/api/hooks/skill-invocation", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: "claude-code",
				skillName: "web-search",
				latencyMs: "123abc",
			}),
		});

		expect(resp.status).toBe(400);
		expect(await resp.json()).toMatchObject({ error: "latencyMs must be a non-negative integer" });
	});

	it("records session-end transcript skill scans under the session agent scope", async () => {
		const sessionKey = "agent:scan-agent:end";
		const toolUseId = `toolu_session_end_${crypto.randomUUID()}`;
		const transcriptPath = join(dir, "session-end-skills.jsonl");
		writeFileSync(transcriptPath, skillTranscript(sessionKey, toolUseId, "web-search"));
		try {
			const resp = await app.request("/api/hooks/session-end", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					harness: "claude-code",
					sessionKey,
					transcriptPath,
				}),
			});

			expect(resp.status).toBe(200);
			const row = await waitForSkillInvocation(toolUseId);
			expect(row?.agent_id).toBe("scan-agent");
		} finally {
			releaseSession?.(sessionKey);
		}
	});

	it("requires remember permission before recording a session-end assistant reply", async () => {
		const { authConfig } = await import("./routes/state");
		const { registerHooksRoutes } = await import("./routes/hooks-routes");
		const { Hono } = await import("hono");
		const routes = new Hono();
		registerHooksRoutes(routes);
		const sessionKey = `muse-unauthorized-${crypto.randomUUID()}`;
		const previousMode = authConfig.mode;
		Object.assign(authConfig, { mode: "team" });
		try {
			const resp = await routes.request("/api/hooks/session-end", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					harness: "muse-code",
					sessionKey,
					agentId: "someone-else",
					lastAssistantMessage: "forged assistant turn",
				}),
			});

			expect(resp.status).toBe(403);
			const row = getSyncDbAccessor().withReadDb((db) =>
				db.prepare("SELECT COUNT(*) AS count FROM session_transcripts WHERE session_key = ?").get(sessionKey),
			);
			expect(row).toEqual({ count: 0 });
		} finally {
			Object.assign(authConfig, { mode: previousMode });
			releaseSession?.(sessionKey);
		}
	});

	async function postStop(body: Record<string, unknown>, routes: Pick<Hono, "request"> = app): Promise<Response> {
		return routes.request("/api/hooks/stop", {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-signet-runtime-path": "legacy" },
			body: JSON.stringify(body),
		});
	}

	function stopRecords(sessionKey: string): Record<string, unknown>[] {
		const path = join(dir, "memory", "claude-code", "transcripts", "transcript.jsonl");
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((record) => record.session_key === sessionKey);
	}

	function storedTranscript(sessionKey: string): unknown {
		return getSyncDbAccessor().withReadDb((db) =>
			db.prepare("SELECT content FROM session_transcripts WHERE session_key = ?").get(sessionKey),
		);
	}

	it("records a stop hook reply even when the harness has a transcript source", async () => {
		const sessionKey = `claude-stop-route-${crypto.randomUUID()}`;
		const resp = await postStop({
			harness: "claude-code",
			sessionKey,
			transcriptPath: join(dir, "stop-route-source.jsonl"),
			lastAssistantMessage: "route reply",
		});

		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ recorded: true });
		expect(storedTranscript(sessionKey)).toEqual({ content: "Assistant: route reply" });
		expect(stopRecords(sessionKey)).toMatchObject([
			{ role: "assistant", content: "route reply", source_format: "live" },
		]);
		expect(getSessionPath?.(sessionKey)).toBeUndefined();
		expect(getEndedSession?.(sessionKey)).toBeUndefined();
	});

	it("validates the stop hook request and treats a missing reply as nothing to record", async () => {
		const badBody = await app.request("/api/hooks/stop", {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-signet-runtime-path": "legacy" },
			body: "{",
		});
		expect(badBody.status).toBe(400);
		expect(await badBody.json()).toEqual({ error: "invalid_request", reason: "invalid_request" });

		const sessionKey = `claude-stop-rejected-${crypto.randomUUID()}`;
		const rejected = [
			{ body: { sessionKey, lastAssistantMessage: "reply" }, status: 400, error: "harness is required" },
			{ body: { harness: "claude-code", lastAssistantMessage: "reply" }, status: 400, error: "sessionKey is required" },
			{
				body: { harness: "claude-code", sessionKey, lastAssistantMessage: 42 },
				status: 400,
				error: "lastAssistantMessage must be a string",
			},
			{
				body: { harness: "claude-code", sessionKey, lastAssistantMessage: null },
				status: 400,
				error: "lastAssistantMessage must be a string",
			},
			{
				body: { harness: "claude-code", sessionKey, lastAssistantMessage: "x".repeat(262_145) },
				status: 413,
				error: "lastAssistantMessage exceeds 262144 characters",
			},
		];
		for (const { body, status, error } of rejected) {
			const resp = await postStop(body);
			expect(resp.status).toBe(status);
			expect(await resp.json()).toEqual({ error });
		}
		expect(stopRecords(sessionKey)).toEqual([]);

		const noReply = await postStop({ harness: "claude-code", sessionKey });
		expect(noReply.status).toBe(200);
		expect(await noReply.json()).toEqual({ recorded: false });
		expect(stopRecords(sessionKey)).toEqual([]);

		const aliasKey = `claude-stop-alias-${crypto.randomUUID()}`;
		const alias = await postStop({ harness: "claude-code", sessionId: aliasKey, lastAssistantMessage: "alias reply" });
		expect(alias.status).toBe(200);
		expect(stopRecords(aliasKey)).toMatchObject([{ role: "assistant", content: "alias reply" }]);
	});

	it("records a retried stop hook reply at the size limit once", async () => {
		const sessionKey = `claude-stop-limit-${crypto.randomUUID()}`;
		const lastAssistantMessage = "x".repeat(262_144);
		for (let attempt = 0; attempt < 2; attempt++) {
			const resp = await postStop({ harness: "claude-code", sessionKey, lastAssistantMessage });
			expect(resp.status).toBe(200);
		}

		expect(stopRecords(sessionKey)).toHaveLength(1);
	});

	it("rejects a stop hook reply from a caller without remember permission or outside its agent scope", async () => {
		const { authConfig } = await import("./routes/state");
		const { registerHooksRoutes } = await import("./routes/hooks-routes");
		const { Hono } = await import("hono");
		const now = Math.floor(Date.now() / 1000);
		const cases = [
			{
				agent: "stop-reader",
				role: "readonly",
				agentId: "stop-reader",
				error: "role 'readonly' lacks 'remember' permission",
			},
			{
				agent: "stop-writer",
				role: "agent",
				agentId: "someone-else",
				error: "scope restricted to agent 'stop-writer'",
			},
		] as const;
		const previousMode = authConfig.mode;
		Object.assign(authConfig, { mode: "team" });
		try {
			for (const { agent, role, agentId, error } of cases) {
				const routes = new Hono();
				routes.use("*", async (c, next) => {
					c.set("auth", {
						authenticated: true,
						claims: { sub: agent, scope: { agent }, role, iat: now, exp: now + 3600 },
					});
					await next();
				});
				registerHooksRoutes(routes);
				const sessionKey = `claude-stop-denied-${crypto.randomUUID()}`;
				const resp = await postStop(
					{ harness: "claude-code", sessionKey, agentId, lastAssistantMessage: "forged assistant turn" },
					routes,
				);

				expect(resp.status).toBe(403);
				expect(await resp.json()).toEqual(
					role === "readonly" ? { error, reason: "permission", required: "remember" } : { error },
				);
				expect(storedTranscript(sessionKey)).toBeNull();
				expect(stopRecords(sessionKey)).toEqual([]);
			}
		} finally {
			Object.assign(authConfig, { mode: previousMode });
		}
	});

	it("records a stop hook reply under the agent prompt submit resolved for a scoped admin token", async () => {
		const { authConfig } = await import("./routes/state");
		const { registerHooksRoutes } = await import("./routes/hooks-routes");
		const { Hono } = await import("hono");
		const now = Math.floor(Date.now() / 1000);
		const routes = new Hono();
		routes.use("*", async (c, next) => {
			c.set("auth", {
				authenticated: true,
				claims: { sub: "stop-admin", scope: { agent: "stop-admin-agent" }, role: "admin", iat: now, exp: now + 3600 },
			});
			await next();
		});
		registerHooksRoutes(routes);
		const sessionKey = `claude-stop-admin-${crypto.randomUUID()}`;
		const previousMode = authConfig.mode;
		Object.assign(authConfig, { mode: "team" });
		try {
			const prompt = await routes.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-signet-runtime-path": "legacy" },
				body: JSON.stringify({ harness: "claude-code", sessionKey, userMessage: "admin prompt" }),
			});
			expect(prompt.status).toBe(200);

			const resp = await postStop({ harness: "claude-code", sessionKey, lastAssistantMessage: "admin reply" }, routes);

			expect(resp.status).toBe(200);
			expect(await resp.json()).toEqual({ recorded: true });
			const row = getSyncDbAccessor().withReadDb((db) =>
				db.prepare("SELECT agent_id, content FROM session_transcripts WHERE session_key = ?").all(sessionKey),
			);
			expect(row).toEqual([{ agent_id: "default", content: "User: admin prompt\nAssistant: admin reply" }]);
		} finally {
			Object.assign(authConfig, { mode: previousMode });
			releaseSession?.(sessionKey);
		}
	});

	async function withFailingTranscriptWrites<T>(failure: Error, run: () => Promise<T>): Promise<T> {
		const owner = await import("./db-owner-runtime");
		const write = spyOn(owner, "dbOwnerWriteSessionTranscript").mockRejectedValue(failure);
		try {
			return await run();
		} finally {
			write.mockRestore();
		}
	}

	it("does not commit a stop projection until evidence sync succeeds, including retries", async () => {
		const sessionKey = crypto.randomUUID();
		const body = { harness: "claude-code", sessionKey, lastAssistantMessage: "durable reply" };
		const originalOpen = fsPromises.open;
		const opening = spyOn(fsPromises, "open").mockImplementation(async (...args) => {
			const file = await originalOpen(...args);
			if (String(args[0]).endsWith("transcript.jsonl")) {
				file.sync = async () => {
					throw new Error("forced evidence sync failure");
				};
			}
			return file;
		});
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const response = await postStop(body);
				expect(response.status).toBe(500);
				expect(storedTranscript(sessionKey)).toBeNull();
			}
		} finally {
			opening.mockRestore();
		}
		const response = await postStop(body);
		expect(response.status).toBe(200);
		expect(stopRecords(sessionKey)).toHaveLength(1);
		expect(storedTranscript(sessionKey)).toBeNull();
	});

	it("warns and preserves the projection gap when a retry finds evidence committed before write pressure", async () => {
		const { DbOwnerAdmissionError } = await import("./db-owner-client");
		const sessionKey = `claude-stop-pressure-${crypto.randomUUID()}`;
		const body = { harness: "claude-code", sessionKey, lastAssistantMessage: "pressured reply" };

		const blocked = await withFailingTranscriptWrites(
			new DbOwnerAdmissionError("DB_OWNER_QUEUE_FULL", "owner queue is full"),
			() => postStop(body),
		);
		expect(blocked.status).toBe(503);
		expect(blocked.headers.get("Retry-After")).toBe("1");
		expect(await blocked.json()).toMatchObject({ retryable: true });
		expect(storedTranscript(sessionKey)).toBeNull();

		const evidence = stopRecords(sessionKey);
		const { logger } = await import("./logger");
		const warning = spyOn(logger, "warn");
		try {
			const retried = await postStop(body);
			expect(retried.status).toBe(200);
			expect(await retried.json()).toEqual({ recorded: true });
			expect(warning).toHaveBeenCalledWith(
				"hooks",
				"Duplicate transcript evidence; projection append skipped and any prior gap remains",
				{ sessionKey },
			);
		} finally {
			warning.mockRestore();
		}
		expect(storedTranscript(sessionKey)).toBeNull();
		expect(stopRecords(sessionKey)).toEqual(evidence);
		expect(evidence).toMatchObject([{ role: "assistant", content: "pressured reply" }]);
	});

	it("fails the stop hook request when the transcript row write fails", async () => {
		const sessionKey = `claude-stop-row-failed-${crypto.randomUUID()}`;

		const resp = await withFailingTranscriptWrites(new Error("forced row failure"), () =>
			postStop({ harness: "claude-code", sessionKey, lastAssistantMessage: "unrecorded reply" }),
		);

		expect(resp.status).toBe(500);
		expect(await resp.json()).toEqual({ error: "Hook execution failed" });
		expect(storedTranscript(sessionKey)).toBeNull();
	});

	it("releases the stop cap after a recorded reply and after a failed one", async () => {
		writeFileSync(join(dir, "memory", "stop-blocked"), "not a directory");
		__setStopAdmissionForTests(createConcurrencyAdmission(1));
		try {
			const recorded = await postStop({
				harness: "claude-code",
				sessionKey: `claude-stop-release-${crypto.randomUUID()}`,
				lastAssistantMessage: "first reply",
			});
			expect(recorded.status).toBe(200);

			const failed = await postStop({
				harness: "stop-blocked",
				sessionKey: `claude-stop-release-${crypto.randomUUID()}`,
				lastAssistantMessage: "blocked reply",
			});
			expect(failed.status).toBe(500);
			expect(await failed.json()).toEqual({ error: "Hook execution failed" });

			const sessionKey = `claude-stop-release-${crypto.randomUUID()}`;
			const after = await postStop({ harness: "claude-code", sessionKey, lastAssistantMessage: "later reply" });
			expect(after.status).toBe(200);
			expect(stopRecords(sessionKey)).toHaveLength(1);
		} finally {
			__setStopAdmissionForTests(null);
		}
	});

	it("rejects a stop hook reply with 503 while the stop cap is saturated", async () => {
		const sessionKey = `claude-stop-saturated-${crypto.randomUUID()}`;
		__setStopAdmissionForTests(createConcurrencyAdmission(0));
		try {
			const resp = await postStop({ harness: "claude-code", sessionKey, lastAssistantMessage: "busy reply" });

			expect(resp.status).toBe(503);
			expect(resp.headers.get("Retry-After")).toBe("1");
			expect(stopRecords(sessionKey)).toEqual([]);
		} finally {
			__setStopAdmissionForTests(null);
		}
	});

	it("rejects saturated stop requests before reading chunked bodies", async () => {
		let reads = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					reads++;
					controller.enqueue(new TextEncoder().encode("{}"));
					controller.close();
				},
			},
			{ highWaterMark: 0 },
		);
		__setStopAdmissionForTests(createConcurrencyAdmission(0));
		try {
			const response = await app.request(new Request("http://localhost/api/hooks/stop", { method: "POST", body }));
			expect(response.status).toBe(503);
			expect(reads).toBe(0);
		} finally {
			__setStopAdmissionForTests(null);
			await body.cancel();
		}
	});

	it("bounds admitted stop bodies and releases admission after a body rejection", async () => {
		__setStopAdmissionForTests(createConcurrencyAdmission(1));
		try {
			const response = await app.request("/api/hooks/stop", { method: "POST", body: "x".repeat(2 * 1_048_576 + 1) });
			expect(response.status).toBe(413);
			const next = await postStop({ harness: "claude-code", sessionKey: crypto.randomUUID() });
			expect(next.status).toBe(200);
		} finally {
			__setStopAdmissionForTests(null);
		}
	});

	it("skips pathless and invalid-runtime stop replies for claimed sessions", async () => {
		const tracker = await import("./session-tracker");
		const sessionKey = crypto.randomUUID();
		tracker.claimSession(sessionKey, "plugin");
		try {
			for (const runtimePath of [undefined, "unknown"]) {
				const response = await app.request("/api/hooks/stop", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ harness: "claude-code", sessionKey, runtimePath, lastAssistantMessage: "foreign" }),
				});
				expect(await response.json()).toMatchObject({ recorded: false, skipped: true, claimedBy: "plugin" });
			}
			expect(stopRecords(sessionKey)).toEqual([]);
			expect(storedTranscript(sessionKey)).toBeNull();
		} finally {
			tracker.releaseSession(sessionKey);
		}
	});

	it("enforces requested and stored project scope before writing stop evidence", async () => {
		const { authConfig } = await import("./routes/state");
		const { registerHooksRoutes } = await import("./routes/hooks-routes");
		const { upsertSessionTranscriptAsync } = await import("./session-transcripts");
		const { Hono } = await import("hono");
		const routes = new Hono();
		const now = Math.floor(Date.now() / 1000);
		routes.use("*", async (c, next) => {
			c.set("auth", {
				authenticated: true,
				claims: {
					sub: "project-agent",
					role: "agent",
					scope: { agent: "project-agent", project: "/allowed" },
					iat: now,
					exp: now + 3600,
				},
			});
			await next();
		});
		registerHooksRoutes(routes);
		const previousMode = authConfig.mode;
		Object.assign(authConfig, { mode: "team" });
		try {
			for (const existingProject of [undefined, "/outside", null]) {
				const sessionKey = crypto.randomUUID();
				if (existingProject !== undefined)
					await upsertSessionTranscriptAsync(
						sessionKey,
						"User: original",
						"claude-code",
						existingProject,
						"project-agent",
					);
				const response = await postStop(
					{
						harness: "claude-code",
						sessionKey,
						agentId: "project-agent",
						cwd: existingProject === undefined ? "/outside" : "/allowed",
						lastAssistantMessage: "scoped reply",
					},
					routes,
				);
				expect(response.status).toBe(403);
				expect(stopRecords(sessionKey)).toEqual([]);
			}
			const sessionKey = crypto.randomUUID();
			const response = await postStop(
				{ harness: "claude-code", sessionKey, agentId: "project-agent", lastAssistantMessage: "allowed reply" },
				routes,
			);
			expect(response.status).toBe(200);
			expect(stopRecords(sessionKey)).toMatchObject([{ project: "/allowed", agent_id: "project-agent" }]);
		} finally {
			Object.assign(authConfig, { mode: previousMode });
		}
	});

	it("skips a stop hook reply without claiming a foreign, ended or bypassed session", async () => {
		const tracker = await import("./session-tracker");
		const cases = [
			{
				setup: (key: string) => tracker.claimSession(key, "plugin"),
				body: { recorded: false, skipped: true, duplicateRuntimePath: true, claimedBy: "plugin" },
				owner: "plugin" as const,
			},
			{
				setup: (key: string) => tracker.markSessionEnded(key, "legacy"),
				body: { recorded: false, skipped: true, sessionEnded: true },
				owner: undefined,
			},
			{
				setup: (key: string) => tracker.bypassSession(key, { allowUnknown: true }),
				body: { recorded: false, bypassed: true },
				owner: undefined,
			},
		];
		for (const { setup, body, owner } of cases) {
			const sessionKey = `claude-stop-skip-${crypto.randomUUID()}`;
			setup(sessionKey);
			try {
				const resp = await postStop({ harness: "claude-code", sessionKey, lastAssistantMessage: "skipped reply" });

				expect(resp.status).toBe(200);
				expect(await resp.json()).toEqual(body);
				expect(stopRecords(sessionKey)).toEqual([]);
				expect(getSessionPath?.(sessionKey)).toBe(owner);
				expect(Boolean(getEndedSession?.(sessionKey))).toBe("sessionEnded" in body);
			} finally {
				releaseSession?.(sessionKey);
			}
		}
	});

	it("records pre-compaction transcript skill scans under the explicit agent scope", async () => {
		const sessionKey = "pre-compaction-scan-agent";
		const toolUseId = `toolu_precompact_${crypto.randomUUID()}`;
		const transcriptPath = join(dir, "pre-compaction-skills.jsonl");
		writeFileSync(transcriptPath, skillTranscript(sessionKey, toolUseId, "web-search"));
		try {
			const resp = await app.request("/api/hooks/pre-compaction", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					harness: "claude-code",
					sessionKey,
					agentId: "explicit-scan-agent",
					transcriptPath,
				}),
			});

			expect(resp.status).toBe(200);
			const row = await waitForSkillInvocation(toolUseId);
			expect(row?.agent_id).toBe("explicit-scan-agent");
		} finally {
			releaseSession?.(sessionKey);
		}
	});

	it("skips conflicting automatic lifecycle hooks without surfacing harness errors", async () => {
		const sessionKey = "duplicate-lifecycle-hook";
		try {
			const first = await app.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					userMessage: "deploy checklist",
					sessionKey,
				}),
			});
			expect(first.status).toBe(200);

			const duplicate = await app.request("/api/hooks/pre-compaction", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "legacy",
				},
				body: JSON.stringify({
					harness: "claude-code",
					sessionKey,
				}),
			});

			expect(duplicate.status).toBe(200);
			expect(await duplicate.json()).toMatchObject({
				guidelines: "",
				instructions: "",
				summaryPrompt: "",
				skipped: true,
				duplicateRuntimePath: true,
				claimedBy: "plugin",
			});
		} finally {
			releaseSession?.(sessionKey);
		}
	});

	it("keeps unmarked session-end calls compatible after a marked runtime ended", async () => {
		const sessionKey = "unmarked-session-end-after-owner";
		try {
			const first = await app.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					userMessage: "deploy checklist",
					sessionKey,
				}),
			});
			expect(first.status).toBe(200);

			const ownerEnd = await app.request("/api/hooks/session-end", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					sessionKey,
					transcript: "user: deploy checklist",
				}),
			});
			expect(ownerEnd.status).toBe(200);
			expect(getEndedSession?.(sessionKey)?.runtimePath).toBe("plugin");

			const unmarkedEnd = await app.request("/api/hooks/session-end", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					harness: "unknown-client",
					sessionKey,
					transcript: "user: deploy checklist",
				}),
			});

			expect(unmarkedEnd.status).toBe(200);
			expect(await unmarkedEnd.json()).toMatchObject({
				memoriesSaved: 0,
			});
			expect(getEndedSession?.(sessionKey)?.runtimePath).toBeUndefined();
		} finally {
			releaseSession?.(sessionKey);
		}
	});

	it("skips duplicate session-end calls after the owning runtime already ended", async () => {
		const sessionKey = "duplicate-session-end-after-owner";
		try {
			const first = await app.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					userMessage: "deploy checklist",
					sessionKey,
				}),
			});
			expect(first.status).toBe(200);

			const ownerEnd = await app.request("/api/hooks/session-end", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					sessionKey,
					transcript: "user: deploy checklist",
				}),
			});
			expect(ownerEnd.status).toBe(200);
			expect(getSessionPath?.(sessionKey)).toBeUndefined();
			expect(getEndedSession?.(sessionKey)?.runtimePath).toBe("plugin");

			const duplicateEnd = await app.request("/api/hooks/session-end", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "legacy",
				},
				body: JSON.stringify({
					harness: "claude-code",
					sessionKey,
					transcript: "user: deploy checklist",
				}),
			});

			expect(duplicateEnd.status).toBe(200);
			expect(await duplicateEnd.json()).toMatchObject({
				memoriesSaved: 0,
				skipped: true,
				duplicateSessionEnd: true,
				endedBy: "plugin",
			});
		} finally {
			releaseSession?.(sessionKey);
		}
	});

	it("treats project as project filtering instead of scope filtering", async () => {
		const now = new Date().toISOString();
		getSyncDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, project, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, ?, ?, ?, ?, 'test')`,
			).run("mem-proj-a", "deploy checklist for alpha", "sess-a", "default", "proj-a", now, now);
			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, project, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, ?, ?, ?, ?, 'test')`,
			).run("mem-proj-b", "deploy checklist for beta", "sess-b", "default", "proj-b", now, now);
		});

		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: "openclaw",
				query: "deploy checklist",
				project: "proj-a",
				limit: 5,
			}),
		});

		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(Array.isArray(body.results)).toBeTrue();
		expect(body.results.map((row: { id: string }) => row.id)).toContain("mem-proj-a");
		expect(body.results.map((row: { id: string }) => row.id)).not.toContain("mem-proj-b");
		expect(body.memories).toEqual(body.results);
		expect(body.count).toBe(body.results.length);
		expect(body.query).toBe("deploy checklist");
		expect(body.meta?.noHits).toBeFalse();
	}, 10_000);

	it("forwards type filtering through to hybrid recall", async () => {
		const now = new Date().toISOString();
		getSyncDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, project, created_at, updated_at, updated_by
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test')`,
			).run("mem-type-fact", "deploy release checklist", "fact", "sess-type-a", "default", "proj-type", now, now);
			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, project, created_at, updated_at, updated_by
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test')`,
			).run(
				"mem-type-decision",
				"deploy release checklist",
				"decision",
				"sess-type-b",
				"default",
				"proj-type",
				now,
				now,
			);
		});

		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: "openclaw",
				query: "deploy release checklist",
				project: "proj-type",
				type: "decision",
				limit: 5,
			}),
		});

		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(Array.isArray(body.results)).toBeTrue();
		expect(body.results.map((row: { id: string }) => row.id)).toContain("mem-type-decision");
		expect(body.results.map((row: { id: string }) => row.id)).not.toContain("mem-type-fact");
		expect(body.memories).toEqual(body.results);
		expect(body.count).toBe(body.results.length);
	});

	describe("/api/hooks/user-prompt-submit admission cap (#1059)", () => {
		it("waits for remember capacity then durably captures the memory", async () => {
			const { Hono } = await import("hono");
			const { registerMemoryRoutes } = await import("./routes/memory-routes");
			const admission = createConcurrencyAdmission(1);
			const release = await admission.acquire("local");
			if (typeof release !== "function") throw new Error("expected grant");
			const routes = new Hono();
			(await import("./middleware")).registerGlobalMiddleware(routes);
			registerMemoryRoutes(routes, { memoryCaptureAdmission: admission, fetchEmbedding: async () => null });
			let settled = false;
			const content = `Remember admission durable receipt ${crypto.randomUUID()}`;
			const request = Promise.resolve(
				routes.request("/api/memory/remember", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content, type: "fact" }),
				}),
			).then((response) => {
				settled = true;
				return response;
			});
			try {
				await new Promise((resolve) => setTimeout(resolve, 25));
				expect(settled).toBe(false);
				release();
				const response = await request;
				expect(response.status).toBe(200);
				const row = await getDbAccessor?.().withReadDbAsync((db) =>
					db.prepare("SELECT content FROM memories WHERE content = ?").get(content),
				);
				expect(row).toEqual({ content });
				expect(admission.inFlight()).toBe(0);
			} finally {
				release();
			}
		});

		it("skips prompt and stop work when cancellation races a queued grant", async () => {
			for (const [path, body, setAdmission] of [
				[
					"/api/hooks/user-prompt-submit",
					{ harness: "codex", userMessage: "hello" },
					__setPromptSubmitAdmissionForTests,
				],
				["/api/hooks/stop", { harness: "codex", sessionKey: crypto.randomUUID() }, __setStopAdmissionForTests],
			] as const) {
				const admission = createConcurrencyAdmission(1);
				const release = await admission.acquire("local");
				if (typeof release !== "function") throw new Error("expected grant");
				setAdmission(admission);
				const controller = new AbortController();
				try {
					const request = app.request(path, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
						signal: controller.signal,
					});
					await new Promise((resolve) => setTimeout(resolve, 25));
					release();
					controller.abort();
					const response = await request;
					expect(response.status).toBe(503);
					expect(await response.json()).toMatchObject({ reason: "admission" });
					expect(admission.inFlight()).toBe(0);
				} finally {
					release();
					setAdmission(null);
				}
			}
		});

		it("waits for prompt capacity then succeeds", async () => {
			const admission = createPromptSubmitAdmission(1);
			const release = await admission.acquire("local");
			if (typeof release !== "function") throw new Error("expected grant");
			__setPromptSubmitAdmissionForTests(admission);
			try {
				let settled = false;
				const request = Promise.resolve(
					app.request("/api/hooks/user-prompt-submit", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ harness: "codex", userMessage: "hello" }),
					}),
				).then((response) => {
					settled = true;
					return response;
				});
				await new Promise((resolve) => setTimeout(resolve, 25));
				expect(settled).toBe(false);
				release();
				expect((await request).status).toBe(200);
				expect(admission.inFlight()).toBe(0);
			} finally {
				release();
				__setPromptSubmitAdmissionForTests(null);
			}
		});

		it("rejects with 503 while the cap is saturated and recovers after release", async () => {
			__setPromptSubmitAdmissionForTests(createPromptSubmitAdmission(0));
			try {
				const resp = await app.request("/api/hooks/user-prompt-submit", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ harness: "codex", userMessage: "hello" }),
				});
				expect(resp.status).toBe(503);
				const body = (await resp.json()) as { error?: string };
				expect(body.error).toContain("concurrent prompt submissions");
				expect(resp.headers.get("Retry-After")).toBe("1");
				expect(body).toMatchObject({ reason: "admission" });
			} finally {
				__setPromptSubmitAdmissionForTests(null);
			}
		});
	});
});
