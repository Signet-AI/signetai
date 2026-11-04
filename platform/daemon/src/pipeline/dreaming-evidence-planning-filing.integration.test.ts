import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import {
	closeRegisteredDbOwnerMaintenance,
	createDbOwnerMaintenance,
	registerDbOwnerMaintenance,
} from "../db-owner-maintenance";
import { startDbOwner } from "../db-owner-runtime";
import { ownerReadAll, ownerReadOne, ownerRun } from "../db-owner-sql";
import { resetInferenceRouterForTests } from "../inference-router";
import { loadMemoryConfig } from "../memory-config";
import { getDreamingToolCalls, hasDreamingEpisodicBacklog } from "./dreaming";
import { getDreamingReviewedEvidence } from "./dreaming-evidence-reviews";
import { dreamingLiveEvents } from "./dreaming-live-events";
import { startDreamingWorker, type DreamingWorkerHandle } from "./dreaming-worker";
import { activePiAgentWorkers, stopPiAgentWorkers } from "./pi-agent-client";
import { getLlmConcurrencyStatus } from "./provider";

const AGENT = "agent-a";
const CAPTURED_AT = "2026-10-01T00:00:00.000Z";
const PURCHASE = "I bought a sea kayak in Portland";
const ROUTINE = "I paddle it every Sunday";
const EXCLUSION_REASON = "This complete session contains only a greeting, with no durable user fact.";

type EvidenceItem = {
	sourceRef: string;
	content: string;
	contentOffset: number;
	contentLength: number;
	contentHasNext: boolean;
	sourceRevision: string;
};
type ModelRequest = {
	model: string;
	thinking_token_budget: number;
	max_tokens: number;
	messages: Array<{ role: string; content?: string | Array<{ text?: string }> }>;
	tools: Array<{ function: { name: string } }>;
};

function reply(delta: unknown, finish: string): Response {
	return new Response(
		`data: ${JSON.stringify({ id: "dreaming-regression", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

function call(name: string, args: unknown, id: string): Response {
	return reply(
		{
			role: "assistant",
			tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
		},
		"tool_calls",
	);
}

function lastToolOutput(body: ModelRequest): Record<string, unknown> {
	const last = body.messages.at(-1);
	expect(last?.role).toBe("tool");
	const content = last?.content;
	const text = typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
	if (!text.startsWith("{")) throw new Error(`Non-JSON tool result: ${text}`);
	return JSON.parse(text);
}

test.each([
	{ label: "opt-in planning", planningBudget: 8_000 },
	{ label: "normal thinking by default", planningBudget: undefined },
])(
	"real Dreaming evidence -> same-request filing -> acknowledgement ($label)",
	async ({ planningBudget }) => {
		const root = mkdtempSync(join(tmpdir(), "signet-dreaming-evidence-planning-filing-"));
		const previousOwnerMode = process.env.SIGNET_DB_OWNER_WORKER;
		const previousPath = process.env.SIGNET_PATH;
		const requests: ModelRequest[] = [];
		const modelErrors: unknown[] = [];
		let worker: DreamingWorkerHandle | undefined;
		let owner: Awaited<ReturnType<typeof startDbOwner>> | undefined;
		let passNumber = 0;
		let turn = 0;
		let firstPage: EvidenceItem[] = [];
		let secondPage: EvidenceItem[] = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
					return new Response("not found", { status: 404 });
				try {
					const body = (await request.json()) as ModelRequest;
					if (!body.tools?.length) return reply({ role: "assistant", content: "Reviewed the previous pass." }, "stop");
					requests.push(body);
					expect(activePiAgentWorkers()).toBe(1);
					if (body.messages.at(-1)?.role === "user") {
						passNumber++;
						turn = 0;
					}
					turn++;
					const id = `pass-${passNumber}-turn-${turn}`;
					if (turn === 1) {
						expect(body.tools.map((tool) => tool.function.name)).toContain("apply_ontology_ops");
						return call("search_evidence", { agentId: AGENT }, id);
					}
					const output = lastToolOutput(body);
					expect(output.ok).toBe(true);
					if (turn === 2) {
						const items = output.items as EvidenceItem[];
						if (passNumber === 1) {
							firstPage = items;
							expect(items.reduce((total, item) => total + item.content.length, 0)).toBeGreaterThanOrEqual(64_000);
							expect(items.map((item) => item.sourceRef).sort()).toEqual([
								"transcript:greeting",
								"transcript:kayak",
								"transcript:unacknowledged",
							]);
							expect(items.every((item) => !item.contentHasNext && item.contentOffset === 0)).toBe(true);
							const source = items.find((item) => item.sourceRef === "transcript:kayak");
							if (!source) throw new Error("The real delivery queue did not return the kayak session");
							expect(source.content).toContain(PURCHASE);
							expect(source.content).toContain(ROUTINE);
							const evidence = [{ source_ref: source.sourceRef, quote: PURCHASE }];
							return call(
								"apply_ontology_ops",
								{
									agentId: AGENT,
									operations: [
										{ operation: "create_entity", payload: { name: "Sea Kayak", type: "artifact" }, evidence },
										{ operation: "create_aspect", payload: { entityId: "$0", name: "ownership" }, evidence },
										{
											operation: "add_claim_value",
											payload: {
												entityId: "$0",
												aspectId: "$1",
												claimKey: "purchase",
												value: "The user bought a sea kayak in Portland.",
											},
											evidence,
										},
										{
											operation: "add_claim_value",
											payload: {
												entityId: "$0",
												aspectId: "$1",
												claimKey: "routine",
												value: "The user paddles the sea kayak every Sunday.",
											},
											evidence: [{ source_ref: source.sourceRef, quote: ROUTINE }],
										},
									],
								},
								id,
							);
						}
						secondPage = items;
						expect(items.map((item) => item.sourceRef)).toEqual(["transcript:unacknowledged"]);
						return call(
							"review_evidence",
							{
								agentId: AGENT,
								items: items.map(({ sourceRef, contentOffset }) => ({ sourceRef, contentOffset })),
							},
							id,
						);
					}
					if (passNumber === 1 && turn === 3) {
						expect((output.items as Array<{ ok: boolean }>).map((item) => item.ok)).toEqual([true, true, true, true]);
						return call(
							"review_evidence",
							{
								agentId: AGENT,
								items: firstPage
									.filter((item) => item.sourceRef !== "transcript:unacknowledged")
									.map(({ sourceRef, contentOffset }) => ({ sourceRef, contentOffset })),
							},
							id,
						);
					}
					if ((passNumber === 1 && turn === 4) || (passNumber === 2 && turn === 3)) {
						expect(output.items).toHaveLength(passNumber === 1 ? 2 : 1);
						return call(
							"runbook_write",
							{
								agentId: AGENT,
								summary:
									passNumber === 1
										? "Filed kayak ownership and routine; acknowledged the reviewed sessions."
										: "Acknowledged the remaining session.",
								openQuestions: [],
								deferred: [],
								deferredEvidence: [],
								reviewedExcludedEvidence:
									passNumber === 1
										? [{ agentId: AGENT, sourceRef: "transcript:greeting", reason: EXCLUSION_REASON }]
										: [],
							},
							id,
						);
					}
					return reply({ role: "assistant", content: "Evidence reviewed and filed." }, "stop");
				} catch (error) {
					modelErrors.push(error);
					return reply({ role: "assistant", content: "Deterministic model assertion failed." }, "stop");
				}
			},
		});
		try {
			process.env.SIGNET_DB_OWNER_WORKER = "0";
			process.env.SIGNET_PATH = root;
			mkdirSync(join(root, "memory"));
			writeFileSync(
				join(root, "agent.yaml"),
				`name: ${AGENT}
inference:
  targets:
    local:
      executor: openai-compatible
      endpoint: http://127.0.0.1:${server.port}/v1
      thinking:
        format: chat-template
        budgetTokens: 2000
${planningBudget === undefined ? "" : `        planningBudgetTokens: ${planningBudget}\n`}      models:
        default:
          model: dreaming-integration-model
          reasoning: medium
          contextWindow: 131072
          toolUse: true
          streaming: true
  workloads:
    memoryExtraction:
      target: local/default
`,
			);
			const dbPath = join(root, "memory", "memories.db");
			initDbAccessor(dbPath, { agentsDir: root });
			owner = await startDbOwner(dbPath);
			await owner.initialize(root);
			const maintenance = createDbOwnerMaintenance({ owner, dbPath });
			registerDbOwnerMaintenance(maintenance);
			expect(owner.health()).toMatchObject({ state: "ready", initialization: "ready", databaseReady: true });
			expect(owner.health().pid).toBeGreaterThan(0);
			expect(owner.health().pid).not.toBe(process.pid);
			const sources = [
				[
					"kayak",
					`User: ${PURCHASE} and ${ROUTINE}.\n${"Assistant: The session continues without another durable fact.\n".repeat(1_200)}`,
				],
				["greeting", "User: hello.\nAssistant: hello."],
				["unacknowledged", "User: Thanks.\nAssistant: You are welcome. This excerpt has not yet been reviewed."],
			] as const;
			for (const [id, content] of sources)
				await ownerRun(
					owner,
					`INSERT INTO session_transcripts (session_key, agent_id, content, harness, created_at, updated_at, completed_at)
			 VALUES (?, ?, ?, 'pi', ?, ?, ?)`,
					[id, AGENT, content, CAPTURED_AT, CAPTURED_AT, CAPTURED_AT],
					{ operation: "test.dreaming.seed-evidence", lane: "write" },
				);
			worker = startDreamingWorker(
				getDbAccessor(),
				{
					...loadMemoryConfig(root).dreaming,
					enabled: false,
					codemode: false,
					maxInputTokens: 32_000,
					maxOutputTokens: 65_536,
					timeout: 30_000,
				},
				root,
				AGENT,
				{ ownerMaintenance: maintenance },
			);
			const first = await worker.trigger("incremental", AGENT);
			await worker.activePass;
			expect(modelErrors).toEqual([]);
			expect(first).toMatchObject({ applied: 4, failed: 0 });
			expect(requests.map((request) => request.thinking_token_budget)).toEqual([
				2_000,
				planningBudget ?? 2_000,
				2_000,
				2_000,
				2_000,
			]);
			expect(
				requests.every((request) => request.max_tokens === 65_536 && request.model === "dreaming-integration-model"),
			).toBe(true);
			expect(activePiAgentWorkers()).toBe(0);
			const traces = await getDreamingToolCalls(getDbAccessor(), AGENT, first.passId);
			expect(traces.map((trace) => [trace.toolName, trace.success])).toEqual([
				["search_evidence", true],
				["apply_ontology_ops", true],
				["review_evidence", true],
				["runbook_write", true],
			]);
			const claims = await ownerReadAll<{
				entity: string;
				aspect: string;
				claimKey: string;
				content: string;
				evidence: string;
			}>(
				owner,
				`SELECT e.name AS entity, a.name AS aspect, ea.claim_key AS claimKey, ea.content,
			 ea.proposal_evidence AS evidence FROM entity_attributes ea
			 JOIN entity_aspects a ON a.id = ea.aspect_id JOIN entities e ON e.id = a.entity_id
			 WHERE ea.agent_id = ? AND ea.status = 'active' ORDER BY ea.claim_key`,
				[AGENT],
				{ operation: "test.dreaming.claim-readback", lane: "read" },
			);
			expect(claims).toHaveLength(2);
			expect(claims.map((claim) => ({ ...claim, evidence: JSON.parse(claim.evidence as string) }))).toEqual([
				{
					entity: "Sea Kayak",
					aspect: "ownership",
					claimKey: "purchase",
					content: "The user bought a sea kayak in Portland.",
					evidence: [{ source_ref: "transcript:kayak", quote: PURCHASE }],
				},
				{
					entity: "Sea Kayak",
					aspect: "ownership",
					claimKey: "routine",
					content: "The user paddles the sea kayak every Sunday.",
					evidence: [{ source_ref: "transcript:kayak", quote: ROUTINE }],
				},
			]);
			const proposals = await ownerReadAll<{
				status: string;
				source_kind: string;
				source_id: string;
				created_by: string;
			}>(
				owner,
				"SELECT status, source_kind, source_id, created_by FROM ontology_proposals WHERE agent_id = ?",
				[AGENT],
				{ operation: "test.dreaming.provenance-readback", lane: "read" },
			);
			expect(proposals).toHaveLength(4);
			expect(
				proposals.every(
					(proposal) =>
						proposal.status === "applied" &&
						proposal.source_kind === "transcript" &&
						proposal.source_id === "kayak" &&
						proposal.created_by === "dreaming",
				),
			).toBe(true);
			const consumption = await ownerReadAll<{
				source_id: string;
				delivered_offset: number;
				source_length: number;
				cursor_basis: string;
				stalled_passes: number;
				pass_id: string;
				source_revision: string;
			}>(
				owner,
				"SELECT source_id, delivered_offset, source_length, cursor_basis, stalled_passes, pass_id, source_revision FROM dreaming_evidence_consumption WHERE agent_id = ? ORDER BY source_id",
				[AGENT],
				{ operation: "test.dreaming.consumption-readback", lane: "read" },
			);
			expect(consumption).toHaveLength(3);
			for (const row of consumption) {
				const delivered = firstPage.find((item) => item.sourceRef === `transcript:${row.source_id}`);
				if (!delivered) throw new Error("Consumption has no corresponding delivered evidence");
				expect(row.source_revision).toBe(delivered.sourceRevision);
				expect(row.pass_id).toBe(first.passId);
				expect(row.source_length).toBe(delivered.contentLength);
				expect(row.cursor_basis).toBe("review");
				expect(row.delivered_offset).toBe(row.source_id === "unacknowledged" ? 0 : delivered.contentLength);
				expect(row.stalled_passes).toBe(row.source_id === "unacknowledged" ? 1 : 0);
			}
			expect(await getDreamingReviewedEvidence(getDbAccessor(), AGENT)).toMatchObject([
				{ sourceKind: "transcript", sourceId: "greeting", reason: EXCLUSION_REASON, passId: first.passId },
			]);
			expect(await hasDreamingEpisodicBacklog(getDbAccessor(), AGENT, maintenance)).toBe(true);
			const second = await worker.trigger("incremental", AGENT);
			await worker.activePass;
			expect(modelErrors).toEqual([]);
			expect(second).toMatchObject({ applied: 0, failed: 0 });
			expect(secondPage).toHaveLength(1);
			expect(requests.slice(5).map((request) => request.thinking_token_budget)).toEqual([2_000, 2_000, 2_000, 2_000]);
			expect(await hasDreamingEpisodicBacklog(getDbAccessor(), AGENT, maintenance)).toBe(false);
			expect(
				await ownerReadOne(
					owner,
					"SELECT delivered_offset = source_length AS fullyReviewed, stalled_passes, pass_id FROM dreaming_evidence_consumption WHERE agent_id = ? AND source_id = 'unacknowledged'",
					[AGENT],
					{ operation: "test.dreaming.final-consumption", lane: "read" },
				),
			).toEqual({ fullyReviewed: 1, stalled_passes: 0, pass_id: second.passId });
			expect(
				await ownerReadAll(
					owner,
					"SELECT status, mutations_applied, mutations_failed FROM dreaming_passes WHERE id IN (?, ?) ORDER BY mutations_applied DESC",
					[first.passId, second.passId],
					{ operation: "test.dreaming.pass-readback", lane: "read" },
				),
			).toEqual([
				{ status: "completed", mutations_applied: 4, mutations_failed: 0 },
				{ status: "completed", mutations_applied: 0, mutations_failed: 0 },
			]);
			expect(worker.running).toBe(false);
			expect(activePiAgentWorkers()).toBe(0);
			expect(getLlmConcurrencyStatus().running).toBe(0);
		} finally {
			worker?.stop();
			await worker?.activePass;
			await stopPiAgentWorkers();
			await closeRegisteredDbOwnerMaintenance();
			await owner?.close();
			await closeDbAccessor();
			resetInferenceRouterForTests();
			dreamingLiveEvents.reset();
			await server.stop(true);
			rmSync(root, { recursive: true, force: true });
			if (previousOwnerMode === undefined) delete process.env.SIGNET_DB_OWNER_WORKER;
			else process.env.SIGNET_DB_OWNER_WORKER = previousOwnerMode;
			if (previousPath === undefined) delete process.env.SIGNET_PATH;
			else process.env.SIGNET_PATH = previousPath;
		}
		expect(owner?.health().state).toBe("closed");
		expect(existsSync(root)).toBe(false);
	},
	60_000,
);
