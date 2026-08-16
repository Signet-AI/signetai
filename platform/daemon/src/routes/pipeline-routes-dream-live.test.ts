import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { TextDecoder } from "node:util";
import { type WriteDb, closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { getDreamingLiveBus } from "../pipeline";
import { registerPipelineRoutes } from "./pipeline-routes";

function seedPass(
	agentId: string,
	status: string,
	extra?: { summary?: string | null; error?: string | null },
): string {
	const id = randomUUID();
	getDbAccessor().withWriteTx((db: WriteDb) => {
		if (status === "running") {
			db.prepare(
				`INSERT INTO dreaming_passes
				 (id, agent_id, mode, status, started_at, created_at)
				 VALUES (?, ?, 'incremental', 'running',
					 strftime('%Y-%m-%d %H:%M:%f', 'now'),
					 strftime('%Y-%m-%d %H:%M:%f', 'now'))`,
			).run(id, agentId);
		} else {
			db.prepare(
				`INSERT INTO dreaming_passes
				 (id, agent_id, mode, status, started_at, completed_at, summary, error, created_at)
				 VALUES (?, ?, 'incremental', ?,
					 strftime('%Y-%m-%d %H:%M:%f', 'now'),
					 strftime('%Y-%m-%d %H:%M:%f', 'now'),
					 ?, ?,
					 strftime('%Y-%m-%d %H:%M:%f', 'now'))`,
			).run(id, agentId, status, extra?.summary ?? null, extra?.error ?? null);
		}
	});
	return id;
}

/** Parse the first SSE data frame of a stream chunk. */
function parseSseFrame(chunk: Uint8Array): Record<string, unknown> {
	const text = new TextDecoder().decode(chunk);
	const payload = text
		.split("\n\n")
		.map((frame) => frame.trim())
		.find((frame) => frame.startsWith("data: "));
	if (!payload) throw new Error(`no SSE frame in chunk: ${JSON.stringify(text)}`);
	return JSON.parse(payload.slice("data: ".length)) as Record<string, unknown>;
}

describe("Dreaming live-attach route semantics (#1601)", () => {
	let agentsDir = "";

	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "signet-dream-live-route-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		initDbAccessor(join(agentsDir, "memory", "memories.db"), { agentsDir });
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(agentsDir, { recursive: true, force: true });
	});

	it("enumerates only the requesting agent's active passes", async () => {
		const own = seedPass("agent-a", "running");
		const foreign = seedPass("agent-b", "running");
		const app = new Hono();
		registerPipelineRoutes(app);

		const response = await app.request("/api/dream/passes/active", {
			headers: { "x-signet-agent-id": "agent-a" },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			items: { passId: string; agentId: string }[];
		};
		expect(body.items.map((item) => item.passId)).toEqual([own]);
		expect(foreign).not.toEqual(own);
	});

	it("rejects attach to a pass outside the requesting agent's context", async () => {
		const foreign = seedPass("agent-b", "running");
		const app = new Hono();
		registerPipelineRoutes(app);

		const response = await app.request(`/api/dream/passes/${foreign}/live`, {
			headers: { "x-signet-agent-id": "agent-a" },
		});
		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("not in this agent's context");
	});

	it("returns settled semantics with the durable outcome for a settled pass", async () => {
		const settled = seedPass("agent-a", "completed", { summary: "route settled" });
		const app = new Hono();
		registerPipelineRoutes(app);

		const response = await app.request(`/api/dream/passes/${settled}/live`, {
			headers: { "x-signet-agent-id": "agent-a" },
		});
		expect(response.status).toBe(410);
		const body = (await response.json()) as { state: string; summary: string | null };
		expect(body.state).toBe("completed");
		expect(body.summary).toBe("route settled");
	});

	it("rejects malformed cursors before streaming", async () => {
		const passId = seedPass("agent-a", "running");
		// The cursor is validated once a live state exists for the pass.
		getDreamingLiveBus().attach(passId);
		const app = new Hono();
		registerPipelineRoutes(app);

		const response = await app.request(`/api/dream/passes/${passId}/live?cursor=not-a-cursor`, {
			headers: { "x-signet-agent-id": "agent-a" },
		});
		expect(response.status).toBe(400);
	});

	it("opens a terminal stream with a connected marker then completes and closes", async () => {
		const passId = seedPass("agent-a", "failed", { error: "route failure" });
		const bus = getDreamingLiveBus();
		bus.attach(passId);
		bus.emit(passId, {
			type: "state_transition",
			passId,
			state: "failed",
			message: "route failure",
		});

		const app = new Hono();
		registerPipelineRoutes(app);
		const response = await app.request(`/api/dream/passes/${passId}/live`, {
			headers: { "x-signet-agent-id": "agent-a" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");

		const body = response.body;
		if (!body) throw new Error("attach stream has no body");
		const reader = body.getReader();
		try {
			const first = await reader.read();
			expect(first.done).toBe(false);
			const connected = parseSseFrame(first.value!);
			expect(connected.type).toBe("connected");
			expect(connected.passId).toBe(passId);
			expect(connected.snapshot).toBeDefined();

			// Terminal streams replay the buffered terminal event before the
			// completion frame; scan forward for the completion frame.
			let complete: Record<string, unknown> | null = null;
			for (let frame = 0; frame < 8 && complete === null; frame += 1) {
				const next = await reader.read();
				if (next.done) break;
				const parsed = parseSseFrame(next.value!);
				if (parsed.type === "complete") complete = parsed;
			}
			expect(complete).not.toBeNull();
			expect(complete!.state).toBe("failed");

			const drained = await reader.read();
			expect(drained.done).toBe(true);
		} finally {
			reader.releaseLock();
		}
	});
});
