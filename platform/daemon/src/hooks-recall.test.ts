import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { __setPromptSubmitAdmissionForTests, createPromptSubmitAdmission } from "./routes/hooks-routes";
import { resetSessionEndTelemetry } from "./session-end-state";
import { createTelemetryCollector, setActiveTelemetry } from "./telemetry";

let app: Hono;
let dir = "";
let prev: string | undefined;
let closeDbAccessor: (() => void) | undefined;
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
		const row = getDbAccessor?.().withReadDb(
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
		closeDbAccessor?.();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
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

		// The route should resolve without crashing (no cfg ReferenceError),
		// even if the DB isn't fully initialized — the key contract is no 500.
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.error).not.toBe("Hook execution failed");
		expect(body.meta?.noHits).toBeTrue();
		expect(body.memories).toEqual(body.results);
		expect(body.count).toBe(body.results.length);
		expect(body.message).toBe("No matching memories found.");
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
			const events = collector.query();
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
			const events = collector.query();
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
		getDbAccessor?.().withWriteTx((db) => {
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
		getDbAccessor?.().withWriteTx((db) => {
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
});

describe("/api/hooks/user-prompt-submit admission cap (#1059)", () => {
	it("acquires up to the cap, rejects past it, and re-acquires after release", () => {
		const admission = createPromptSubmitAdmission(2);
		expect(admission.acquire()).toBe(true);
		expect(admission.acquire()).toBe(true);
		expect(admission.acquire()).toBe(false);
		expect(admission.inFlight()).toBe(2);
		admission.release();
		expect(admission.inFlight()).toBe(1);
		expect(admission.acquire()).toBe(true);
		expect(admission.inFlight()).toBe(2);
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
		} finally {
			__setPromptSubmitAdmissionForTests(null);
		}
	});
});
