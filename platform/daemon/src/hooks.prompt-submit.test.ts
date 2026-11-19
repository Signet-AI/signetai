import { getSyncDbAccessor } from "../legacy-sync/db-accessor-sync";
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { formatPromptClockContext, handleSessionEnd, handleUserPromptSubmit } from "./hooks";
import { SIGNET_SECRETS_PLUGIN_ID, getDefaultPluginHost, resetDefaultPluginHostForTests } from "./plugins/index";
import { setActiveTelemetry } from "./telemetry";

type PromptDeps = Required<NonNullable<Parameters<typeof handleUserPromptSubmit>[1]>>;

const originalSignetPath = process.env.SIGNET_PATH;
const agentsDir = mkdtempSync(join(tmpdir(), "signet-hooks-prompt-submit-"));
const memoryDir = join(agentsDir, "memory");
const memoryDbPath = join(memoryDir, "memories.db");

const infoMock = mock((_cat: string, _msg: string, _data?: Record<string, unknown>) => {});
const warnMock = mock((..._args: unknown[]) => {});
const errorMock = mock((..._args: unknown[]) => {});
type RecallRow = { readonly id: string; readonly content: string; readonly score: number };
let recallRows: readonly RecallRow[] = [];
const hybridRecallMock = mock(async (..._args: Parameters<PromptDeps["hybridRecall"]>) => ({
	results: recallRows.map((row) => ({ ...row, source: "hybrid", type: "fact", pinned: false, importance: 0.8 })),
}));
const fetchEmbeddingMock = mock(
	async (..._args: Parameters<PromptDeps["fetchEmbedding"]>): ReturnType<PromptDeps["fetchEmbedding"]> => null,
);

const { loadMemoryConfig: realLoadMemoryConfig } = await import("./memory-config");

process.env.SIGNET_PATH = agentsDir;

async function resetDb(): Promise<void> {
	await closeDbAccessor();
	mkdirSync(memoryDir, { recursive: true });
	for (const file of readdirSync(memoryDir)) {
		if (file.startsWith("memories.db")) rmSync(join(memoryDir, file), { force: true });
	}
	initDbAccessor(memoryDbPath, { agentsDir });
}

function makeDeps(overrides: Partial<PromptDeps> = {}): PromptDeps {
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
					feedback: { ...cfg.pipelineV2.feedback, enabled: false },
					continuity: { ...cfg.pipelineV2.continuity, enabled: false },
					guardrails: { ...cfg.pipelineV2.guardrails, contextBudgetChars: 4000 },
				},
				embedding: { ...cfg.embedding, promptSubmitTimeoutMs: 10_000 },
			};
		},
		resolveAgentId: () => "default",
		getAgentScope: () => ({ readPolicy: "isolated" as const, policyGroup: null }),
		hybridRecall: hybridRecallMock,
		fetchEmbedding: fetchEmbeddingMock,
		async appendSessionTranscriptAsync() {},
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
		...overrides,
	} as unknown as PromptDeps;
}

function seedEntity(id: string, name: string, canonical: string, type: string, mentions = 10): void {
	getSyncDbAccessor().withWriteTx((db) => {
		const now = "2026-05-27T00:00:00.000Z";
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'default', ?, ?, ?)`,
		).run(id, name, canonical, type, mentions, now, now);
	});
}

function seedEntityContext(): void {
	seedEntity("entity-signet", "Signet", "signet", "project");
	getSyncDbAccessor().withWriteTx((db) => {
		const now = "2026-05-27T00:00:00.000Z";
		db.prepare(
			`INSERT INTO entity_aliases
			 (id, entity_id, agent_id, alias, canonical_alias, confidence, source, status, created_at, updated_at)
			 VALUES (?, ?, 'default', ?, ?, 1, 'test', 'active', ?, ?)`,
		).run("alias-signetai", "entity-signet", "SignetAI", "signetai", now, now);
	});
}

const SIGNET_RECALL: readonly RecallRow[] = [
	{ id: "mem-architecture", content: "Prompt context comes from entity-gated recall.", score: 0.92 },
	{ id: "mem-weak", content: "Weakly related marketing note.", score: 0.4 },
];

async function submit(userMessage: string, sessionKey: string, deps = makeDeps()) {
	return await handleUserPromptSubmit({ harness: "codex", userMessage, sessionKey }, deps);
}

describe("handleUserPromptSubmit entity-gated recall", () => {
	it("formats an explicit offset and deterministic UTC fallback for the prompt clock", () => {
		const instant = new Date("2026-08-16T20:35:00.000Z");
		expect(formatPromptClockContext(instant, "America/Denver")).toBe(
			"Current date/time: 2026-08-16T14:35:00-06:00 (America/Denver)",
		);
		expect(formatPromptClockContext(instant, "invalid/timezone")).toBe(
			"Current date/time: 2026-08-16T20:35:00+00:00 (UTC)",
		);
	});

	beforeEach(async () => {
		infoMock.mockClear();
		warnMock.mockClear();
		errorMock.mockClear();
		hybridRecallMock.mockClear();
		fetchEmbeddingMock.mockClear();
		recallRows = SIGNET_RECALL;
		resetDefaultPluginHostForTests();
		getDefaultPluginHost().setEnabled(SIGNET_SECRETS_PLUGIN_ID, true);
		await resetDb();
	});

	afterAll(async () => {
		await closeDbAccessor();
		rmSync(agentsDir, { recursive: true, force: true });
		if (originalSignetPath === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = originalSignetPath;
		}
	});

	it("computes one clock per request without changing the memory context hash", async () => {
		seedEntityContext();
		let now = Date.parse("2026-08-16T20:35:00.000Z");
		const nowMock = mock(() => now);
		const deps = makeDeps({ now: nowMock });

		const first = await submit("Tell me about Signet architecture", "clock-stability-a", deps);
		now = Date.parse("2026-08-16T20:36:00.000Z");
		const second = await submit("Tell me about Signet architecture", "clock-stability-b", deps);

		expect(nowMock).toHaveBeenCalledTimes(2);
		expect(first.clockContext).not.toBe(second.clockContext);
		expect(first.inject).toBe(second.inject);
		expect(first.contextHash).toBe(second.contextHash);
		expect(first.clockContext).not.toContain("<signet-memory-context>");
	});

	it("skips low-signal recall while preserving stable prompt context and telemetry reason", async () => {
		seedEntityContext();
		const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
		setActiveTelemetry({
			record(event: string, properties: Record<string, unknown>) {
				events.push({ event, properties: { ...properties } });
			},
		} as never);

		try {
			for (const [index, userMessage] of ["hi", "thanks", "okay"].entries()) {
				const result = await submit(userMessage, `session-low-signal-${index}`);
				expect(result).toMatchObject({ memoryCount: 0, engine: "low-signal" });
				expect(result.inject).toBe("");
				expect(result.dynamicContext).toBe("");
			}
		} finally {
			setActiveTelemetry(undefined);
		}

		expect(hybridRecallMock).not.toHaveBeenCalled();
		expect(fetchEmbeddingMock).not.toHaveBeenCalled();
		expect(infoMock.mock.calls.at(-1)?.[2]?.engine).toBe("low-signal");
		expect(events).toHaveLength(6);
		expect(events.filter((event) => event.event === "recall.outcome").map((event) => event.properties)).toEqual(
			Array.from({ length: 3 }, () => ({
				surface: "prompt_injection",
				resultState: "empty",
				deliveryState: "not_delivered",
				results: 0,
				reason: "skipped_low_signal",
			})),
		);
	});

	it("does not classify short substantive identifiers or corrections as low-signal", async () => {
		seedEntityContext();
		for (const [index, userMessage] of ["k8s", "yolo", "Signet", "No"].entries()) {
			const result = await submit(userMessage, `session-substantive-${index}`);
			expect(result.engine).not.toBe("low-signal");
		}
	});

	it("keeps prompt bookkeeping ahead of the low-signal gate", async () => {
		seedEntityContext();
		const recordPrompt = mock((_sessionKey: string | undefined, _queryTerms?: string, _snippet?: string) => {});
		const appendSessionTranscriptAsync = mock(
			async (_input: {
				readonly sessionKey: string;
				readonly agentId: string;
				readonly harness: string;
				readonly project: string | null;
				readonly transcript: string;
			}) => {},
		);

		const result = await handleUserPromptSubmit(
			{
				harness: "codex",
				userMessage: "hi",
				sessionKey: "session-bookkeeping",
				project: "/repo",
				transcript: "User: hi",
			},
			makeDeps({ recordPrompt, appendSessionTranscriptAsync }),
		);

		expect(recordPrompt).toHaveBeenCalledWith("session-bookkeeping", undefined, "hi");
		expect(appendSessionTranscriptAsync).toHaveBeenCalledTimes(1);
		const appended = appendSessionTranscriptAsync.mock.calls[0]?.[0];
		expect(appended).toMatchObject({
			sessionKey: "session-bookkeeping",
			agentId: "default",
			harness: "codex",
			project: "/repo",
		});
		expect(appended?.transcript).toBe("User: hi");
		expect(result.inject).toBe("");
	});

	it("does not run recall when no known entity or alias is mentioned", async () => {
		seedEntityContext();

		const result = await submit("what should we do about unrelated routing", "session-no-entity");

		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "no-entity" });
		expect(result.clockContext).toMatch(/^Current date\/time: .*[+-]\d{2}:\d{2} \(.+\)$/);
		expect(hybridRecallMock).not.toHaveBeenCalled();
	});

	it("runs the canonical recall after an entity hit and injects only results above minScore", async () => {
		seedEntityContext();

		const result = await submit("How should Signet architecture handle prompt context?", "session-entity");

		expect(hybridRecallMock).toHaveBeenCalledTimes(1);
		const [params] = hybridRecallMock.mock.calls[0] ?? [];
		expect(params).toMatchObject({
			query: "How should Signet architecture handle prompt context?",
			limit: 10,
			agentId: "default",
			readPolicy: "isolated",
			sessionKey: "session-entity\0codex",
			recallSurface: "api.hooks.user-prompt-submit",
			recallMode: "automatic",
			claimRecallResults: false,
			trackRecallAccess: false,
			transcriptEvidence: false,
		});
		expect(params?.project).toBeUndefined();
		expect(hybridRecallMock.mock.calls[0]?.[3]?.signal).toBeInstanceOf(AbortSignal);
		expect(result).toMatchObject({ engine: "entity-recall", memoryCount: 1 });
		expect(result.inject).toContain("## Relevant Memory: Signet");
		expect(result.inject).toContain("- Prompt context comes from entity-gated recall. (mem-architecture)");
		expect(result.inject).not.toContain("Weakly related marketing note.");
	});

	it("matches the sender in a provenance block but keeps it out of the recall query", async () => {
		seedEntityContext();
		const userMessage = [
			"which still is best for the thumbnail?",
			"",
			"[Discord sender provenance]",
			'{"user_id":"903009565744971816","display_name":"Signet"}',
			"[/Discord sender provenance]",
		].join("\n");

		const result = await submit(userMessage, "session-provenance");

		expect(hybridRecallMock).toHaveBeenCalledTimes(1);
		expect(hybridRecallMock.mock.calls[0]?.[0]?.query).toBe("which still is best for the thumbnail?");
		expect(result.inject).toContain("## Relevant Memory: Signet");
	});

	it("delivers a recalled memory once per session", async () => {
		seedEntityContext();

		const first = await submit("How should Signet architecture handle prompt context?", "session-dedupe");
		const second = await submit("What else about Signet prompt context?", "session-dedupe");
		const otherSession = await submit("What else about Signet prompt context?", "session-dedupe-other");

		expect(first.inject).toContain("Prompt context comes from entity-gated recall.");
		expect(second).toMatchObject({ inject: "", memoryCount: 0, engine: "deduped" });
		expect(otherSession.inject).toContain("Prompt context comes from entity-gated recall.");
	});

	it("injects nothing when the delivery claim cannot be recorded", async () => {
		seedEntityContext();
		getSyncDbAccessor().withWriteTx((db) => {
			db.exec("DROP TABLE session_recall_events");
		});

		const first = await submit("How should Signet architecture handle prompt context?", "session-claim-down");
		const second = await submit("How should Signet architecture handle prompt context?", "session-claim-down");

		for (const result of [first, second]) {
			expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "claim-failed" });
		}
	});

	it("keeps the rendered block, header included, within maxInjectChars", async () => {
		seedEntityContext();
		recallRows = ["alpha", "beta", "gamma"].map((name) => ({
			id: `mem-${name}`,
			content: `${name} Signet architecture detail`.padEnd(210, " x"),
			score: 0.9,
		}));

		const result = await submit("How should Signet architecture handle prompt context?", "session-budget");

		expect(result.memoryCount).toBe(1);
		expect(result.inject.length).toBeLessThanOrEqual(500);
	});

	it("does not claim or inject when the deadline expires while the claim is queued", async () => {
		seedEntityContext();
		const busyWrites: Promise<void>[] = [];
		let recallStarted = 0;
		const deps = makeDeps({
			loadMemoryConfig: () => {
				const cfg = realLoadMemoryConfig(agentsDir);
				return { ...cfg, embedding: { ...cfg.embedding, promptSubmitTimeoutMs: 30 } };
			},
			matchPromptEntities: async () => [
				{
					entityId: "entity-signet",
					entityName: "Signet",
					entityType: "project",
					matchedText: "signet",
					matchSource: "name",
					mentions: 10,
				},
			],
			hybridRecall: (async () => {
				recallStarted = performance.now();
				for (let index = 0; index < 40; index += 1) {
					busyWrites.push(
						getDbAccessor().withWriteTxAsync(() => {
							const until = performance.now() + 5;
							while (performance.now() < until) {}
						}),
					);
				}
				return {
					results: SIGNET_RECALL.map((row) => ({
						...row,
						source: "hybrid",
						type: "fact",
						pinned: false,
						importance: 0.8,
					})),
				};
			}) as unknown as PromptDeps["hybridRecall"],
		});

		const result = await submit(
			"How should Signet architecture handle prompt context?",
			"session-claim-deadline",
			deps,
		);
		const elapsed = performance.now() - recallStarted;
		await Promise.allSettled(busyWrites);

		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "provider-timeout" });
		expect(elapsed).toBeLessThan(150);
		expect(warnMock.mock.calls.some((call) => call[1] === "Prompt-submit recall claim failed; nothing injected")).toBe(
			true,
		);
		const claims = getSyncDbAccessor().withReadDb((db) =>
			db
				.prepare("SELECT COUNT(*) AS count FROM session_recall_events WHERE session_key = ?")
				.get("session-claim-deadline"),
		);
		expect(claims).toEqual({ count: 0 });
	});

	it("rolls back a claim that acquires the write lock after the deadline", async () => {
		seedEntityContext();
		const holder = Bun.spawn(
			[
				process.execPath,
				"-e",
				`const { Database } = require("bun:sqlite");
const db = new Database(${JSON.stringify(memoryDbPath)});
db.exec("PRAGMA busy_timeout = 5000");
for await (const _ of Bun.stdin.stream()) {
	db.exec("BEGIN IMMEDIATE");
	console.log("locked");
	Bun.sleepSync(400);
	db.exec("COMMIT");
	break;
}`,
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "inherit" },
		);
		const lines = holder.stdout.getReader();
		const deps = makeDeps({
			loadMemoryConfig: () => {
				const cfg = realLoadMemoryConfig(agentsDir);
				return { ...cfg, embedding: { ...cfg.embedding, promptSubmitTimeoutMs: 150 } };
			},
			hybridRecall: (async () => {
				holder.stdin.write("lock\n");
				holder.stdin.flush();
				await lines.read();
				return {
					results: SIGNET_RECALL.map((row) => ({
						...row,
						source: "hybrid",
						type: "fact",
						pinned: false,
						importance: 0.8,
					})),
				};
			}) as unknown as PromptDeps["hybridRecall"],
		});

		const result = await submit("How should Signet architecture handle prompt context?", "session-late-lock", deps);
		await holder.exited;

		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "provider-timeout" });
		const claims = getSyncDbAccessor().withReadDb((db) =>
			db.prepare("SELECT COUNT(*) AS count FROM session_recall_events WHERE session_key = ?").get("session-late-lock"),
		);
		expect(claims).toEqual({ count: 0 });
	});

	it("reports degraded recall instead of a plain miss", async () => {
		seedEntityContext();
		const deps = makeDeps({
			hybridRecall: (async () => ({
				results: [],
				meta: { partial: true, degradation: "fts_incomplete" },
			})) as unknown as PromptDeps["hybridRecall"],
		});

		const result = await submit("How should Signet architecture handle prompt context?", "session-degraded", deps);

		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "no-recall-hit" });
		expect(result.warnings?.some((warning) => warning.includes("fts_incomplete"))).toBe(true);
	});

	it("reports candidates recall suppressed as already delivered", async () => {
		seedEntityContext();
		const deps = makeDeps({
			hybridRecall: (async () => ({
				results: [],
				meta: { dedupe: { enabled: true, contextEpoch: 1, suppressed: 1, repeatedReturned: 0 } },
			})) as unknown as PromptDeps["hybridRecall"],
		});

		const result = await submit("How should Signet architecture handle prompt context?", "session-suppressed", deps);

		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "deduped" });
	});

	it("injects source memories instead of an unattributed model summary", async () => {
		seedEntityContext();
		const deps = makeDeps({
			hybridRecall: (async () => ({
				results: [
					{
						id: "summary:0123456789ab",
						content: "[model summary, verify against source memories] Signet uses entity-gated recall.",
						score: 0.95,
						source: "llm_summary",
						type: "semantic",
						pinned: false,
						importance: 0.9,
						supplementary: true,
					},
					...SIGNET_RECALL.map((row) => ({ ...row, source: "hybrid", type: "fact", pinned: false, importance: 0.8 })),
				],
			})) as unknown as PromptDeps["hybridRecall"],
		});

		const result = await submit("How should Signet architecture handle prompt context?", "session-summary", deps);

		expect(result.engine).toBe("entity-recall");
		expect(result.inject).toContain("Prompt context comes from entity-gated recall.");
		expect(result.inject).not.toContain("summary:");
		expect(result.inject).not.toContain("model summary");
	});

	it("delivers a memory again after the session context is cleared", async () => {
		seedEntityContext();
		const prompt = "How should Signet architecture handle prompt context?";

		expect(await submit(prompt, "session-cleared")).toMatchObject({ engine: "entity-recall", memoryCount: 1 });
		expect(await submit(prompt, "session-cleared")).toMatchObject({ engine: "deduped", memoryCount: 0 });
		await handleSessionEnd({ harness: "codex", sessionKey: "session-cleared", cwd: "/repo", reason: "clear" });

		expect(await submit(prompt, "session-cleared")).toMatchObject({ engine: "entity-recall", memoryCount: 1 });
	});

	it("injects nothing without a session to claim the delivery in", async () => {
		seedEntityContext();

		const first = await submit("How should Signet architecture handle prompt context?", " ");
		const second = await submit("How should Signet architecture handle prompt context?", " ");

		for (const result of [first, second]) {
			expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "no-session" });
		}
	});

	it("stays silent when the entity is known but no recall result clears the gate", async () => {
		seedEntityContext();
		recallRows = [{ id: "mem-weak", content: "Weakly related marketing note.", score: 0.4 }];

		const result = await submit("What about Signet billing?", "session-no-recall-hit");

		expect(hybridRecallMock).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "no-recall-hit" });
	});

	it("never attaches plugin prompt contributions to a prompt", async () => {
		seedEntityContext();

		const result = await submit("How should Signet architecture handle prompt context?", "session-plugins");

		expect(result.engine).toBe("entity-recall");
		expect(result.inject).not.toContain("signet-plugin-context");
		expect(result.inject).not.toContain("Signet Secrets");
	});

	it("resolves active aliases to the canonical entity", async () => {
		seedEntityContext();

		const result = await submit("Should SignetAI architecture use current views?", "session-alias");

		expect(hybridRecallMock).toHaveBeenCalledTimes(1);
		expect(result.inject).toContain("## Relevant Memory: Signet");
	});

	it("matches possessive and missing-apostrophe possessive mentions", async () => {
		seedEntityContext();
		seedEntity("entity-signet-possessive", "Signet's", "signet's", "tool", 2);

		const possessive = await submit("What are Signet's favorite pens?", "session-possessive");
		const bare = await submit("What are Signets favorite pens?", "session-bare-possessive");

		expect(possessive.inject).toContain("## Relevant Memory: Signet\n");
		expect(bare.inject).toContain("## Relevant Memory: Signet\n");
	});

	it("ignores generic plural nouns, disallowed types, role labels, and short names", async () => {
		seedEntity("entity-project", "Project", "project", "project", 50);
		seedEntity("entity-agents", "Agents", "agents", "concept", 200);
		seedEntity("entity-connector", "Claude Code connector", "claude code connector", "tool", 80);
		seedEntity("entity-user-role", "User", "user", "person", 2000);
		seedEntity("entity-ai", "AI", "ai", "project", 10);

		for (const [index, userMessage] of [
			"projects roadmap",
			"agents are useful",
			"Claude Code connector setup",
			"tell the user about prompt context",
			"Can AI architecture be summarized?",
		].entries()) {
			const result = await submit(userMessage, `session-ignored-${index}`);
			expect(result).toMatchObject({ inject: "", memoryCount: 0, engine: "no-entity" });
		}
		expect(hybridRecallMock).not.toHaveBeenCalled();
	});

	it("prefers the longest non-overlapping entity span and ignores weak collisions", async () => {
		for (const [id, name, canonical, mentions] of [
			["entity-claude-code-connector", "Claude Code connector", "claude code connector", 8],
			["entity-claude-code", "Claude Code", "claude code", 135],
			["entity-claude", "Claude", "claude", 113],
			["entity-connector", "connector", "connector", 5],
		] as const) {
			seedEntity(id, name, canonical, "project", mentions);
		}

		const result = await submit("Claude Code connector setup", "session-longest-span");

		expect(result.inject).toContain("## Relevant Memory: Claude Code connector\n");
	});
});
