import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleUserPromptSubmit } from "./hooks";
import { SIGNET_SECRETS_PLUGIN_ID, getDefaultPluginHost, resetDefaultPluginHostForTests } from "./plugins/index";

type PromptDeps = Required<NonNullable<Parameters<typeof handleUserPromptSubmit>[1]>>;

const originalSignetPath = process.env.SIGNET_PATH;
const originalCodexNativeMemory = process.env.SIGNET_CODEX_NATIVE_MEMORY;
const originalCodexHome = process.env.CODEX_HOME;
const agentsDir = mkdtempSync(join(tmpdir(), "signet-hooks-prompt-submit-"));
const memoryDir = join(agentsDir, "memory");
const memoryDbPath = join(memoryDir, "memories.db");

mkdirSync(memoryDir, { recursive: true });
writeFileSync(memoryDbPath, "");
process.env.SIGNET_PATH = agentsDir;

const infoMock = mock((_cat: string, _msg: string, _data?: Record<string, unknown>) => {});
const warnMock = mock((..._args: unknown[]) => {});
const errorMock = mock((..._args: unknown[]) => {});
const emptyHybridResults: Array<{ id: string; score: number; content: string; created_at: string; pinned?: boolean }> =
	[];
const hybridRecallMock = mock(async (..._args: Parameters<PromptDeps["hybridRecall"]>) => ({
	results: emptyHybridResults,
}));
const fetchEmbeddingMock = mock(
	async (..._args: Parameters<PromptDeps["fetchEmbedding"]>): Promise<number[] | null> => null,
);
const emptyTemporalHits: Array<{
	id: string;
	latestAt: string;
	threadLabel: string;
	excerpt: string;
}> = [];
const searchTemporalFallbackMock = mock(() => emptyTemporalHits);

const { loadMemoryConfig: realLoadMemoryConfig } = await import("./memory-config");

function ensureMemoryDbExists(): void {
	if (!existsSync(memoryDbPath)) {
		writeFileSync(memoryDbPath, "");
	}
}

function makePendingEmbedding(): {
	readonly promise: Promise<number[] | null>;
	readonly resolve: (value: number[] | null) => void;
} {
	let resolveEmbedding: (value: number[] | null) => void = () => {};
	const promise = new Promise<number[] | null>((resolve) => {
		resolveEmbedding = resolve;
	});
	return { promise, resolve: resolveEmbedding };
}

function makeDeps(opts: { readonly agentFeedback?: boolean } = {}): PromptDeps {
	return {
		logger: {
			debug() {},
			info: infoMock,
			warn: warnMock,
			error: errorMock,
		},
		loadMemoryConfig: () => {
			const cfg = realLoadMemoryConfig(agentsDir);
			return {
				...cfg,
				pipelineV2: {
					...cfg.pipelineV2,
					feedback: {
						...cfg.pipelineV2.feedback,
						enabled: opts.agentFeedback ?? false,
					},
					continuity: {
						...cfg.pipelineV2.continuity,
						enabled: false,
					},
					guardrails: {
						...cfg.pipelineV2.guardrails,
						contextBudgetChars: 4000,
					},
				},
			};
		},
		resolveAgentId: () => "default",
		getAgentScope: () => ({
			readPolicy: "isolated" as const,
			policyGroup: null,
		}),
		hybridRecall: hybridRecallMock,
		fetchEmbedding: fetchEmbeddingMock,
		searchTemporalFallback: searchTemporalFallbackMock,
		upsertSessionTranscript() {},
		getExpiryWarning: () => null,
		recordPrompt() {},
		shouldCheckpoint() {
			return false;
		},
		consumeState() {
			return null;
		},
		queueCheckpointWrite() {},
		formatPeriodicDigest() {
			return "";
		},
		parseFeedback() {
			return null;
		},
		recordAgentFeedback() {},
		trackFtsHits() {},
	} as unknown as PromptDeps;
}

describe("handleUserPromptSubmit observability", () => {
	beforeEach(() => {
		infoMock.mockClear();
		warnMock.mockClear();
		errorMock.mockClear();
		hybridRecallMock.mockClear();
		hybridRecallMock.mockImplementation(async () => ({ results: emptyHybridResults }));
		fetchEmbeddingMock.mockClear();
		searchTemporalFallbackMock.mockClear();
		searchTemporalFallbackMock.mockImplementation(() => emptyTemporalHits);
		ensureMemoryDbExists();
		Reflect.deleteProperty(process.env, "SIGNET_CODEX_NATIVE_MEMORY");
		Reflect.deleteProperty(process.env, "CODEX_HOME");
		resetDefaultPluginHostForTests();
		getDefaultPluginHost().setEnabled(SIGNET_SECRETS_PLUGIN_ID, true);
	});

	afterAll(() => {
		rmSync(agentsDir, { recursive: true, force: true });
		if (originalSignetPath === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = originalSignetPath;
		}
		if (originalCodexNativeMemory === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_CODEX_NATIVE_MEMORY");
		} else {
			process.env.SIGNET_CODEX_NATIVE_MEMORY = originalCodexNativeMemory;
		}
		if (originalCodexHome === undefined) {
			Reflect.deleteProperty(process.env, "CODEX_HOME");
		} else {
			process.env.CODEX_HOME = originalCodexHome;
		}
	});

	it("logs successful no-query outcomes", async () => {
		const result = await handleUserPromptSubmit(
			{
				harness: "vscode-custom-agent",
				userMessage: "   ",
			},
			makeDeps(),
		);

		expect(result.engine).toBeUndefined();
		expect(result.inject).toContain("## Memory Check");
		expect(result.inject).toContain("No strong automatic memory match was injected");
		expect(result.inject).toContain("run 1-3 targeted Signet recalls before executing commands");
		expect(result.inject).toContain("## Plugin Context");
		expect(result.inject).toContain('plugin="signet.secrets"');
		expect(result.inject).toContain("prefer storing them in Signet Secrets");
		expect(result.inject).toContain("save it with /remember or memory_store");
		const submitCalls = infoMock.mock.calls.filter((call) => call[1] === "User prompt submit");
		expect(submitCalls).toHaveLength(1);
		const payload = submitCalls[0]?.[2];
		expect(payload?.engine).toBe("no-query");
		expect(payload?.memoryCount).toBe(0);
	});

	it("uses Pi-native memory tools in no-memory prompt guidance", async () => {
		const result = await handleUserPromptSubmit(
			{
				harness: "pi",
				userMessage: "   ",
			},
			makeDeps(),
		);

		expect(result.inject).toContain("No strong automatic memory match was injected");
		expect(result.inject).toContain("run 1-3 targeted Signet recalls with signet_recall");
		expect(result.inject).toContain("save it with /remember or signet_remember");
		expect(result.inject).not.toContain("memory_search");
		expect(result.inject).not.toContain("memory_store");
	});

	it("uses Codex-specific guidance when native memories are enabled", async () => {
		process.env.SIGNET_CODEX_NATIVE_MEMORY = "1";
		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "   ",
			},
			makeDeps(),
		);

		expect(result.inject).toContain("Codex native memory may already cover ordinary memory needs");
		expect(result.inject).toContain("run 1-3 targeted Signet recalls with signet_recall");
		expect(result.inject).toContain("save it with signet_save_note");
		expect(result.inject).not.toContain("memory_store");
	});

	it("filters Codex native memory rows from automatic prompt-submit injection", async () => {
		process.env.SIGNET_CODEX_NATIVE_MEMORY = "1";
		hybridRecallMock.mockImplementation(async () => ({
			results: [
				{
					id: "native-1",
					content: "Codex native memory duplicate",
					score: 0.95,
					source: "native_memory",
					source_id: "native:codex:native_memory_registry:abc123",
					type: "native_memory_registry",
					tags: "codex,native-memory,native_memory_registry",
					who: "codex",
					created_at: "2026-05-24T00:00:00.000Z",
				},
				{
					id: "native-claude",
					content: "Claude Code source-backed Codex context still matters",
					score: 0.93,
					source: "native_memory",
					source_id: "native:claude-code:native_claude_memory:def456",
					type: "native_claude_memory",
					tags: "claude-code,codex,native-memory,native_claude_memory",
					who: "claude-code",
					created_at: "2026-05-24T00:00:00.000Z",
				},
				{
					id: "decision-1",
					content: "Accepted Signet decision from another harness",
					score: 0.9,
					source: "hybrid",
					type: "decision",
					created_at: "2026-05-24T00:00:00.000Z",
				},
			],
		}));

		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "What Signet decision should I follow?",
				sessionKey: "codex-native-filter",
			},
			makeDeps(),
		);

		expect(result.memoryCount).toBe(2);
		expect(result.inject).toContain("Claude Code source-backed Codex context still matters");
		expect(result.inject).toContain("Accepted Signet decision from another harness");
		expect(result.inject).not.toContain("Codex native memory duplicate");
	});

	it("keeps native rows when Codex memories are disabled in the features table", async () => {
		const codexHome = mkdtempSync(join(tmpdir(), "signet-codex-home-"));
		try {
			mkdirSync(join(codexHome, "memories"), { recursive: true });
			writeFileSync(join(codexHome, "config.toml"), "[features]\nmemories = false\n", "utf-8");
			process.env.CODEX_HOME = codexHome;
			hybridRecallMock.mockImplementation(async () => ({
				results: [
					{
						id: "native-1",
						content: "Codex native memory should stay when Codex memory feature is off",
						score: 0.95,
						source: "native_memory",
						source_id: "native:codex:native_memory_registry:abc123",
						type: "native_memory_registry",
						tags: "codex,native-memory,native_memory_registry",
						who: "codex",
						created_at: "2026-05-24T00:00:00.000Z",
					},
				],
			}));

			const result = await handleUserPromptSubmit(
				{
					harness: "codex",
					userMessage: "What native memory should I use?",
					sessionKey: "codex-memory-feature-disabled",
				},
				makeDeps(),
			);

			expect(result.memoryCount).toBe(1);
			expect(result.inject).toContain("Codex native memory should stay when Codex memory feature is off");
		} finally {
			rmSync(codexHome, { recursive: true, force: true });
		}
	});

	it("removes Secrets prompt contribution when signet.secrets is disabled", async () => {
		getDefaultPluginHost().setEnabled(SIGNET_SECRETS_PLUGIN_ID, false);

		const result = await handleUserPromptSubmit(
			{
				harness: "vscode-custom-agent",
				userMessage: "   ",
			},
			makeDeps(),
		);

		expect(result.inject).toContain("## Memory Check");
		expect(result.inject).toContain("No strong automatic memory match was injected");
		expect(result.inject).not.toContain("## Plugin Context");
		expect(result.inject).not.toContain('plugin="signet.secrets"');
		expect(result.inject).not.toContain("prefer storing them in Signet Secrets");
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

		const result = await handleUserPromptSubmit(
			{
				harness: "vscode-custom-agent",
				userMessage: "what did we do for prompt submit logs",
				sessionKey: "session-1",
			},
			makeDeps(),
		);

		expect(result.engine).toBe("temporal-fallback");
		const submitCalls = infoMock.mock.calls.filter((call) => call[1] === "User prompt submit");
		expect(submitCalls).toHaveLength(1);
		const payload = submitCalls[0]?.[2];
		expect(payload?.engine).toBe("temporal-fallback");
		expect(payload?.memoryCount).toBe(1);
		expect(result.inject).toContain("## Memory Check");
		expect(result.inject).toContain("## Relevant Memory");
		expect(result.inject).toContain("[thread node-1]");
		expect(result.inject).toContain("Use the memories below as starting context before acting");
		expect(result.inject).toContain("run 1-3 targeted recalls with /recall or memory_search");
		expect(result.inject).not.toContain("[signet:recall");
	});

	it("does not inject transcript fallback content when structured recall misses", async () => {
		searchTemporalFallbackMock.mockReturnValue([]);

		const result = await handleUserPromptSubmit(
			{
				harness: "vscode-custom-agent",
				userMessage: "show transcript fallback context",
				sessionKey: "session-2",
			},
			makeDeps(),
		);

		const submitCalls = infoMock.mock.calls.filter((call) => call[1] === "User prompt submit");
		expect(submitCalls).toHaveLength(1);
		const payload = submitCalls[0]?.[2];
		expect(payload?.engine).not.toBe("transcript-fallback");
		expect(payload?.memoryCount).toBe(0);
		expect(result.inject).toContain("## Memory Check");
		expect(result.inject).not.toContain("## Relevant Memory");
		expect(result.inject).not.toContain("[transcript");
		expect(result.inject).toContain("save it with /remember or memory_store");
		expect(result.inject).not.toContain("[signet:recall");
	});

	it("formats successful hybrid recall as a lightweight recall block", async () => {
		hybridRecallMock.mockResolvedValueOnce({
			results: [
				{
					id: "mem-1",
					score: 0.96,
					content: "prompt submit observability now logs fallback engine transitions",
					created_at: "2026-03-26T20:10:00.000Z",
				},
				{
					id: "mem-2",
					score: 0.91,
					content: "prompt submit injects a deterministic current date header",
					created_at: "2026-03-25T10:00:00.000Z",
				},
			],
		});

		const result = await handleUserPromptSubmit(
			{
				harness: "vscode-custom-agent",
				userMessage: "show prompt submit observability behavior",
				sessionKey: "session-hybrid-brief",
			},
			makeDeps(),
		);

		expect(result.engine).toBe("hybrid");
		expect(result.memoryCount).toBe(2);
		expect(result.inject).toContain("## Memory Check");
		expect(result.inject).toContain("## Relevant Memory");
		expect(result.inject).toContain("[memory] prompt submit observability now logs fallback engine transitions");
		expect(result.inject).toContain("Use the memories below as starting context before acting");
		expect(result.inject).toContain("run 1-3 targeted recalls with /recall or memory_search");
		expect(result.inject).toContain("Ask natural questions with entity + event + timeframe when possible");
		expect(result.inject).toContain("Avoid bag-of-keywords recall queries");
		expect(result.inject).toContain("Treat graph expansion as supporting context, not proof");
		expect(result.inject).not.toContain("[signet:recall");
	});

	it("uses Pi-native memory tools when injecting prompt-submit memories", async () => {
		hybridRecallMock.mockResolvedValueOnce({
			results: [
				{
					id: "mem-pi-guidance",
					score: 0.95,
					content: "Pi prompt guidance should use native Signet tool names",
					created_at: "2026-03-26T20:10:00.000Z",
				},
			],
		});

		const result = await handleUserPromptSubmit(
			{
				harness: "pi",
				userMessage: "show pi prompt guidance behavior",
				sessionKey: "session-pi-guidance",
			},
			makeDeps(),
		);

		expect(result.engine).toBe("hybrid");
		expect(result.inject).toContain("## Relevant Memory");
		expect(result.inject).toContain("Pi prompt guidance should use native Signet tool names");
		expect(result.inject).toContain("run 1-3 targeted recalls with signet_recall");
		expect(result.inject).toContain("save it with /remember or signet_remember");
		expect(result.inject).not.toContain("memory_search");
		expect(result.inject).not.toContain("memory_store");
	});

	it("requests feedback with the namespaced MCP tool for non-Pi harnesses", async () => {
		hybridRecallMock.mockResolvedValueOnce({
			results: [
				{
					id: "mem-feedback-codex",
					score: 0.95,
					content: "feedback guidance should name the Codex MCP feedback tool",
					created_at: "2026-03-26T20:10:00.000Z",
				},
			],
		});

		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "show codex feedback guidance",
				sessionKey: "session-codex-feedback",
			},
			makeDeps({ agentFeedback: true }),
		);

		expect(result.inject).toContain("mcp__signet__memory_feedback");
		expect(result.inject).toContain('Pass session_key "session-codex-feedback"');
		expect(result.inject).not.toContain("signet_memory_feedback tool");
	});

	it("requests feedback with the Pi-native feedback tool for Pi", async () => {
		hybridRecallMock.mockResolvedValueOnce({
			results: [
				{
					id: "mem-feedback-pi",
					score: 0.95,
					content: "feedback guidance should name the Pi feedback tool",
					created_at: "2026-03-26T20:10:00.000Z",
				},
			],
		});

		const result = await handleUserPromptSubmit(
			{
				harness: "pi",
				userMessage: "show pi feedback guidance",
				sessionKey: "session-pi-feedback",
			},
			makeDeps({ agentFeedback: true }),
		);

		expect(result.inject).toContain("signet_memory_feedback");
		expect(result.inject).not.toContain("mcp__signet__memory_feedback");
		expect(result.inject).not.toContain('Pass session_key "session-pi-feedback"');
		expect(result.inject).not.toContain("memory_store");
	});

	it("uses prompt-submit embeddings when they return within the hook budget", async () => {
		fetchEmbeddingMock.mockResolvedValueOnce([0.1, 0.2, 0.3]);
		hybridRecallMock.mockImplementationOnce(async (_params, _cfg, embed) => {
			const vector = await embed("prompt submit timeout trace", {
				provider: "ollama",
				model: "nomic-embed-text",
				dimensions: 768,
				base_url: "http://localhost:11434",
			});
			return {
				results: vector
					? [
							{
								id: "mem-vector",
								score: 0.95,
								content: "prompt submit timeout trace uses fast vector context",
								created_at: "2026-03-26T20:10:00.000Z",
							},
						]
					: [],
			};
		});

		const result = await handleUserPromptSubmit(
			{
				harness: "vscode-custom-agent",
				userMessage: "prompt submit timeout trace",
				sessionKey: "session-fast-embedding",
			},
			makeDeps(),
		);

		expect(fetchEmbeddingMock).toHaveBeenCalledTimes(1);
		expect(result.memoryCount).toBe(1);
		expect(result.inject).toContain("prompt submit timeout trace uses fast vector context");
	});

	it("preserves vector prompt-submit recall for concurrent fast embeddings", async () => {
		const firstEmbedding = makePendingEmbedding();
		const secondEmbedding = makePendingEmbedding();
		fetchEmbeddingMock
			.mockImplementationOnce(async () => firstEmbedding.promise)
			.mockImplementationOnce(async () => secondEmbedding.promise);
		hybridRecallMock.mockImplementation(async (_params, _cfg, embed) => {
			const vector = await embed("prompt submit concurrent vector trace", {
				provider: "ollama",
				model: "nomic-embed-text",
				dimensions: 768,
				base_url: "http://localhost:11434",
			});
			return {
				results: vector
					? [
							{
								id: `mem-concurrent-${vector[0]}`,
								score: 0.95,
								content: `prompt submit concurrent vector recall ${vector[0]}`,
								created_at: "2026-03-26T20:10:00.000Z",
							},
						]
					: [],
			};
		});

		const first = handleUserPromptSubmit(
			{
				harness: "vscode-custom-agent",
				userMessage: "prompt submit concurrent vector trace",
				sessionKey: "session-concurrent-fast-embedding-one",
			},
			makeDeps(),
		);
		const second = handleUserPromptSubmit(
			{
				harness: "vscode-custom-agent",
				userMessage: "prompt submit concurrent vector trace",
				sessionKey: "session-concurrent-fast-embedding-two",
			},
			makeDeps(),
		);

		firstEmbedding.resolve([0.1, 0.2, 0.3]);
		secondEmbedding.resolve([0.4, 0.5, 0.6]);
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(fetchEmbeddingMock).toHaveBeenCalledTimes(2);
		expect(firstResult.memoryCount).toBe(1);
		expect(firstResult.inject).toContain("prompt submit concurrent vector recall 0.1");
		expect(secondResult.memoryCount).toBe(1);
		expect(secondResult.inject).toContain("prompt submit concurrent vector recall 0.4");
		expect(warnMock).not.toHaveBeenCalledWith(
			"hooks",
			"User prompt submit embedding already in flight, skipping vector recall",
			expect.anything(),
		);
	});

	it("bypasses prompt-submit embeddings when they exceed the hook budget", async () => {
		const pending = makePendingEmbedding();
		let signal: AbortSignal | undefined;
		fetchEmbeddingMock.mockImplementationOnce(async (_text, _cfg, opts) => {
			signal = opts?.signal;
			return pending.promise;
		});
		hybridRecallMock.mockImplementationOnce(async (_params, _cfg, embed) => {
			const vector = await embed("prompt submit timeout trace", {
				provider: "ollama",
				model: "nomic-embed-text",
				dimensions: 768,
				base_url: "http://localhost:11434",
			});
			return {
				results: vector
					? [
							{
								id: "mem-vector",
								score: 0.95,
								content: "prompt submit timeout trace should not wait forever",
								created_at: "2026-03-26T20:10:00.000Z",
							},
						]
					: [],
			};
		});

		const start = Date.now();
		const result = await handleUserPromptSubmit(
			{
				harness: "vscode-custom-agent",
				userMessage: "prompt submit timeout trace",
				sessionKey: "session-slow-embedding",
			},
			makeDeps(),
		);

		expect(Date.now() - start).toBeLessThan(1500);
		expect(fetchEmbeddingMock).toHaveBeenCalledTimes(1);
		expect(result.memoryCount).toBe(0);
		expect(result.inject).toContain("No strong automatic memory match was injected");
		expect(warnMock).toHaveBeenCalledWith(
			"hooks",
			"User prompt submit embedding timed out",
			expect.objectContaining({ timeoutMs: 1000 }),
		);
		expect(signal?.aborted).toBe(true);
		pending.resolve(null);
		await Promise.resolve();
	});

	it("uses configured prompt-submit embedding timeout", async () => {
		const pending = makePendingEmbedding();
		let signal: AbortSignal | undefined;
		fetchEmbeddingMock.mockImplementationOnce(async (_text, _cfg, opts) => {
			signal = opts?.signal;
			return pending.promise;
		});
		hybridRecallMock.mockImplementationOnce(async (_params, _cfg, embed) => {
			const vector = await embed("prompt submit configured timeout", {
				provider: "ollama",
				model: "mxbai-embed-large",
				dimensions: 1024,
				base_url: "http://localhost:11434",
			});
			return {
				results: vector
					? [{ id: "mem-vector", score: 0.95, content: "vector", created_at: "2026-03-26T20:10:00.000Z" }]
					: [],
			};
		});
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"embedding:\n  provider: ollama\n  model: mxbai-embed-large\n  dimensions: 1024\n  promptSubmitTimeoutMs: 1200\n",
		);

		try {
			const start = Date.now();
			const result = await handleUserPromptSubmit(
				{
					harness: "vscode-custom-agent",
					userMessage: "prompt submit configured timeout",
					sessionKey: "session-configured-embedding-timeout",
				},
				makeDeps(),
			);

			expect(Date.now() - start).toBeLessThan(1700);
			expect(result.memoryCount).toBe(0);
			expect(warnMock).toHaveBeenCalledWith(
				"hooks",
				"User prompt submit embedding timed out",
				expect.objectContaining({ timeoutMs: 1200 }),
			);
			expect(signal?.aborted).toBe(true);
		} finally {
			pending.resolve(null);
			writeFileSync(join(agentsDir, "agent.yaml"), "");
			await Promise.resolve();
		}
	});

	it("preserves non-vector prompt-submit recall when embeddings exceed the hook budget", async () => {
		const pending = makePendingEmbedding();
		fetchEmbeddingMock.mockImplementationOnce(async () => pending.promise);
		hybridRecallMock.mockImplementationOnce(async (_params, _cfg, embed) => {
			const vector = await embed("prompt submit timeout lexical fallback", {
				provider: "ollama",
				model: "nomic-embed-text",
				dimensions: 768,
				base_url: "http://localhost:11434",
			});
			return {
				results: vector
					? []
					: [
							{
								id: "mem-keyword",
								score: 0.91,
								content: "prompt submit timeout lexical fallback still injects keyword recall",
								created_at: "2026-03-26T20:10:00.000Z",
							},
						],
			};
		});

		const result = await handleUserPromptSubmit(
			{
				harness: "vscode-custom-agent",
				userMessage: "prompt submit timeout lexical fallback",
				sessionKey: "session-slow-embedding-keyword-fallback",
			},
			makeDeps(),
		);

		expect(fetchEmbeddingMock).toHaveBeenCalledTimes(1);
		expect(result.memoryCount).toBe(1);
		expect(result.inject).toContain("prompt submit timeout lexical fallback still injects keyword recall");
		pending.resolve(null);
		await Promise.resolve();
	});

	it("aborts timed-out prompt-submit embeddings and recovers vector recall on the next request", async () => {
		const pending = makePendingEmbedding();
		let signal: AbortSignal | undefined;
		fetchEmbeddingMock.mockImplementationOnce(async (_text, _cfg, opts) => {
			signal = opts?.signal;
			return pending.promise;
		});
		fetchEmbeddingMock.mockResolvedValueOnce([0.4, 0.5, 0.6]);
		hybridRecallMock.mockImplementation(async (_params, _cfg, embed) => {
			const vector = await embed("prompt submit timeout trace", {
				provider: "ollama",
				model: "nomic-embed-text",
				dimensions: 768,
				base_url: "http://localhost:11434",
			});
			return {
				results: vector
					? [
							{
								id: "mem-recovered-vector",
								score: 0.95,
								content: "prompt submit vector recall recovers after timed-out embedding abort",
								created_at: "2026-03-26T20:10:00.000Z",
							},
						]
					: [],
			};
		});

		const first = await handleUserPromptSubmit(
			{
				harness: "vscode-custom-agent",
				userMessage: "prompt submit timeout trace",
				sessionKey: "session-first-slow-embedding",
			},
			makeDeps(),
		);

		const second = await handleUserPromptSubmit(
			{
				harness: "vscode-custom-agent",
				userMessage: "prompt submit timeout trace",
				sessionKey: "session-second-slow-embedding",
			},
			makeDeps(),
		);

		expect(signal?.aborted).toBe(true);
		expect(fetchEmbeddingMock).toHaveBeenCalledTimes(2);
		expect(first.memoryCount).toBe(0);
		expect(second.memoryCount).toBe(1);
		expect(second.inject).toContain("prompt submit vector recall recovers after timed-out embedding abort");
		pending.resolve(null);
		await Promise.resolve();
	});

	it("rescues a later relevant memory when earlier compact candidates are irrelevant", async () => {
		hybridRecallMock.mockResolvedValueOnce({
			results: [
				{
					id: "mem-noisy",
					score: 0.99,
					content: `${"workspace migration checklist and daemon route refactor notes ".repeat(20).trim()}.`,
					created_at: "2026-03-26T20:10:00.000Z",
				},
				{
					id: "mem-proud",
					score: 0.96,
					content: "i am so proud of you for fixing recall and shipping the follow-up cleanly.",
					created_at: "2026-03-25T10:00:00.000Z",
				},
			],
		});

		writeFileSync(
			join(agentsDir, "agent.yaml"),
			["hooks:", "  userPromptSubmit:", "    maxInjectChars: 110", ""].join("\n"),
		);
		try {
			const result = await handleUserPromptSubmit(
				{
					harness: "vscode-custom-agent",
					userMessage: "im proud of you",
					sessionKey: "session-proud-rescue",
				},
				makeDeps(),
			);

			expect(result.engine).toBe("hybrid");
			expect(result.memoryCount).toBe(1);
			expect(result.inject).toContain("## Memory Check");
			expect(result.inject).toContain("## Relevant Memory");
			expect(result.inject).toContain("i am so proud of you");
			expect(result.inject).not.toContain("workspace migration checklist");
		} finally {
			writeFileSync(join(agentsDir, "agent.yaml"), "");
		}
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

		const result = await handleUserPromptSubmit(
			{
				harness: "vscode-custom-agent",
				userMessage: "show memory confidence behavior",
				sessionKey: "session-low-confidence",
			},
			makeDeps(),
		);

		expect(result.memoryCount).toBe(0);
		expect(result.inject).toContain("Current Date & Time");
		expect(result.inject).toContain("## Memory Check");
		expect(result.inject).toContain("No strong automatic memory match was injected");
		expect(result.inject).toContain("save it with /remember or memory_store");
		expect(result.inject).not.toContain("[signet:recall");
		const submitCalls = infoMock.mock.calls.filter((call) => call[1] === "User prompt submit");
		expect(submitCalls).toHaveLength(1);
		const payload = submitCalls[0]?.[2];
		expect(payload?.engine).toBe("low-confidence");
	});

	it("returns Memory Check guidance when hybrid recall fails", async () => {
		hybridRecallMock.mockRejectedValueOnce(new Error("synthetic recall failure"));

		const result = await handleUserPromptSubmit(
			{
				harness: "vscode-custom-agent",
				userMessage: "show memory failure behavior",
				sessionKey: "session-recall-failure",
			},
			makeDeps(),
		);

		expect(result.memoryCount).toBe(0);
		expect(result.inject).toContain("Current Date & Time");
		expect(result.inject).toContain("## Memory Check");
		expect(result.inject).toContain("No strong automatic memory match was injected");
		expect(result.inject).toContain("run 1-3 targeted Signet recalls before executing commands");
		expect(result.inject).toContain("save it with /remember or memory_store");
		expect(errorMock).toHaveBeenCalledTimes(1);
	});
});
