import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createAgentMessage, resetCrossAgentStateForTest } from "./cross-agent";
import { resetDirectMessageWakeStateForTest, waitForDirectMessageWake } from "./cross-agent-wake";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { handleCheckpointExtract } from "./hooks";
import { writeCompactionArtifact, writeSummaryArtifact, writeTranscriptArtifact } from "./memory-lineage";
import * as lifecycle from "./session-transcript-lifecycle";
import { deleteSessionTranscript, updateTranscriptLifecycle } from "./session-transcript-lifecycle";
import { getStoredSessionTranscriptInfoAsync, upsertSessionTranscriptAsync } from "./session-transcripts";
import { getEndedSession, releaseSession } from "./session-tracker";
import * as capture from "./transcript-capture";
import { TranscriptLockTimeoutError } from "./transcript-jsonl";

let root = "";
let app: Hono;
const UNSCOPED_CHECKPOINT = { project: null, projectScoped: false };

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "hooks-transcript-review-"));
	mkdirSync(join(root, "memory"), { recursive: true });
	writeFileSync(
		join(root, "agent.yaml"),
		"embedding:\n  provider: none\nsearch:\n  rehearsal_enabled: false\nmemory:\n  pipelineV2:\n    enabled: true\n",
	);
	process.env.SIGNET_PATH = root;
	initDbAccessor(join(root, "memory", "memories.db"));
	app = (await import("./daemon")).app;
});

afterAll(async () => {
	await new Promise((resolve) => setTimeout(resolve, 50));
	await closeDbAccessor();
	rmSync(root, { recursive: true, force: true });
});

async function deleteCompletely(agentId: string, sessionKey: string): Promise<void> {
	await upsertSessionTranscriptAsync(
		sessionKey,
		"User: doomed turn",
		"claude-code",
		null,
		agentId,
		"2020-01-01T00:00:00.000Z",
	);
	let result = await deleteSessionTranscript({ agentId, sessionKey, hard: false, changedBy: "test" });
	for (let i = 0; result.status === "pending" && i < 20; i++)
		result = await deleteSessionTranscript({ agentId, sessionKey, hard: false, changedBy: "test" });
	expect(result.status).toBe("complete");
}

function memoryFiles(): readonly string[] {
	return readdirSync(join(root, "memory")).filter((name) => name.endsWith(".md"));
}

function post(path: string, body: Record<string, unknown>): Promise<Response> {
	return app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("H: artifact files follow transcript admission", () => {
	const artifact = (sessionKey: string) => ({
		agentId: "default",
		sessionId: sessionKey,
		sessionKey,
		project: null,
		harness: "claude-code",
		capturedAt: "2019-01-01T00:00:00.000Z",
		startedAt: null,
		endedAt: null,
	});

	it("writes no compaction, summary or transcript file for a deleted session", async () => {
		await deleteCompletely("default", "h-deleted");
		const before = memoryFiles();
		await expect(writeCompactionArtifact({ ...artifact("h-deleted"), summary: "compacted deleted" })).rejects.toThrow();
		await expect(writeSummaryArtifact({ ...artifact("h-deleted"), summary: "summary deleted" })).rejects.toThrow();
		await expect(writeTranscriptArtifact({ ...artifact("h-deleted"), transcript: "User: deleted" })).rejects.toThrow();
		expect(memoryFiles()).toEqual(before);
	});

	it("still writes artifacts for an unrelated session", async () => {
		await writeCompactionArtifact({ ...artifact("h-live"), summary: "compacted live" });
		expect(memoryFiles().some((name) => name.endsWith("--compaction.md"))).toBe(true);
	});

	it("stores the checkpoint transcript of a new generation", async () => {
		await deleteCompletely("default", "h-checkpoint");
		await updateTranscriptLifecycle({ agentId: "default", sessionKey: "h-checkpoint", action: "start" });
		await handleCheckpointExtract(
			{
				agentId: "default",
				sessionKey: "h-checkpoint",
				harness: "claude-code",
				transcript: "User: fresh question\nAssistant: fresh answer",
			},
			UNSCOPED_CHECKPOINT,
		);
		const stored = await getStoredSessionTranscriptInfoAsync("h-checkpoint", "default");
		expect(stored?.content).toContain("fresh answer");
	});
});

describe("I: a wake that lands during session end keeps the session open", () => {
	it("does not mark the session ended when a wake arrives during the lifecycle await", async () => {
		const sessionKey = "i-wake-race";
		const start = await post("/api/hooks/session-start", { harness: "claude-code", sessionKey });
		expect(start.status).toBe(200);
		resetDirectMessageWakeStateForTest();
		resetCrossAgentStateForTest();
		const spy = spyOn(lifecycle, "updateTranscriptLifecycle").mockImplementation(async (input) => {
			if (input.action === "end") {
				createAgentMessage({ fromAgentId: "sender", toAgentId: "default", content: "wake up" });
				const woke = await waitForDirectMessageWake({
					agentId: "default",
					sessionKey,
					harness: "claude-code",
					waitMs: 0,
				});
				expect(woke.wake).toBe(true);
			}
			return { generation: 0, bypassed: false };
		});
		try {
			const end = await post("/api/hooks/session-end", { harness: "claude-code", sessionKey });
			expect(end.status).toBe(200);
			expect(getEndedSession(sessionKey, "default")).toBeUndefined();
		} finally {
			spy.mockRestore();
			releaseSession(sessionKey, "default");
			resetDirectMessageWakeStateForTest();
			resetCrossAgentStateForTest();
		}
	});
});

describe("J: a transcript lock timeout is retryable write pressure", () => {
	it("answers session-end with 503 and Retry-After instead of a queued:false 200", async () => {
		const spy = spyOn(capture, "appendCanonicalLiveAssistantTurn").mockRejectedValue(new TranscriptLockTimeoutError());
		try {
			const response = await post("/api/hooks/session-end", {
				harness: "claude-code",
				sessionKey: "j-lock-timeout",
				lastAssistantMessage: "final words",
			});
			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("1");
			expect(await response.json()).toMatchObject({ retryable: true });
		} finally {
			spy.mockRestore();
			releaseSession("j-lock-timeout", "default");
		}
	});
});
