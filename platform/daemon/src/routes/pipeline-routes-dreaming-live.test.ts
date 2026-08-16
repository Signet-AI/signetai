import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { dreamingLiveEvents, publishDreamingAgentEvent } from "../pipeline/dreaming-live-events";
import { registerPipelineRoutes } from "./pipeline-routes";

const originalAgentId = process.env.SIGNET_AGENT_ID;

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

	afterEach(() => {
		dreamingLiveEvents.reset();
		closeDbAccessor();
		rmSync(agentsDir, { recursive: true, force: true });
		if (originalAgentId === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		else process.env.SIGNET_AGENT_ID = originalAgentId;
	});

	it("lists only the current agent's active passes and rejects another agent's stream", async () => {
		const app = new Hono();
		registerPipelineRoutes(app);

		const activeResponse = await app.request("/api/dream/passes/active");
		expect(activeResponse.status).toBe(200);
		expect(await activeResponse.json()).toMatchObject({
			agentId: "agent-a",
			items: [{ id: "live-pass-a", agentId: "agent-a", mode: "incremental", status: "running" }],
		});

		const crossAgentResponse = await app.request("/api/dream/passes/live-pass-b/events");
		expect(crossAgentResponse.status).toBe(404);
	});

	it("emits an initial snapshot over the scoped SSE stream", async () => {
		const app = new Hono();
		registerPipelineRoutes(app);
		const response = await app.request("/api/dream/passes/live-pass-a/events");
		expect(response.status).toBe(200);
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

	it("keeps raw payloads out of concise transport until verbose mode is requested", async () => {
		const app = new Hono();
		registerPipelineRoutes(app);
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
		const verbose = await readChunks(
			await app.request("/api/dream/passes/live-pass-a/events?after=1&verbose=1"),
			"event: tool_start",
		);
		expect(concise).toContain("event: tool_start");
		expect(concise).not.toContain("raw-secret");
		expect(conciseReasoning).not.toContain("raw-reasoning");
		expect(verbose).toContain("raw-secret");
	});
});
