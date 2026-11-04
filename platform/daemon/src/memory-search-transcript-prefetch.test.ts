import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import type { DbOwnerJobHandle, DbOwnerRequest, DbOwnerSubmitOptions } from "./db-owner-client";
import { getDbOwner } from "./db-owner-runtime";
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
				await hybridRecall(
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
				);
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
