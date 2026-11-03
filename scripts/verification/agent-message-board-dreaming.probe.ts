import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DreamingConfig } from "@signet/core";
import { invalidateAgentScopeCache } from "../../platform/daemon/src/agent-id";
import {
	type BoardViewer,
	createBoardThread,
	deleteBoardThread,
	drainBoardProjections,
	projectBoardPost,
	replyToBoardThread,
	resetBoardStateForTest,
} from "../../platform/daemon/src/board";
import { createAgentMessage, resetCrossAgentStateForTest } from "../../platform/daemon/src/cross-agent";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../../platform/daemon/src/db-accessor";
import { dbOwnerBatch, dbOwnerQuery, ownerStatement } from "../../platform/daemon/src/db-owner-runtime";
import {
	type EpisodicSourceRecord,
	readRecentEpisodicSources,
	searchEpisodicSources,
} from "../../platform/daemon/src/episodic-sources";
import { indexExternalMemoryArtifact, softDeleteArtifactRowsForPath } from "../../platform/daemon/src/memory-lineage";
import { runDreamingAgentPass } from "../../platform/daemon/src/pipeline/dreaming";
import { applyDreamingOperations } from "../../platform/daemon/src/pipeline/dreaming-operations";
import { getOntologyClaimEvidence } from "../../platform/daemon/src/ontology-claim-evidence";
import { renderDreamingEvidence } from "../../platform/daemon/src/pipeline/dreaming-evidence";
import {
	markSessionTranscriptCompleted,
	upsertSessionTranscriptAsync,
} from "../../platform/daemon/src/session-transcripts";

const PIN = "fd288111060baf636aa064d3d201f33b1120ddb5";
const ROOT = join(import.meta.dir, "../..");
const PRODUCTION_PATHS = [
	"platform/daemon/src/board.ts",
	"platform/daemon/src/cross-agent.ts",
	"platform/daemon/src/memory-lineage.ts",
	"platform/daemon/src/episodic-sources.ts",
	"platform/daemon/src/ontology-proposals.ts",
	"platform/daemon/src/ontology-claim-evidence.ts",
	"platform/daemon/src/session-transcripts.ts",
	"platform/daemon/src/pipeline/dreaming.ts",
	"platform/daemon/src/pipeline/dreaming-evidence.ts",
	"platform/daemon/src/pipeline/dreaming-evidence-consumption.ts",
	"platform/daemon/src/pipeline/dreaming-operations.ts",
];
const SOURCE_MANIFEST = PRODUCTION_PATHS.map((path) => {
	const pinned = execFileSync("git", ["show", `${PIN}:${path}`], { cwd: ROOT });
	const actual = readFileSync(join(ROOT, path));
	if (!pinned.equals(actual)) throw new Error(`Characterization source changed since ${PIN}: ${path}`);
	return { path, sha256: createHash("sha256").update(actual).digest("hex") };
});

const DREAMING_CONFIG: DreamingConfig = {
	enabled: true,
	tokenThreshold: 1,
	maxInterval: 6 * 60 * 60 * 1_000,
	maxInputTokens: 32_000,
	maxOutputTokens: 1_000,
	timeout: 30_000,
	backfillOnFirstRun: true,
};

const SENT_FACT = "rotate the sentinel widget keys every ninety days";
const SENT_BODY = `SENTINEL-BRD-7f3a: we agreed to ${SENT_FACT}.`;

const alpha: BoardViewer = { kind: "agent", agentId: "alpha", readPolicy: "shared", policyGroup: null };
const beta: BoardViewer = { kind: "agent", agentId: "beta", readPolicy: "shared", policyGroup: null };
const operator: BoardViewer = { kind: "operator" };

let dir = "";
let previousSignetPath: string | undefined;
const observations: Record<string, unknown> = {
	_metadata: {
		implementation_sha: PIN,
		kind: "pinned behavior characterization, including counterexamples; not acceptance of the observed gaps",
		bun_version: Bun.version,
		runner_sha256: createHash("sha256")
			.update(readFileSync(import.meta.path))
			.digest("hex"),
		source_manifest: SOURCE_MANIFEST,
		executor: "scripted test double calling production Dreaming tools; no LLM inference",
	},
};

function record(key: string, value: unknown): void {
	observations[key] = value;
	console.log(`PROBE ${JSON.stringify({ [key]: value })}`);
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone verifier, not a cached Turbo task
	const out = process.env.BOARD_PROOF_OUT;
	if (out) writeFileSync(out, `${JSON.stringify(observations, null, 2)}\n`);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "signet-board-dreaming-"));
	previousSignetPath = process.env.SIGNET_PATH;
	process.env.SIGNET_PATH = dir;
	mkdirSync(join(dir, "memory"), { recursive: true });
	initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
});

afterEach(async () => {
	resetBoardStateForTest();
	resetCrossAgentStateForTest();
	invalidateAgentScopeCache();
	await closeDbAccessor();
	if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousSignetPath;
	rmSync(dir, { recursive: true, force: true });
});

interface ArtifactRow {
	readonly agent_id: string;
	readonly source_path: string;
	readonly source_sha256: string;
	readonly source_kind: string;
	readonly source_id: string | null;
	readonly source_node_id: string | null;
	readonly source_external_id: string | null;
	readonly source_parent_path: string | null;
	readonly harness: string | null;
	readonly is_deleted: number | null;
}

async function boardArtifacts(): Promise<readonly ArtifactRow[]> {
	return await dbOwnerQuery(
		ownerStatement(
			`SELECT agent_id, source_path, source_sha256, source_kind, source_id, source_node_id,
			        source_external_id, source_parent_path, harness, is_deleted
			 FROM memory_artifacts WHERE source_kind = 'board_post' ORDER BY source_path, agent_id`,
			[],
			"all",
		),
		{ operation: "test.board-dreaming.artifacts", lane: "read" },
	);
}

async function scalar(sql: string, args: readonly unknown[] = []): Promise<number> {
	const rows = await dbOwnerQuery<readonly { readonly n: number }[]>(ownerStatement(sql, [...args], "all"), {
		operation: "test.board-dreaming.scalar",
		lane: "read",
	});
	return rows[0]?.n ?? -1;
}

async function registerAgents(): Promise<void> {
	await dbOwnerBatch(
		["alpha", "beta"].map((id) =>
			ownerStatement(
				"INSERT OR REPLACE INTO agents (id, name, read_policy, policy_group, created_at, updated_at) VALUES (?, ?, 'shared', NULL, datetime('now'), datetime('now'))",
				[id, id],
			),
		),
		{ operation: "test.board-dreaming.agents", lane: "write" },
	);
	invalidateAgentScopeCache();
}

function jsonl(...lines: readonly unknown[]): string {
	return lines.map((line) => JSON.stringify(line)).join("\n");
}

async function seedCompletedTranscript(agentId: string, sessionKey: string, transcript: string): Promise<void> {
	const stored = await upsertSessionTranscriptAsync(sessionKey, transcript, "claude-code", null, agentId);
	expect(stored).toBe(true);
	expect(markSessionTranscriptCompleted(sessionKey, agentId)).toBe(true);
}

type Candidate = {
	readonly ref: string;
	readonly sourceKind: string;
	readonly hasSentinel: boolean;
	readonly rendered: string;
};

function toCandidate(s: EpisodicSourceRecord): Candidate {
	const rendered = renderDreamingEvidence(s);
	return {
		ref: `${s.kind}:${s.id}`,
		sourceKind: s.sourceKind,
		hasSentinel: rendered.includes(SENT_FACT),
		rendered,
	};
}

function candidates(agentId: string): readonly Candidate[] {
	return getDbAccessor().withReadDb((db) =>
		searchEpisodicSources(db, { agentId, query: "", excludeDelivered: true, limit: 51 }).map(toCandidate),
	);
}

function candidatesViaRecentReader(agentId: string): readonly Candidate[] {
	return getDbAccessor().withReadDb((db) =>
		readRecentEpisodicSources(db, agentId, 50, ["memory", "artifact", "transcript"], null, "oldest").map(toCandidate),
	);
}

function seedEntityAspect(agentId: string): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at)
			 VALUES ('e-widget', 'Sentinel Widget', 'sentinel widget', 'project', ?, 1, 0, datetime('now'), datetime('now'))`,
		).run(agentId);
		db.prepare(
			`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES ('a-keys', 'e-widget', ?, 'keys', 'keys', 0.5, datetime('now'), datetime('now'))`,
		).run(agentId);
	});
}

describe("board -> Dreaming evidence characterization (isolated fixture, scripted executor)", () => {
	it("A. projection is idempotent per (agent_id, source_path); records participant scoping", async () => {
		await registerAgents();
		const created = await createBoardThread({
			viewer: alpha,
			author: { agentId: "alpha", sessionKey: "a1", harness: "pi" },
			topic: "probe",
			title: "Sentinel thread",
			body: SENT_BODY,
		});
		const reply = await replyToBoardThread({
			viewer: beta,
			author: { agentId: "beta", sessionKey: "b1", harness: "pi" },
			threadId: created.thread.id,
			body: "SENTINEL-REPLY: acknowledged.",
			replyToPostId: created.post.id,
		});
		const afterWrites = await boardArtifacts();
		for (let i = 0; i < 3; i += 1) {
			expect(await projectBoardPost(created.post.id)).toBe(true);
			expect(await projectBoardPost(reply.post.id)).toBe(true);
		}
		const drained = await drainBoardProjections();
		const afterRepeats = await boardArtifacts();
		const strip = (rows: readonly ArtifactRow[]) =>
			rows.map(
				(r) =>
					`${r.agent_id}|${r.source_path.replace(created.thread.id, "T").replace(created.post.id, "P1").replace(reply.post.id, "P2")}|${r.source_sha256}`,
			);
		record("A_projection", {
			rowsAfterWrites: afterWrites.length,
			rowsAfterRepeatedProjection: afterRepeats.length,
			drainedAfterRepeats: drained,
			identitiesAndHashesStableAcrossRepeats:
				JSON.stringify(strip(afterWrites)) === JSON.stringify(strip(afterRepeats)),
			rows: afterRepeats.map((r) => ({
				agent: r.agent_id,
				path: r.source_path
					.replace(created.thread.id, "<T>")
					.replace(created.post.id, "<P1>")
					.replace(reply.post.id, "<P2>"),
				kind: r.source_kind,
				harness: r.harness,
				source_id: r.source_id,
				source_node_id: r.source_node_id,
				source_external_id:
					r.source_external_id === created.post.id
						? "<P1>"
						: r.source_external_id === reply.post.id
							? "<P2>"
							: r.source_external_id,
				source_parent_path: r.source_parent_path?.replace(created.thread.id, "<T>"),
				sha_prefix: r.source_sha256.slice(0, 12),
				is_deleted: r.is_deleted,
			})),
		});
		expect(afterWrites.length).toBe(3);
		expect(afterRepeats.length).toBe(afterWrites.length);
		expect(strip(afterRepeats)).toEqual(strip(afterWrites));
		expect(afterRepeats.filter((r) => r.source_external_id === created.post.id).map((r) => r.agent_id)).toEqual([
			"alpha",
		]);
		expect(
			afterRepeats
				.filter((r) => r.source_external_id === reply.post.id)
				.map((r) => r.agent_id)
				.sort(),
		).toEqual(["alpha", "beta"]);
	});

	it("B. promote: direct message is not episodic until promoted; promoted post projects to participants", async () => {
		await registerAgents();
		const body = `SENTINEL-DM-91c2: ${SENT_FACT}.`;
		const message = createAgentMessage({
			fromAgentId: "alpha",
			fromSessionKey: "a1",
			toAgentId: "beta",
			content: body,
		});
		const before = {
			artifacts: await scalar("SELECT COUNT(*) AS n FROM memory_artifacts WHERE content LIKE ?", [
				"%SENTINEL-DM-91c2%",
			]),
			transcripts: await scalar("SELECT COUNT(*) AS n FROM session_transcripts WHERE content LIKE ?", [
				"%SENTINEL-DM-91c2%",
			]),
			memories: await scalar("SELECT COUNT(*) AS n FROM memories WHERE content LIKE ?", ["%SENTINEL-DM-91c2%"]),
		};
		const promoted = await createBoardThread({
			viewer: beta,
			author: { agentId: "beta", sessionKey: "b1" },
			topic: "probe",
			fromMessageId: message.id,
		});
		const rows = await boardArtifacts();
		record("B_promote", {
			beforePromote: before,
			afterPromote: {
				boardArtifactRows: rows.length,
				agents: rows.map((r) => r.agent_id),
				sameShaAcrossAgents: new Set(rows.map((r) => r.source_sha256)).size === 1,
				postAuthor: promoted.post.authorAgentId,
				threadAuthor: promoted.thread.authorAgentId,
			},
		});
		expect(before.artifacts + before.transcripts + before.memories).toBe(0);
		expect(rows.length).toBe(2);
		expect(rows.map((r) => r.agent_id).sort()).toEqual(["alpha", "beta"]);
		expect(new Set(rows.map((r) => r.source_sha256)).size).toBe(1);
	});

	it("C. board body also present in a completed transcript yields two independent candidates (observed)", async () => {
		await registerAgents();
		await createBoardThread({
			viewer: alpha,
			author: { agentId: "alpha", sessionKey: "a1", harness: "pi" },
			topic: "probe",
			title: "Sentinel thread",
			body: SENT_BODY,
		});
		const NEG = "SENTINEL-NEG-5d10: this only appears inside tool_use input and tool_result";
		await seedCompletedTranscript(
			"alpha",
			"sess-overlap",
			jsonl(
				{ type: "user", message: { role: "user", content: `Peer says: ${SENT_BODY}` } },
				{
					type: "assistant",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: `I will post that. ${SENT_BODY}` },
							{ type: "tool_use", id: "t1", name: "board_post", input: { body: `${NEG} (input)` } },
						],
					},
				},
				{
					type: "user",
					message: {
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "t1", content: `${NEG} (result)` }],
					},
				},
			),
		);
		const list = candidates("alpha");
		const withSentinel = list.filter((c) => c.hasSentinel);
		const neg = list.filter((c) => c.rendered.includes("SENTINEL-NEG-5d10"));
		record("C_overlap", {
			allCandidates: list.map((c) => ({
				kind: c.ref.split(":")[0],
				sourceKind: c.sourceKind,
				hasSentinel: c.hasSentinel,
			})),
			candidatesContainingBoardFact: withSentinel.length,
			distinctKindsContainingBoardFact: withSentinel.map((c) => `${c.ref.split(":")[0]}/${c.sourceKind}`),
			negativeControl_toolBlocksOnly_candidatesContainingNeg: neg.length,
		});
		expect(withSentinel.length).toBe(2);
		expect(neg.length).toBe(0);
	});

	it("D. dedupe controls: artifact content-hash dedupe exists but is artifact-vs-artifact only", async () => {
		await registerAgents();
		const common = { agentId: "alpha", harness: "probe", sourceKind: "probe_doc", sourceMtimeMs: Date.now() };
		const sameContent = `# doc\n\nSENTINEL-CTL: ${SENT_FACT}.`;
		await indexExternalMemoryArtifact({ ...common, sourcePath: "probe://a", content: sameContent });
		await indexExternalMemoryArtifact({ ...common, sourcePath: "probe://b", content: sameContent });
		const sameHashList = candidates("alpha").filter((c) => c.sourceKind === "probe_doc");
		const sameHashViaRecent = candidatesViaRecentReader("alpha").filter((c) => c.sourceKind === "probe_doc");
		await createBoardThread({
			viewer: alpha,
			author: { agentId: "alpha" },
			topic: "probe",
			title: "t1",
			body: SENT_BODY,
		});
		await createBoardThread({
			viewer: alpha,
			author: { agentId: "alpha" },
			topic: "probe",
			title: "t2",
			body: SENT_BODY,
		});
		const boards = candidates("alpha").filter((c) => c.sourceKind === "board_post");
		const shas = (await boardArtifacts()).map((r) => r.source_sha256);
		record("D_dedupe_controls", {
			identicalContentArtifactsIndexed: 2,
			identicalContentArtifactsOffered_deliveryQueue: sameHashList.length,
			identicalContentArtifactsOffered_recentReader: sameHashViaRecent.length,
			identicalBodyBoardThreadsIndexed: 2,
			identicalBodyBoardArtifactsOffered: boards.length,
			boardShaDistinct: new Set(shas).size,
		});
		expect(sameHashList.length).toBe(1);
		expect(boards.length).toBe(2);
	});

	it("E. scripted Dreaming pass: delivery, consumption, redelivery, claim-level dedupe", async () => {
		await registerAgents();
		const created = await createBoardThread({
			viewer: alpha,
			author: { agentId: "alpha", sessionKey: "a1", harness: "pi" },
			topic: "probe",
			title: "Sentinel thread",
			body: SENT_BODY,
		});
		await seedCompletedTranscript(
			"alpha",
			"sess-overlap",
			jsonl({ type: "user", message: { role: "user", content: `Peer says: ${SENT_BODY}` } }),
		);
		seedEntityAspect("alpha");

		const delivered: Array<Record<string, unknown>> = [];
		const applyResults: unknown[] = [];
		const reviewResults: unknown[] = [];

		const drain = async (tools: Parameters<Parameters<typeof runDreamingAgentPass>[1]["run"]>[0]["tools"]) => {
			const search = tools.find((t) => t.name === "search_evidence");
			const review = tools.find((t) => t.name === "review_evidence");
			if (!search || !review) throw new Error("tools missing");
			const res = await search.execute("c-search", { agentId: "alpha" }, undefined, undefined, {} as never);
			const parsed = JSON.parse((res.content[0] as { text: string }).text) as {
				items?: Array<Record<string, unknown>>;
			};
			return { parsed, review };
		};

		const first = await runDreamingAgentPass(
			getDbAccessor(),
			{
				async run(input) {
					const { parsed, review } = await drain(input.tools);
					for (const item of parsed.items ?? []) delivered.push(item);
					const apply = input.tools.find((t) => t.name === "apply_ontology_ops");
					if (!apply) throw new Error("apply_ontology_ops missing");
					const claim = (sourceRef: string, sourceKind: string, sourceId: string, sourcePath: string | undefined) => ({
						operation: "add_claim_value",
						payload: { entityId: "e-widget", aspectId: "a-keys", claimKey: "rotation", value: `Keys: ${SENT_FACT}.` },
						reason: "scripted test double: same claim from each cited source",
						evidence: [
							{
								source_ref: sourceRef,
								source_kind: sourceKind,
								source_id: sourceId,
								...(sourcePath ? { source_path: sourcePath } : {}),
								quote: SENT_FACT,
							},
						],
					});
					const boardItem = (parsed.items ?? []).find((i) => String(i.sourceRef).startsWith("artifact:"));
					const trItem = (parsed.items ?? []).find((i) => String(i.sourceRef).startsWith("transcript:"));
					const ops = [] as unknown[];
					if (boardItem)
						ops.push(
							claim(
								String(boardItem.sourceRef),
								String(boardItem.sourceKind),
								String(boardItem.sourceId),
								boardItem.sourcePath as string | undefined,
							),
						);
					if (trItem)
						ops.push(
							claim(
								String(trItem.sourceRef),
								String(trItem.sourceKind),
								String(trItem.sourceId),
								trItem.sourcePath as string | undefined,
							),
						);
					applyResults.push(
						JSON.parse(
							(
								(
									await apply.execute(
										"c-apply",
										{ agentId: "alpha", operations: ops },
										undefined,
										undefined,
										{} as never,
									)
								).content[0] as { text: string }
							).text,
						),
					);
					if ((parsed.items ?? []).length > 0) {
						const reviewed = await review.execute(
							"c-review",
							{
								agentId: "alpha",
								items: (parsed.items ?? []).map((i) => ({
									sourceRef: String(i.sourceRef),
									contentOffset: Number(i.contentOffset ?? 0),
								})),
							},
							undefined,
							undefined,
							{} as never,
						);
						reviewResults.push(JSON.parse((reviewed.content[0] as { text: string }).text));
					}
					return { summary: "scripted test double" };
				},
			},
			DREAMING_CONFIG,
			dir,
			"alpha",
			["alpha"],
			"incremental",
		);

		for (let i = 0; i < 3; i += 1) expect(await projectBoardPost(created.post.id)).toBe(true);
		const secondDelivered: Array<Record<string, unknown>> = [];
		await runDreamingAgentPass(
			getDbAccessor(),
			{
				async run(input) {
					const { parsed } = await drain(input.tools);
					for (const item of parsed.items ?? []) secondDelivered.push(item);
					return { summary: "scripted test double (second pass)" };
				},
			},
			DREAMING_CONFIG,
			dir,
			"alpha",
			["alpha"],
			"incremental",
		);

		const claims = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					`SELECT id, status, claim_key, normalized_content, source_kind, source_id, source_path, source_root
					 FROM entity_attributes WHERE agent_id = 'alpha' AND claim_key = 'rotation'`,
				)
				.all(),
		);
		const consumption = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					`SELECT source_kind, source_id, delivered_offset, source_length
					 FROM dreaming_evidence_consumption WHERE agent_id = 'alpha' ORDER BY source_kind, source_id`,
				)
				.all(),
		);
		const claimEvidence = await getOntologyClaimEvidence(getDbAccessor(), {
			agentId: "alpha",
			entity: "Sentinel Widget",
			aspect: "keys",
			group: "general",
			claim: "rotation",
		}).then(
			(r) => ({
				items: r.items.length,
				evidenceCountPerItem: r.items.map((i) => i.evidenceCount),
				evidence: r.items.flatMap((i) => i.evidence).map((e) => JSON.parse(JSON.stringify(e)) as unknown),
			}),
			(error: unknown) => ({ error: String(error) }),
		);
		record("E_dreaming_pass", {
			passResult: first,
			firstPassDeliveredItems: delivered.map((i) => ({
				sourceRef: String(i.sourceRef).replace(created.thread.id, "<T>").replace(created.post.id, "<P>"),
				keys: Object.keys(i),
			})),
			firstPassApply: applyResults,
			firstPassReview: reviewResults,
			claimEvidence: claimEvidence,
			reprojectionsAfterReview: 3,
			secondPassDeliveredItems: secondDelivered.length,
			activeClaimsForSameFactAcrossBothSources: claims,
			consumptionRows: consumption,
		});
		expect(delivered.map((i) => String(i.sourceRef).split(":")[0]).sort()).toEqual(["artifact", "transcript"]);
		expect(claims.length).toBe(1);
		expect(
			(applyResults[0] as { items: Array<{ result: { deduped: boolean } }> }).items.map((i) => i.result.deduped),
		).toEqual([false, true]);
		expect(secondDelivered.length).toBe(0);
		const evidenceKinds = ("evidence" in claimEvidence ? claimEvidence.evidence : []).map(
			(e) => (e as { sourceKind?: string }).sourceKind,
		);
		expect(evidenceKinds).toContain("board_post");
		expect(evidenceKinds).not.toContain("transcript");
	});

	it("F. observed lifecycle: thread delete retains derived claims; explicit re-projection restores soft-deleted artifact", async () => {
		await registerAgents();
		const created = await createBoardThread({
			viewer: alpha,
			author: { agentId: "alpha", sessionKey: "a1", harness: "pi" },
			topic: "probe",
			title: "Sentinel thread",
			body: SENT_BODY,
		});
		seedEntityAspect("alpha");
		const ref = `artifact:signet-board://thread/${created.thread.id}/post/${created.post.id}`;
		const applied = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "alpha",
			actor: "dreaming",
			operations: [
				{
					operation: "add_claim_value",
					payload: { entityId: "e-widget", aspectId: "a-keys", claimKey: "rotation", value: `Keys: ${SENT_FACT}.` },
					evidence: [{ source_ref: ref, quote: SENT_FACT }],
				},
			],
		});
		const stamp = () =>
			getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						"SELECT status, source_kind, source_id, source_path, source_root FROM entity_attributes WHERE agent_id = 'alpha' AND claim_key = 'rotation'",
					)
					.all(),
			);
		const claimsBeforeDelete = stamp();
		const softPath = `signet-board://thread/${created.thread.id}/post/${created.post.id}`;
		await softDeleteArtifactRowsForPath(softPath, "alpha");
		const afterSoft = (await boardArtifacts()).map((r) => r.is_deleted);
		await projectBoardPost(created.post.id);
		const afterReproject = (await boardArtifacts()).map((r) => r.is_deleted);
		await deleteBoardThread(created.thread.id, operator);
		const claimsAfterDelete = stamp();
		record("F_lifecycle", {
			applyOk: (applied as { ok?: boolean }).ok,
			claimsBeforeDelete,
			artifactIsDeletedAfterSoftDeleteCall: afterSoft,
			artifactIsDeletedAfterReprojection: afterReproject,
			boardArtifactsAfterThreadDelete: (await boardArtifacts()).length,
			claimsAfterThreadDelete: claimsAfterDelete,
		});
		expect((applied as { ok?: boolean }).ok).toBe(true);
		expect(claimsBeforeDelete).toMatchObject([{ status: "active", source_kind: "board_post" }]);
		expect(afterSoft).toEqual([1]);
		expect(afterReproject).toEqual([0]);
		expect(await boardArtifacts()).toEqual([]);
		expect(claimsAfterDelete).toEqual(claimsBeforeDelete);
	});

	it("G. consumption control: unacknowledged delivery is redelivered; acknowledged delivery is not", async () => {
		await registerAgents();
		await createBoardThread({
			viewer: alpha,
			author: { agentId: "alpha", sessionKey: "a1", harness: "pi" },
			topic: "probe",
			title: "Sentinel thread",
			body: SENT_BODY,
		});
		await seedCompletedTranscript(
			"alpha",
			"sess-overlap",
			jsonl({ type: "user", message: { role: "user", content: `Peer says: ${SENT_BODY}` } }),
		);
		const runPass = async (ack: boolean): Promise<readonly string[]> => {
			const seen: string[] = [];
			await runDreamingAgentPass(
				getDbAccessor(),
				{
					async run(input) {
						const search = input.tools.find((t) => t.name === "search_evidence");
						const review = input.tools.find((t) => t.name === "review_evidence");
						if (!search || !review) throw new Error("tools missing");
						const res = await search.execute("c-search", { agentId: "alpha" }, undefined, undefined, {} as never);
						const items =
							(JSON.parse((res.content[0] as { text: string }).text) as { items?: Array<Record<string, unknown>> })
								.items ?? [];
						for (const i of items)
							seen.push(
								String(i.sourceRef)
									.split("/post/")[0]
									.replace(/thread\/.*/, "thread/<T>"),
							);
						if (ack && items.length > 0) {
							const out = await review.execute(
								"c-review",
								{
									agentId: "alpha",
									items: items.map((i) => ({
										sourceRef: String(i.sourceRef),
										contentOffset: Number(i.contentOffset ?? 0),
									})),
								},
								undefined,
								undefined,
								{} as never,
							);
							expect(JSON.parse((out.content[0] as { text: string }).text).ok).toBe(true);
						}
						return { summary: "scripted test double" };
					},
				},
				DREAMING_CONFIG,
				dir,
				"alpha",
				["alpha"],
				"incremental",
			);
			return seen;
		};
		const p1NoAck = await runPass(false);
		const p2NoAck = await runPass(false);
		const p3Ack = await runPass(true);
		const p4 = await runPass(false);
		record("G_consumption_control", {
			pass1_noAck_delivered: p1NoAck,
			pass2_noAck_delivered: p2NoAck,
			pass3_ack_delivered: p3Ack,
			pass4_after_ack_delivered: p4,
		});
		expect(p1NoAck.length).toBe(2);
		expect([...p2NoAck].sort()).toEqual([...p1NoAck].sort());
		expect([...p3Ack].sort()).toEqual([...p1NoAck].sort());
		expect(p4.length).toBe(0);
	});
});
