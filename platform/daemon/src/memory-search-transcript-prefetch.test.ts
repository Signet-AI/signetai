import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import type { DbOwnerJobHandle, DbOwnerRequest, DbOwnerSubmitOptions } from "./db-owner-client";
import { getDbOwner } from "./db-owner-runtime";
import { logger } from "./logger";
import { loadMemoryConfig } from "./memory-config";
import { TRANSCRIPT_PAGE_BYTES, hybridRecall, prefetchTranscriptEvidence } from "./memory-search";

describe("transcript evidence prefetch owner scheduling", () => {
	let directory = "";
	let previousPath: string | undefined;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "signet-transcript-prefetch-"));
		mkdirSync(join(directory, "memory"));
		writeFileSync(join(directory, "agent.yaml"), "name: TranscriptPrefetchTest\n");
		previousPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = directory;
		initDbAccessor(join(directory, "memory", "memories.db"));
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts (
					agent_id, source_path, source_sha256, source_kind, session_id, session_token,
					harness, captured_at, content, updated_at, is_deleted
				) VALUES ('agent-a', 'transcript.jsonl', 'prefetch-fixture', 'transcript', 'session-a',
					'token-a', 'claude-code', datetime('now'), ?, datetime('now'), 0)`,
			).run("user: Speyer tourism board phone number? assistant: +49 6232 142.");
		});
	});

	afterEach(async () => {
		await closeDbAccessor();
		if (previousPath === undefined) delete process.env.SIGNET_PATH;
		else process.env.SIGNET_PATH = previousPath;
		rmSync(directory, { recursive: true, force: true });
	});

	it("submits speculative metadata and content reads at maintenance priority", async () => {
		const owner = await getDbOwner();
		const submit = owner.submit.bind(owner);
		const submissions: DbOwnerSubmitOptions[] = [];
		owner.submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
			submissions.push(options);
			return submit<Result>(request, options);
		};
		try {
			const prefetch = await prefetchTranscriptEvidence("agent-a", undefined, {}, "Speyer tourism", 1, 3);
			expect(prefetch).not.toBeNull();
			expect(prefetch && [...prefetch.results.values()][0]?.content).toContain("+49 6232 142");
			expect(submissions.map((options) => [options.operation, options.workloadClass])).toEqual([
				["memory-search.transcript-evidence", "maintenance"],
				["memory-search.transcript-evidence.content", "maintenance"],
			]);
		} finally {
			owner.submit = submit;
		}
	});

	it.each(["signal", "callback"])("does not submit prefetch reads when already cancelled through %s", async (kind) => {
		const cancellation = new AbortController();
		cancellation.abort(new Error("recall abandoned"));
		const execution =
			kind === "signal"
				? { signal: cancellation.signal }
				: {
						checkCancelled: () => {
							throw new Error("recall abandoned");
						},
					};
		const owner = await getDbOwner();
		const submit = spyOn(owner, "submit");
		try {
			await expect(
				prefetchTranscriptEvidence("agent-a", undefined, {}, "Speyer tourism", 1, 3, undefined, execution),
			).rejects.toThrow("recall abandoned");
			expect(submit).not.toHaveBeenCalled();
		} finally {
			submit.mockRestore();
		}
	});

	it.each(["metadata", "page", "artifact"])(
		"stops transcript reads after recall cancellation during %s",
		async (stage) => {
			await getDbAccessor().withWriteTxAsync((db) => {
				db.prepare(
					`INSERT INTO memory_artifacts (
					agent_id, source_path, source_sha256, source_kind, session_id, session_token,
					harness, captured_at, content, updated_at, is_deleted
				) VALUES ('agent-a', 'second.jsonl', 'second-fixture', 'transcript', 'session-b',
					'token-b', 'claude-code', datetime('now'), ?, datetime('now'), 0)`,
				).run("user: Speyer tourism board phone number? assistant: +49 6232 143.");
				if (stage === "page") {
					db.prepare("UPDATE memory_artifacts SET content = content || ?").run("x".repeat(TRANSCRIPT_PAGE_BYTES * 2));
				}
			});
			const cancellation = new AbortController();
			const owner = await getDbOwner();
			const submit = owner.submit.bind(owner);
			const reads: DbOwnerSubmitOptions[] = [];
			owner.submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
				const handle = submit<Result>(request, options);
				if (!options.operation.startsWith("memory-search.transcript-evidence")) return handle;
				reads.push(options);
				return {
					...handle,
					result: handle.result.then((result) => {
						if (
							(stage === "metadata" && options.operation === "memory-search.transcript-evidence") ||
							(stage !== "metadata" && options.operation === "memory-search.transcript-evidence.content")
						)
							cancellation.abort(new Error("recall abandoned"));
						return result;
					}),
				};
			};
			try {
				const raw = loadMemoryConfig(directory);
				await expect(
					hybridRecall(
						{
							query: "Speyer tourism board phone number",
							limit: 3,
							agentId: "agent-a",
							readPolicy: "isolated",
							trackRecallAccess: false,
							claimRecallResults: false,
						},
						{
							...raw,
							search: { ...raw.search, rehearsal_enabled: false, transcript_evidence_limit: 1 },
							pipelineV2: {
								...raw.pipelineV2,
								graph: { ...raw.pipelineV2.graph, enabled: false },
								reranker: { ...raw.pipelineV2.reranker, enabled: false },
							},
						},
						async () => null,
						{ signal: cancellation.signal },
					),
				).rejects.toThrow("recall abandoned");
				expect(cancellation.signal.aborted).toBe(true);
				expect(reads.map((options) => [options.operation, options.workloadClass])).toEqual([
					["memory-search.transcript-evidence", "maintenance"],
					...(stage === "metadata" ? [] : [["memory-search.transcript-evidence.content", "maintenance"]]),
				]);
			} finally {
				owner.submit = submit;
			}
		},
	);

	it.each([
		["signal", "metadata"],
		["callback", "metadata"],
		["signal", "validation"],
		["callback", "validation"],
	])("does not claim or track results when transcript cancellation uses %s during %s", async (kind, stage) => {
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				`INSERT INTO memories (id, content, type, agent_id, created_at, updated_at, updated_by)
				 VALUES ('cancelled-memory', 'Speyer tourism board phone number', 'fact', 'agent-a', datetime('now'), datetime('now'), 'test')`,
			).run();
		});
		const cancellation = new AbortController();
		let cancelled = false;
		const execution =
			kind === "signal"
				? { signal: cancellation.signal }
				: {
						checkCancelled: () => {
							if (cancelled) throw new Error("recall abandoned");
						},
					};
		const owner = await getDbOwner();
		const submit = owner.submit.bind(owner);
		owner.submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
			const handle = submit<Result>(request, options);
			const operation =
				stage === "metadata" ? "memory-search.transcript-evidence" : "memory-search.transcript-evidence.validate";
			if (options.operation !== operation) return handle;
			return {
				...handle,
				result: handle.result.then((result) => {
					cancelled = true;
					cancellation.abort(new Error("recall abandoned"));
					return result;
				}),
			};
		};
		const warn = spyOn(logger, "warn");
		try {
			const raw = loadMemoryConfig(directory);
			const error = await hybridRecall(
				{
					query: "Speyer tourism board phone number",
					limit: 3,
					agentId: "agent-a",
					readPolicy: "isolated",
					sessionKey: "cancelled-session",
					trackRecallAccess: true,
					claimRecallResults: true,
				},
				{
					...raw,
					search: { ...raw.search, rehearsal_enabled: false, transcript_evidence_limit: 1 },
					pipelineV2: {
						...raw.pipelineV2,
						graph: { ...raw.pipelineV2.graph, enabled: false },
						reranker: { ...raw.pipelineV2.reranker, enabled: false },
					},
				},
				async () => null,
				execution,
			).then(
				() => null,
				(error: unknown) => error,
			);
			const state = await getDbAccessor().withReadDbAsync((db) => ({
				claims: db
					.prepare("SELECT COUNT(*) AS count FROM session_recall_events WHERE session_key = ? AND agent_id = ?")
					.get("cancelled-session", "agent-a"),
				access: db
					.prepare("SELECT access_count FROM memories WHERE id = ? AND agent_id = ?")
					.get("cancelled-memory", "agent-a"),
			}));
			expect(state.claims).toEqual({ count: 0 });
			expect(state.access).toEqual({ access_count: 0 });
			expect(error instanceof Error ? error.message : null).toBe("recall abandoned");
			expect(warn.mock.calls.some((args) => args[1].startsWith("Transcript evidence"))).toBe(false);
		} finally {
			warn.mockRestore();
			owner.submit = submit;
		}
	});

	it.each([
		["unchanged", "UPDATE memory_artifacts SET source_sha256 = source_sha256"],
		["deleted", "UPDATE memory_artifacts SET is_deleted = 1"],
		["purged", "DELETE FROM memory_artifacts"],
		["revised", "UPDATE memory_artifacts SET source_sha256 = 'new-revision', content = replace(content, '142', '999')"],
		["updated", "UPDATE memory_artifacts SET updated_at = '2099-01-01T00:00:00Z'"],
		["changed source", "UPDATE memory_artifacts SET source_id = 'new-source'"],
		["other agent", "UPDATE memory_artifacts SET agent_id = 'agent-b'"],
		["other project", "UPDATE memory_artifacts SET project = 'project-b'"],
	])("revalidates %s transcripts after prefetch and before placement", async (kind, mutation) => {
		const owner = await getDbOwner();
		const submit = owner.submit.bind(owner);
		let changed = false;
		owner.submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
			const handle = submit<Result>(request, options);
			if (options.operation !== "memory-search.transcript-evidence.content" || changed) return handle;
			changed = true;
			return {
				...handle,
				result: handle.result.then(async (result) => {
					await getDbAccessor().withWriteTxAsync((db) => db.exec(mutation));
					return result;
				}),
			};
		};
		try {
			const raw = loadMemoryConfig(directory);
			const result = await hybridRecall(
				{
					query: "Speyer tourism board phone number",
					limit: 3,
					agentId: "agent-a",
					project: "project-a",
					readPolicy: "isolated",
				},
				{
					...raw,
					search: { ...raw.search, rehearsal_enabled: false, transcript_evidence_limit: 1 },
					pipelineV2: {
						...raw.pipelineV2,
						graph: { ...raw.pipelineV2.graph, enabled: false },
						reranker: { ...raw.pipelineV2.reranker, enabled: false },
					},
				},
				async () => null,
			);
			expect(changed).toBe(true);
			const transcripts = result.results.filter((row) => row.source === "transcript");
			expect(transcripts).toHaveLength(kind === "unchanged" ? 1 : 0);
			if (kind === "unchanged") expect(transcripts[0]?.content).toContain("+49 6232 142");
		} finally {
			owner.submit = submit;
		}
	});

	it.each([
		["validation", "partial"],
		["content", "partial"],
		["validation", "signal"],
		["validation", "callback"],
		["content", "signal"],
		["content", "callback"],
	])("settles independent %s reads before completing %s recall", async (stage, outcome) => {
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts (
					agent_id, source_path, source_sha256, source_kind, session_id, session_token,
					harness, captured_at, content, updated_at, is_deleted
				) VALUES ('agent-a', 'second.jsonl', 'second-fixture', 'transcript', 'session-b',
					'token-b', 'claude-code', datetime('now'), ?, datetime('now'), 0)`,
			).run("user: Speyer tourism board phone number? assistant: +49 6232 143.");
			db.prepare(
				`INSERT INTO memories (id, content, type, agent_id, created_at, updated_at, updated_by)
				 VALUES ('settlement-memory', 'Speyer tourism board phone number', 'fact', 'agent-a', datetime('now'), datetime('now'), 'test')`,
			).run();
		});
		const owner = await getDbOwner();
		const submit = owner.submit.bind(owner);
		const failure = new Error(`independent transcript ${stage} failed`);
		const failed = Promise.withResolvers<void>();
		const siblingStarted = Promise.withResolvers<void>();
		const releaseSibling = Promise.withResolvers<void>();
		const pending = new Set<string>();
		const jobs: Promise<unknown>[] = [];
		const reads: DbOwnerSubmitOptions[] = [];
		const cancellation = new AbortController();
		let cancelled = false;
		let settled = false;
		let pendingAtCompletion = -1;
		let successfulSession: string | null = null;
		owner.submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
			const handle = submit<Result>(request, options);
			if (
				stage === "content" &&
				options.operation === "memory-search.transcript-evidence" &&
				options.workloadClass === "maintenance"
			) {
				return {
					...handle,
					result: handle.result.then(() => {
						throw new Error("prefetch unavailable");
					}),
				};
			}
			if (
				options.operation !== `memory-search.transcript-evidence.${stage === "validation" ? "validate" : "content"}` ||
				options.workloadClass !== "foreground"
			)
				return handle;
			reads.push(options);
			const index = reads.length;
			pending.add(handle.job.id);
			const result = handle.result
				.then(async (value) => {
					if (index === 1) {
						failed.resolve();
						throw failure;
					}
					if (request.kind !== "query") throw new Error("Expected a real transcript query");
					const rowid = request.statement.params?.[stage === "content" ? 2 : 0];
					const row = await getDbAccessor().withReadDbAsync((db) =>
						db.prepare("SELECT session_id FROM memory_artifacts WHERE rowid = ?").get(rowid),
					);
					if (typeof row !== "object" || row === null || !("session_id" in row) || typeof row.session_id !== "string") {
						throw new Error("Expected the successful transcript session");
					}
					successfulSession = row.session_id;
					siblingStarted.resolve();
					await releaseSibling.promise;
					return value;
				})
				.finally(() => pending.delete(handle.job.id));
			jobs.push(result);
			return { ...handle, result };
		};
		const warn = spyOn(logger, "warn");
		const raw = loadMemoryConfig(directory);
		const recall = hybridRecall(
			{
				query: "Speyer tourism board phone number",
				limit: 3,
				agentId: "agent-a",
				readPolicy: "isolated",
				sessionKey: "settlement-session",
				trackRecallAccess: true,
				claimRecallResults: true,
			},
			{
				...raw,
				search: { ...raw.search, rehearsal_enabled: false, transcript_evidence_limit: 2 },
				pipelineV2: {
					...raw.pipelineV2,
					graph: { ...raw.pipelineV2.graph, enabled: false },
					reranker: { ...raw.pipelineV2.reranker, enabled: false },
				},
			},
			async () => null,
			outcome === "callback"
				? {
						checkCancelled: () => {
							if (cancelled) throw new Error("recall abandoned");
						},
					}
				: { signal: cancellation.signal },
		).then(
			(response) => {
				settled = true;
				pendingAtCompletion = pending.size;
				return { response, error: null };
			},
			(error: unknown) => {
				settled = true;
				pendingAtCompletion = pending.size;
				return { response: null, error };
			},
		);
		try {
			await Promise.all([failed.promise, siblingStarted.promise]);
			await Bun.sleep(20);
			const settledBeforeRelease = settled;
			expect(pending.size).toBe(1);
			if (outcome !== "partial") {
				cancelled = true;
				cancellation.abort(new Error("recall abandoned"));
				await Bun.sleep(20);
			}
			const settledBeforeSibling = settled;
			releaseSibling.resolve();
			const { response, error } = await recall;
			if (outcome === "partial") {
				expect(error).toBeNull();
				expect(response?.results.filter((row) => row.source === "transcript").map((row) => row.id)).toEqual([
					`transcript:${successfulSession}`,
				]);
				expect(response?.results.find((row) => row.source === "transcript")?.content).toContain("+49 6232 14");
				expect(response?.meta.transcriptEvidence).toEqual({ returned: 1, ranking: "keyword", failed: true });
				expect(warn.mock.calls.filter((args) => args[2]?.error === failure.message)).toHaveLength(1);
			} else {
				expect(response).toBeNull();
				expect(error instanceof Error ? error.message : null).toBe("recall abandoned");
				const state = await getDbAccessor().withReadDbAsync((db) => ({
					claims: db
						.prepare("SELECT COUNT(*) AS count FROM session_recall_events WHERE session_key = ? AND agent_id = ?")
						.get("settlement-session", "agent-a"),
					access: db
						.prepare("SELECT access_count FROM memories WHERE id = ? AND agent_id = ?")
						.get("settlement-memory", "agent-a"),
				}));
				expect(state.claims).toEqual({ count: 0 });
				expect(state.access).toEqual({ access_count: 0 });
				expect(warn.mock.calls.some((args) => args[2]?.error === "recall abandoned")).toBe(false);
			}
			expect(settledBeforeRelease).toBe(false);
			expect(settledBeforeSibling).toBe(false);
			expect(reads).toHaveLength(2);
			expect(pendingAtCompletion).toBe(0);
			expect(pending.size).toBe(0);
			expect(owner.health().queuedJobs).toBe(0);
			expect(owner.health().activeJobId).toBeNull();
		} finally {
			releaseSibling.resolve();
			await recall;
			await Promise.allSettled(jobs);
			warn.mockRestore();
			owner.submit = submit;
		}
	});

	it.each([29_000, 31_000])("keeps the original prefetch deadline after a failure at %i ms", async (delay) => {
		const owner = await getDbOwner();
		const submit = owner.submit.bind(owner);
		const now = Date.now.bind(Date);
		let elapsed = 0;
		const clock = spyOn(Date, "now").mockImplementation(() => now() + elapsed);
		const reads: DbOwnerSubmitOptions[] = [];
		owner.submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions): DbOwnerJobHandle<Result> => {
			if (options.operation === "memory-search.transcript-evidence.content") {
				reads.push(options);
				if (reads.length === 1) {
					elapsed = delay;
					throw new Error("speculative read failed");
				}
			}
			return submit<Result>(request, options);
		};
		try {
			const raw = loadMemoryConfig(directory);
			const response = await hybridRecall(
				{
					query: "Speyer tourism board phone number",
					limit: 3,
					agentId: "agent-a",
					readPolicy: "isolated",
					trackRecallAccess: false,
					claimRecallResults: false,
				},
				{
					...raw,
					search: { ...raw.search, rehearsal_enabled: false, transcript_evidence_limit: 1 },
					pipelineV2: {
						...raw.pipelineV2,
						graph: { ...raw.pipelineV2.graph, enabled: false },
						reranker: { ...raw.pipelineV2.reranker, enabled: false },
					},
				},
				async () => null,
			);
			if (delay < 30_000) {
				expect(response.results.find((row) => row.id === "transcript:session-a")?.content).toContain("+49 6232 142");
				expect(reads).toHaveLength(2);
				expect(reads[1]?.deadlineMs).toBeGreaterThan(0);
				expect(reads[1]?.deadlineMs).toBeLessThanOrEqual(1_000);
			} else {
				expect(reads).toHaveLength(1);
				expect(response.meta.transcriptEvidence).toEqual({ returned: 0, failed: true });
			}
		} finally {
			owner.submit = submit;
			clock.mockRestore();
		}
	});
});
