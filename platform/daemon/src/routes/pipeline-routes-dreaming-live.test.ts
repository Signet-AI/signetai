import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { TokenClaims } from "../auth/types";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { getDbOwnerForAccessor } from "../db-owner-runtime";
import { dreamingLiveEvents, publishDreamingAgentEvent } from "../pipeline/dreaming-live-events";
import { getSseDiagnosticsSnapshot } from "../sse-stream.js";
import {
	invalidateDreamingEpisodicTokenBacklog,
	recordDreamingEpisodicTokenBacklog,
} from "../pipeline/dreaming-token-cache";
import { registerPipelineRoutes } from "./pipeline-routes";

const originalAgentId = process.env.SIGNET_AGENT_ID;

async function waitForOwnerState(predicate: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

async function ownerStateMatchesWithin(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) return false;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	return true;
}

function createPipelineApp(): Hono {
	const app = new Hono();
	const now = Math.floor(Date.now() / 1000);
	const claims: TokenClaims = {
		sub: "dreaming-live-test-admin",
		scope: { agent: "agent-a" },
		role: "admin",
		iat: now,
		exp: now + 3600,
	};
	app.use("*", async (c, next) => {
		c.set("auth", { authenticated: true, claims });
		await next();
	});
	registerPipelineRoutes(app);
	return app;
}

describe("Dreaming live routes", () => {
	let agentsDir = "";

	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "signet-dreaming-live-route-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		initDbAccessor(join(agentsDir, "memory", "memories.db"), { agentsDir });
		process.env.SIGNET_AGENT_ID = "agent-a";
		getDbAccessor().withWriteTx((db) => {
			for (const [id, agentId, mode] of [
				["live-pass-a", "agent-a", "incremental"],
				["live-pass-b", "agent-b", "compact"],
			] as const) {
				db.prepare(
					`INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at)
					 VALUES (?, ?, ?, 'running', '2026-08-05 00:00:00', '2026-08-05 00:00:00')`,
				).run(id, agentId, mode);
			}
		});
		dreamingLiveEvents.reset();
	});

	afterEach(async () => {
		dreamingLiveEvents.reset();
		await closeDbAccessor();
		rmSync(agentsDir, { recursive: true, force: true });
		if (originalAgentId === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		else process.env.SIGNET_AGENT_ID = originalAgentId;
	});

	it("lists only the current agent's active passes and rejects another agent's stream", async () => {
		const app = createPipelineApp();

		const activeResponse = await app.request("/api/dream/passes/active");
		expect(activeResponse.status).toBe(200);
		expect(await activeResponse.json()).toMatchObject({
			agentId: "agent-a",
			items: [{ id: "live-pass-a", agentId: "agent-a", mode: "incremental", status: "running" }],
		});

		const crossAgentResponse = await app.request("/api/dream/passes/live-pass-b/events");
		expect(crossAgentResponse.status).toBe(404);
	});

	it("completes active lookup and known-pass attach beyond the original five-second client deadline", async () => {
		const previousOwnerMode = process.env.SIGNET_DB_OWNER_WORKER;
		process.env.SIGNET_DB_OWNER_WORKER = "0";
		try {
			const app = createPipelineApp();
			expect((await app.request("/api/dream/passes/active")).status).toBe(200);
			const owner = await getDbOwnerForAccessor(getDbAccessor());
			expect(owner.health().pid).not.toBeNull();
			expect(owner.health().pid).not.toBe(process.pid);
			const blocker = owner.submit(
				{ kind: "sleep", durationMs: 6_000 },
				{ operation: "dream.attach-delayed-lookup-test", lane: "maintenance", deadlineMs: 10_000 },
			);
			void blocker.result.catch(() => undefined);
			await waitForOwnerState(() => owner.health().activeJobId === blocker.job.id, "the delayed owner operation");
			const startedAt = Date.now();
			const [activeResponse, streamResponse] = await Promise.all([
				app.request("/api/dream/passes/active", { signal: AbortSignal.timeout(35_000) }),
				app.request("/api/dream/passes/live-pass-a/events", { signal: AbortSignal.timeout(35_000) }),
			]);
			expect(Date.now() - startedAt).toBeGreaterThan(5_000);
			expect(activeResponse.status).toBe(200);
			expect(streamResponse.status).toBe(200);
			await streamResponse.body?.cancel();
			await blocker.result;
		} finally {
			if (previousOwnerMode === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_WORKER");
			else process.env.SIGNET_DB_OWNER_WORKER = previousOwnerMode;
		}
	}, 15_000);

	it("cancels queued owner reads when the requesting client aborts", async () => {
		const previousOwnerMode = process.env.SIGNET_DB_OWNER_WORKER;
		process.env.SIGNET_DB_OWNER_WORKER = "0";
		try {
			const app = createPipelineApp();
			expect((await app.request("/api/dream/passes/active")).status).toBe(200);
			const owner = await getDbOwnerForAccessor(getDbAccessor());
			const blocker = owner.submit(
				{ kind: "sleep", durationMs: 4_000 },
				{ operation: "dream.attach-cancel-blocker-test", lane: "maintenance", deadlineMs: 5_000 },
			);
			void blocker.result.catch(() => undefined);
			await waitForOwnerState(() => owner.health().activeJobId === blocker.job.id, "the cancellation blocker");
			const controllers = [new AbortController(), new AbortController()];
			const paths = ["/api/dream/passes/active", "/api/dream/passes/live-pass-a/events"];
			const responses = paths.map((path, index) => {
				const controller = controllers[index];
				if (!controller) throw new Error("Missing request controller");
				return Promise.resolve(app.request(path, { signal: controller.signal })).catch(() => undefined);
			});
			await waitForOwnerState(() => owner.health().maintenanceQueuedJobs === 2, "both Dreaming reads to queue");
			for (const controller of controllers) controller.abort();
			const readsCancelled = await ownerStateMatchesWithin(() => owner.health().maintenanceQueuedJobs === 0, 2_000);
			const blockerRemainedActive = owner.health().activeJobId === blocker.job.id;
			await blocker.result;
			const outcomes = await Promise.all(responses);
			expect(readsCancelled).toBe(true);
			expect(blockerRemainedActive).toBe(true);
			expect(outcomes.map((response) => response?.status)).toEqual([499, 499]);
		} finally {
			if (previousOwnerMode === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_WORKER");
			else process.env.SIGNET_DB_OWNER_WORKER = previousOwnerMode;
		}
	}, 10_000);

	it("reads the cached backlog in the status response", async () => {
		recordDreamingEpisodicTokenBacklog("agent-a", 12345);
		const app = createPipelineApp();

		const response = await app.request("/api/dream/status");
		expect(response.status).toBe(200);
		expect((await response.json()).episodicTokensPending).toBe(12345);
		recordDreamingEpisodicTokenBacklog("agent-a", 0);
	});

	it("awaits dreaming workload diagnostics in both diagnostics routes", async () => {
		const previousOwnerMode = process.env.SIGNET_DB_OWNER_WORKER;
		process.env.SIGNET_DB_OWNER_WORKER = "1";
		try {
			const app = createPipelineApp();

			const workloadsResponse = await app.request("/api/diagnostics/workloads");
			expect(workloadsResponse.status).toBe(200);
			const workloads = (await workloadsResponse.json()) as {
				dreaming: { activePasses: number; pendingAttention: number };
			};
			expect(workloads.dreaming).toMatchObject({ activePasses: 1, pendingAttention: 0 });

			const diagnosticsResponse = await app.request("/api/diagnostics");
			expect(diagnosticsResponse.status).toBe(200);
			const diagnostics = (await diagnosticsResponse.json()) as {
				workloads: { dreaming: { activePasses: number; pendingAttention: number } };
			};
			expect(diagnostics.workloads.dreaming).toMatchObject({ activePasses: 1, pendingAttention: 0 });
		} finally {
			if (previousOwnerMode === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_WORKER");
			else process.env.SIGNET_DB_OWNER_WORKER = previousOwnerMode;
		}
	});

	it("returns null when no fresh exact backlog measurement exists", async () => {
		invalidateDreamingEpisodicTokenBacklog("agent-a");
		const app = createPipelineApp();

		const response = await app.request("/api/dream/status");
		expect(response.status).toBe(200);
		expect((await response.json()).episodicTokensPending).toBeNull();
	});

	it("measures the backlog on request instead of reporting the empty cache", async () => {
		invalidateDreamingEpisodicTokenBacklog("agent-a");
		const app = new Hono();
		registerPipelineRoutes(app);
		const pending = async (query: string) =>
			((await (await app.request(`/api/dream/status${query}`)).json()) as { episodicTokensPending: number | null })
				.episodicTokensPending;

		expect(await pending("")).toBeNull();
		expect(await pending("?measure=1")).toBe(0);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, agent_id, content, harness, created_at, updated_at, completed_at)
				 VALUES ('measured', 'agent-a', 'A settled fact about the release train.', 'pi',
				         datetime('now'), datetime('now'), datetime('now'))`,
			).run();
		});
		expect(await pending("?measure=1")).toBeGreaterThan(0);
	});

	it("emits an initial snapshot over the scoped SSE stream", async () => {
		const app = createPipelineApp();
		const response = await app.request("/api/dream/passes/live-pass-a/events");
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("SSE response did not expose a body");
		const first = await reader.read();
		await reader.cancel();
		const text = new TextDecoder().decode(first.value);
		expect(text.startsWith("event: snapshot\n")).toBe(true);
		expect(text).toContain("event: snapshot");
		expect(text).toContain('"passId":"live-pass-a"');
	});

	it("terminates a replay that exceeds the byte budget with a reconnectable overflow event", async () => {
		const previousOwnerMode = process.env.SIGNET_DB_OWNER_WORKER;
		process.env.SIGNET_DB_OWNER_WORKER = "1";
		try {
			const app = createPipelineApp();
			const before = getSseDiagnosticsSnapshot();
			dreamingLiveEvents.startPass({ passId: "live-pass-a", agentId: "agent-a", mode: "incremental" });
			for (let index = 0; index < 120; index += 1) {
				dreamingLiveEvents.publish("live-pass-a", "assistant_delta", { delta: "x".repeat(15_000) });
			}

			const request = new AbortController();
			const response = await app.request("/api/dream/passes/live-pass-a/events?after=0", {
				signal: request.signal,
			});
			expect(response.status).toBe(200);
			expect(getSseDiagnosticsSnapshot().overflowCount).toBeGreaterThan(before.overflowCount);
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Dreaming event response did not expose a body");
			let text = "";
			try {
				for (let index = 0; index < 90 && !text.includes("event: overflow"); index += 1) {
					const next = await reader.read();
					if (next.done) break;
					text += new TextDecoder().decode(next.value);
				}
				expect(text).toContain("event: snapshot");
				expect(text).toContain("event: assistant_delta");
				expect(text).toContain("event: overflow");
				expect(text).toContain('"reason":"queue_limit"');
				expect(text).toContain('"reconnect":true');
				expect(dreamingLiveEvents.getSubscriberCount("live-pass-a")).toBe(0);
				expect((await reader.read()).done).toBe(true);
			} finally {
				await reader.cancel("test complete").catch(() => undefined);
				request.abort();
			}
			expect(getSseDiagnosticsSnapshot().activeStreams).toBe(before.activeStreams);
		} finally {
			if (previousOwnerMode === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_WORKER");
			else process.env.SIGNET_DB_OWNER_WORKER = previousOwnerMode;
		}
	});

	it("streams full model event payloads for the attach audit by default", async () => {
		const app = createPipelineApp();
		dreamingLiveEvents.startPass({ passId: "live-pass-a", agentId: "agent-a", mode: "incremental" });
		publishDreamingAgentEvent(
			"live-pass-a",
			{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "search_evidence", secret: "raw-secret" },
			dreamingLiveEvents,
		);
		publishDreamingAgentEvent(
			"live-pass-a",
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "raw-reasoning" } },
			dreamingLiveEvents,
		);
		publishDreamingAgentEvent(
			"live-pass-a",
			{
				type: "message_end",
				message: { role: "assistant", content: "producer-shaped-assistant-text" },
				secret: "private-message-payload",
			},
			dreamingLiveEvents,
		);
		publishDreamingAgentEvent(
			"live-pass-a",
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "visible-assistant-output" },
			},
			dreamingLiveEvents,
		);

		const readChunks = async (response: Response, needle: string): Promise<string> => {
			const reader = response.body?.getReader();
			if (!reader) throw new Error("SSE response did not expose a body");
			let text = "";
			for (let index = 0; index < 4 && !text.includes(needle); index += 1) {
				const chunk = await reader.read();
				if (chunk.done) break;
				text += new TextDecoder().decode(chunk.value);
			}
			await reader.cancel();
			return text;
		};

		const concise = await readChunks(
			await app.request("/api/dream/passes/live-pass-a/events?after=1"),
			"event: tool_start",
		);
		const conciseReasoning = await readChunks(
			await app.request("/api/dream/passes/live-pass-a/events?after=2"),
			"event: thinking_delta",
		);
		const messagePayload = await readChunks(
			await app.request("/api/dream/passes/live-pass-a/events?after=3"),
			"event: message_end",
		);
		const visibleAssistant = await readChunks(
			await app.request("/api/dream/passes/live-pass-a/events?after=4"),
			"event: assistant_delta",
		);
		const verbose = await readChunks(
			await app.request("/api/dream/passes/live-pass-a/events?after=1&verbose=1"),
			"event: tool_start",
		);
		const verboseReasoning = await readChunks(
			await app.request("/api/dream/passes/live-pass-a/events?after=2&verbose=1"),
			"event: thinking_delta",
		);
		expect(concise).toContain("event: tool_start");
		expect(concise).toContain("raw-secret");
		expect(conciseReasoning).toContain("raw-reasoning");
		expect(messagePayload).toContain("producer-shaped-assistant-text");
		expect(messagePayload).toContain("private-message-payload");
		expect(visibleAssistant).toContain("visible-assistant-output");
		expect(verbose).toContain("raw-secret");
		expect(verboseReasoning).toContain("raw-reasoning");
	});
});
