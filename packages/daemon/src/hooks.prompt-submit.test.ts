import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalSignetPath = process.env.SIGNET_PATH;
const agentsDir = mkdtempSync(join(tmpdir(), "signet-hooks-prompt-submit-"));
const memoryDir = join(agentsDir, "memory");
const memoryDbPath = join(memoryDir, "memories.db");

mkdirSync(memoryDir, { recursive: true });
writeFileSync(memoryDbPath, "");
process.env.SIGNET_PATH = agentsDir;

const infoMock = mock(() => {});
const warnMock = mock(() => {});
const errorMock = mock(() => {});
const emptyHybridResults: Array<{ id: string; score: number; content: string; created_at: string; pinned?: boolean }> =
	[];
const hybridRecallMock = mock(async () => ({ results: emptyHybridResults }));
const emptyTemporalHits: Array<{
	id: string;
	latestAt: string;
	threadLabel: string;
	excerpt: string;
}> = [];
const searchTemporalFallbackMock = mock(() => emptyTemporalHits);
const emptyTranscriptHits: Array<{
	sessionKey: string;
	updatedAt: string;
	excerpt: string;
}> = [];
const searchTranscriptFallbackMock = mock(() => emptyTranscriptHits);

const actualMemoryConfig = await import("./memory-config");

mock.module("./logger", () => ({
	logger: {
		info: infoMock,
		warn: warnMock,
		error: errorMock,
	},
}));

mock.module("./memory-config", () => ({
	...actualMemoryConfig,
	loadMemoryConfig: () => ({
		pipelineV2: {
			predictorPipeline: { agentFeedback: false },
			continuity: { enabled: false },
			guardrails: { contextBudgetChars: 4000 },
		},
	}),
}));

mock.module("./memory-search", () => ({
	buildAgentScopeClause() {
		return { clause: "", params: [] };
	},
	hybridRecall: hybridRecallMock,
}));

mock.module("./daemon", () => ({
	getPredictorClient: () => null,
	recordPredictorLatency() {},
}));

mock.module("./embedding-fetch", () => ({
	fetchEmbedding: async () => null,
}));

mock.module("./temporal-fallback", () => ({
	searchTemporalFallback: searchTemporalFallbackMock,
}));

mock.module("./session-transcripts", () => ({
	getSessionTranscriptContent() {
		return "";
	},
	searchTranscriptFallback: searchTranscriptFallbackMock,
	upsertSessionTranscript() {},
}));

mock.module("./agent-id", () => ({
	resolveAgentId: () => "default",
	getAgentScope: () => ({
		readPolicy: "isolated",
		policyGroup: null,
	}),
}));

mock.module("./session-tracker", () => ({
	getExpiryWarning: () => null,
}));

mock.module("./continuity-state", () => ({
	clearContinuity() {},
	consumeState() {
		return null;
	},
	initContinuity() {},
	recordPrompt() {},
	recordRemember() {},
	setStructuralSnapshot() {},
	shouldCheckpoint() {
		return false;
	},
}));

const { handleUserPromptSubmit } = await import("./hooks");

function ensureMemoryDbExists(): void {
	if (!existsSync(memoryDbPath)) {
		writeFileSync(memoryDbPath, "");
	}
}

describe("handleUserPromptSubmit observability", () => {
	beforeEach(() => {
		infoMock.mockClear();
		warnMock.mockClear();
		errorMock.mockClear();
		hybridRecallMock.mockClear();
		searchTemporalFallbackMock.mockClear();
		searchTranscriptFallbackMock.mockClear();
		ensureMemoryDbExists();
	});

	afterAll(() => {
		rmSync(agentsDir, { recursive: true, force: true });
		if (originalSignetPath === undefined) {
			process.env.SIGNET_PATH = undefined;
		} else {
			process.env.SIGNET_PATH = originalSignetPath;
		}
	});

	it("logs successful no-query outcomes", async () => {
		unlinkSync(memoryDbPath);

		const result = await handleUserPromptSubmit({
			harness: "vscode-custom-agent",
			userMessage: "recall my recent project notes",
		});

		expect(result.engine).toBeUndefined();
		const submitCalls = infoMock.mock.calls.filter((call) => call[1] === "User prompt submit");
		expect(submitCalls).toHaveLength(1);
		const payload = submitCalls[0]?.[2];
		expect(payload?.engine).toBe("no-query");
		expect(payload?.memoryCount).toBe(0);
	});

	it("logs successful temporal fallback outcomes", async () => {
		searchTemporalFallbackMock.mockReturnValue([
			{
				id: "node-1",
				latestAt: "2026-03-26T20:00:00.000Z",
				threadLabel: "thread: recent work",
				excerpt: "worked on prompt-submit observability",
			},
		]);

		const result = await handleUserPromptSubmit({
			harness: "vscode-custom-agent",
			userMessage: "what did we do for prompt submit logs",
			sessionKey: "session-1",
		});

		expect(result.engine).toBe("temporal-fallback");
		const submitCalls = infoMock.mock.calls.filter((call) => call[1] === "User prompt submit");
		expect(submitCalls).toHaveLength(1);
		const payload = submitCalls[0]?.[2];
		expect(payload?.engine).toBe("temporal-fallback");
		expect(payload?.memoryCount).toBe(1);
		expect(searchTranscriptFallbackMock).not.toHaveBeenCalled();
	});

	it("logs successful transcript fallback outcomes", async () => {
		searchTemporalFallbackMock.mockReturnValue([]);
		searchTranscriptFallbackMock.mockReturnValue([
			{
				sessionKey: "session-2",
				updatedAt: "2026-03-26T20:10:00.000Z",
				excerpt: "fallback logs now appear in hooks telemetry",
			},
		]);

		const result = await handleUserPromptSubmit({
			harness: "vscode-custom-agent",
			userMessage: "show transcript fallback context",
			sessionKey: "session-2",
		});

		expect(result.engine).toBe("transcript-fallback");
		const submitCalls = infoMock.mock.calls.filter((call) => call[1] === "User prompt submit");
		expect(submitCalls).toHaveLength(1);
		const payload = submitCalls[0]?.[2];
		expect(payload?.engine).toBe("transcript-fallback");
		expect(payload?.memoryCount).toBe(1);
	});

	it("skips prompt-submit injection when top recall score is below confidence gate", async () => {
		hybridRecallMock.mockResolvedValueOnce({
			results: [
				{
					id: "mem-low",
					score: 0.69,
					content: "weakly related memory",
					created_at: "2026-03-26T20:10:00.000Z",
				},
			],
		});

		const result = await handleUserPromptSubmit({
			harness: "vscode-custom-agent",
			userMessage: "show memory confidence behavior",
			sessionKey: "session-low-confidence",
		});

		expect(result.memoryCount).toBe(0);
		expect(result.inject).toContain("Current Date & Time");
		expect(result.inject).not.toContain("[signet:recall");
		const submitCalls = infoMock.mock.calls.filter((call) => call[1] === "User prompt submit");
		expect(submitCalls).toHaveLength(1);
		const payload = submitCalls[0]?.[2];
		expect(payload?.engine).toBe("low-confidence");
	});
});
