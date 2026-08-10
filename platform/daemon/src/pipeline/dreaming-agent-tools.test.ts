import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { createDreamingAgentTools } from "./dreaming-agent-tools";
import { DREAMING_CAPABILITY_IDS } from "./dreaming-capabilities";

describe("dreaming-agent-tools", () => {
	let dir = "";
	let previousSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-dreaming-agent-tools-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "name: DreamingAgentToolsTest\n");
		previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
	});

	afterEach(() => {
		closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	function insertEntity(id: string, name: string, canonicalName: string, agentId = "owner"): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', ?, 1, 0, '2026-05-06T00:00:00.000Z', '2026-05-06T00:00:00.000Z')`,
			).run(id, name, canonicalName, agentId);
		});
	}

	function insertActiveAttribute(
		entityId: string,
		aspectId: string,
		content: string,
		agentId: string,
		aspectName = "configuration",
		memoryId: string | null = null,
	): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 0.5, datetime('now'), datetime('now'))`,
			).run(aspectId, entityId, agentId, aspectName, aspectName.toLowerCase());
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
				  confidence, importance, status, group_key, claim_key,
				  version, version_root_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'attribute', ?, ?, 0.8, 0.5, 'active', 'configuration', 'default', 1, ?, datetime('now'), datetime('now'))`,
			).run(
				`${aspectId}-attribute`,
				aspectId,
				agentId,
				memoryId,
				content,
				content.toLowerCase(),
				`${aspectId}-attribute`,
			);
		});
	}

	function insertEpisodicMemory(
		id: string,
		content: string,
		agentId = "owner",
		reviewAfter: string | null = null,
	): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories
				 (id, content, source_type, memory_kind, visibility, agent_id, review_after, created_at, updated_at)
				 VALUES (?, ?, 'manual', 'episodic', 'normal', ?, ?, datetime('now'), datetime('now'))`,
			).run(id, content, agentId, reviewAfter);
		});
	}

	function readResult(res: { content: ReadonlyArray<unknown> }): {
		readonly tool: string;
		readonly ok: boolean;
		readonly [key: string]: unknown;
	} {
		const first = res.content[0] as { text?: string } | undefined;
		const text = first && typeof first.text === "string" ? first.text : "";
		return JSON.parse(text);
	}

	function findTool(tools: ReturnType<typeof createDreamingAgentTools>, name: string) {
		const tool = tools.find((t) => t.name === name);
		if (!tool) throw new Error(`tool ${name} not registered`);
		return tool;
	}

	it("derives Pi tools and public metadata from the same capability registry", () => {
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		expect(tools.map((tool) => tool.name)).toEqual([...DREAMING_CAPABILITY_IDS]);
		expect(tools).toHaveLength(12);
	});

	it("isolates reads by agentId: search_entities only returns the caller's entities", async () => {
		insertEntity("e-owner", "Owner Entity", "owner entity", "owner");
		insertEntity("e-other", "Other Entity", "other entity", "intruder");

		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		const search = findTool(tools, "search_entities");
		const res = readResult(
			await search.execute("call", { agentId: "owner", query: "entity" }, undefined, undefined, {} as never),
		);
		expect(res.ok).toBe(true);
		const items = res.items as Array<{ id: string }>;
		expect(items.map((i) => i.id)).toEqual(["e-owner"]);
		expect(items.some((i) => i.id === "e-other")).toBe(false);
	});

	it("get_entity surfaces pinned status and hydrates aspects on demand", async () => {
		insertEntity("e-atlas", "Atlas", "atlas", "owner");
		insertActiveAttribute("e-atlas", "a-config", "Feature is enabled by default.", "owner");
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });

		const plain = readResult(
			await findTool(tools, "get_entity").execute(
				"call",
				{ agentId: "owner", entityId: "e-atlas" },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(plain).toMatchObject({ ok: true, pinned: false, aspectCount: 1 });
		expect(plain.aspects).toBeUndefined();

		const hydrated = readResult(
			await findTool(tools, "get_entity").execute(
				"call",
				{ agentId: "owner", entityId: "e-atlas", include: ["aspects"] },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(hydrated.ok).toBe(true);
		expect((hydrated.aspects as Array<{ id: string }>).map((a) => a.id)).toEqual(["a-config"]);
	});

	it("bounds content-pass tool results when evidence and entity provenance are large", async () => {
		const largeContent = `${"context ".repeat(2_000)}Needle in the middle of a large source.`;
		insertEpisodicMemory("mem-large", largeContent);
		insertEntity("e-large", "Large Entity", "large entity", "owner");
		for (let index = 0; index < 60; index += 1) {
			insertActiveAttribute("e-large", `a-large-${index}`, `Large aspect ${index}`, "owner", `aspect-${index}`);
		}
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET proposal_evidence = ? WHERE id = ? AND agent_id = ?").run(
				JSON.stringify(["evidence ".repeat(20_000)]),
				"e-large",
				"owner",
			);
		});

		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		const evidence = readResult(
			await findTool(tools, "search_evidence").execute(
				"call",
				{ agentId: "owner", query: "Needle", kind: "memory", limit: 1 },
				undefined,
				undefined,
				{} as never,
			),
		);
		const item = (
			evidence.items as Array<{
				content: string;
				contentLength: number;
				contentTruncated: boolean;
				contentHasPrevious: boolean;
				contentHasNext: boolean;
				sourceRef: string;
			}>
		)[0];
		expect(item).toMatchObject({ sourceRef: "memory:mem-large", contentTruncated: true });
		expect(item.content.length).toBeLessThanOrEqual(2_000);
		expect(largeContent).toContain(item.content);
		expect(item.content).toContain("Needle");
		expect(item.contentLength).toBe(largeContent.length);
		expect(item.contentHasPrevious).toBe(true);
		expect(item.contentHasNext).toBe(false);

		const firstFragment = readResult(
			await findTool(tools, "search_evidence").execute(
				"call",
				{ agentId: "owner", sourceRef: item.sourceRef, offset: 0, chunkSize: 2_000 },
				undefined,
				undefined,
				{} as never,
			),
		);
		const firstFragmentItem = (
			firstFragment.items as Array<{ content: string; contentOffset: number; contentHasNext: boolean }>
		)[0];
		expect(firstFragmentItem.contentOffset).toBe(0);
		expect(firstFragmentItem.content.length).toBeLessThanOrEqual(2_000);
		expect(firstFragmentItem.contentHasNext).toBe(true);
		expect(largeContent).toContain(firstFragmentItem.content);

		const secondFragment = readResult(
			await findTool(tools, "search_evidence").execute(
				"call",
				{
					agentId: "owner",
					sourceRef: item.sourceRef,
					offset: firstFragmentItem.contentOffset + firstFragmentItem.content.length,
					chunkSize: 2_000,
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		const secondFragmentItem = (secondFragment.items as Array<{ contentOffset: number }>)[0];
		expect(secondFragmentItem.contentOffset).toBe(firstFragmentItem.content.length);

		const entity = readResult(
			await findTool(tools, "get_entity").execute(
				"call",
				{ agentId: "owner", entityId: "e-large", include: ["aspects"] },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(entity.aspects).toHaveLength(50);
		expect(entity.aspectsTruncated).toBe(true);
		expect(
			(entity.entity as { proposalEvidence?: unknown[]; proposalEvidenceCount: number }).proposalEvidence,
		).toBeUndefined();
		expect((entity.entity as { proposalEvidenceCount: number }).proposalEvidenceCount).toBe(1);
		expect(JSON.stringify(entity).length).toBeLessThan(10_000);
	});

	it("search_evidence defaults since to the scope's evidence watermark when omitted (#1149)", async () => {
		// Regression for #1149: the scan-first listing used to anchor `since`
		// to pass-start (read off the runbook), so evidence captured between
		// the last watermark and pass start was never listed. An omitted
		// `since` must fall back to dreaming_state.last_pass_at — the
		// frontier the last pass actually surfaced — so the unprocessed
		// window is listed, and an explicit earlier `since` still reaches
		// older evidence.
		getDbAccessor().withWriteTx((db) => {
			db.prepare("INSERT INTO dreaming_state (agent_id, last_pass_at) VALUES (?, ?)").run(
				"owner",
				"2026-08-06T12:00:00.000Z",
			);
			for (const [id, content, createdAt] of [
				["mem-old", "Old evidence before the watermark.", "2026-08-06T11:00:00.000Z"],
				["mem-new", "New evidence after the watermark.", "2026-08-06T13:00:00.000Z"],
			] as const) {
				db.prepare(
					`INSERT INTO memories
					 (id, content, source_type, memory_kind, visibility, agent_id, created_at, updated_at)
					 VALUES (?, ?, 'manual', 'episodic', 'normal', 'owner', ?, ?)`,
				).run(id, content, createdAt, createdAt);
			}
		});
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });

		const listed = readResult(
			await findTool(tools, "search_evidence").execute(
				"call",
				{ agentId: "owner" }, // scan-first listing: omit query and since
				undefined,
				undefined,
				{} as never,
			),
		);
		const refs = (listed.items as Array<{ sourceRef: string }>).map((item) => item.sourceRef);
		expect(refs).toContain("memory:mem-new");
		expect(refs).not.toContain("memory:mem-old");

		const explicit = readResult(
			await findTool(tools, "search_evidence").execute(
				"call",
				{ agentId: "owner", since: "2026-08-06T10:00:00.000Z" },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect((explicit.items as Array<{ sourceRef: string }>).map((item) => item.sourceRef)).toEqual(
			expect.arrayContaining(["memory:mem-old", "memory:mem-new"]),
		);
	});

	it("search_evidence exposes completed on transcripts and settled records", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES ('run-live', 'intermediate investigation states', 'pi', null, 'owner',
				  '2026-08-07T06:14:00.000Z', '2026-08-07T06:30:00.000Z')`,
			).run();
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES ('run-done', 'settled outcome', 'pi', null, 'owner',
				  '2026-08-07T05:00:00.000Z', '2026-08-07T05:20:00.000Z')`,
			).run();
			db.prepare("UPDATE session_transcripts SET completed_at = ? WHERE session_key = 'run-done'").run(
				"2026-08-07T05:20:00.000Z",
			);
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES ('run-failed-summary', 'outcome despite summary timeout', 'pi', null, 'owner',
				  '2026-08-07T04:00:00.000Z', '2026-08-07T04:30:00.000Z')`,
			).run();
			db.prepare("UPDATE session_transcripts SET completed_at = ? WHERE session_key = 'run-failed-summary'").run(
				"2026-08-07T04:30:00.000Z",
			);
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES ('run-checkpoint', 'mid-session checkpointed states', 'pi', null, 'owner',
				  '2026-08-07T07:00:00.000Z', '2026-08-07T07:10:00.000Z')`,
			).run();
			// Session ended: summary job triggered and pending.
			db.prepare(
				`INSERT INTO summary_jobs
				 (id, session_key, session_id, harness, project, agent_id, transcript,
				  trigger, captured_at, started_at, ended_at, status, created_at)
				 VALUES ('job-done', 'run-done', 'run-done', 'pi', null, 'owner',
				  'settled outcome', 'session_end', '2026-08-07T05:20:00.000Z',
				  '2026-08-07T05:20:00.000Z', '2026-08-07T05:20:00.000Z', 'pending',
				  '2026-08-07T05:20:00.000Z')`,
			).run();
			// Session ended but the summary failed/timed out: still settled.
			db.prepare(
				`INSERT INTO summary_jobs
				 (id, session_key, session_id, harness, project, agent_id, transcript,
				  trigger, captured_at, started_at, ended_at, status, created_at)
				 VALUES ('job-failed', 'run-failed-summary', 'run-failed-summary', 'pi', null, 'owner',
				  'outcome despite summary timeout', 'session_end', '2026-08-07T04:30:00.000Z',
				  '2026-08-07T04:30:00.000Z', null, 'failed',
				  '2026-08-07T04:30:00.000Z')`,
			).run();
			// Mid-session checkpoint extract: not a session-end signal.
			db.prepare(
				`INSERT INTO summary_jobs
				 (id, session_key, session_id, harness, project, agent_id, transcript,
				  trigger, captured_at, started_at, ended_at, status, created_at)
				 VALUES ('job-checkpoint', 'run-checkpoint', 'run-checkpoint', 'pi', null, 'owner',
				  'mid-session checkpointed states', 'checkpoint_extract', '2026-08-07T07:10:00.000Z',
				  '2026-08-07T07:10:00.000Z', null, 'completed',
				  '2026-08-07T07:10:00.000Z')`,
			).run();
		});
		insertEpisodicMemory("mem-settled", "settled memory capture");

		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		const res = readResult(
			await findTool(tools, "search_evidence").execute(
				"call",
				{ agentId: "owner", limit: 10 },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(res.ok).toBe(true);
		const items = res.items as Array<{ sourceRef: string; completed: boolean }>;
		const byRef = new Map(items.map((item) => [item.sourceRef, item]));
		// A session-end job was triggered: settled, even while pending.
		expect(byRef.get("transcript:run-done")?.completed).toBe(true);
		// A still-running transcript is not delivered at all.
		expect(byRef.has("transcript:run-live")).toBe(false);
		// A failed/timed-out summary job still proves the session ended.
		expect(byRef.get("transcript:run-failed-summary")?.completed).toBe(true);
		// A mid-session checkpoint transcript is not delivered either.
		expect(byRef.has("transcript:run-checkpoint")).toBe(false);
		// Memories are settled captures by construction.
		expect(byRef.get("memory:mem-settled")?.completed).toBe(true);

		// The fragment paging path carries the same flag.
		const fragment = readResult(
			await findTool(tools, "search_evidence").execute(
				"call",
				{ agentId: "owner", sourceRef: "transcript:run-live", offset: 0, chunkSize: 500 },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(fragment.ok).toBe(false);
		expect(fragment.error).toContain("still in progress");
	});

	it("get_evidence resolves claim provenance and link provenance through one tool", async () => {
		insertEntity("e-atlas", "Atlas", "atlas", "owner");
		insertActiveAttribute("e-atlas", "a-config", "Feature is enabled by default.", "owner");
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });

		const claim = readResult(
			await findTool(tools, "get_evidence").execute(
				"call",
				{
					agentId: "owner",
					ref: { type: "claim", entity: "Atlas", aspect: "configuration", group: "configuration", claim: "default" },
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(claim.ok).toBe(true);

		const link = readResult(
			await findTool(tools, "get_evidence").execute(
				"call",
				{ agentId: "owner", ref: { type: "link", id: "missing-link" } },
				undefined,
				undefined,
				{} as never,
			),
		);
		// A missing link surfaces as a clean tool error, not a crash.
		expect(link.ok).toBe(false);
		expect(typeof link.error).toBe("string");
	});

	it("validate_proposal runs the label gate, duplicate check, and contradiction guard", async () => {
		insertEntity("e-atlas", "Atlas", "atlas", "owner");
		insertEntity("e-atlas-dup", "Atlas App", "atlas", "owner");
		insertActiveAttribute("e-atlas", "a-config", "Feature is enabled by default.", "owner");
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });

		const res = readResult(
			await findTool(tools, "validate_proposal").execute(
				"call",
				{
					agentId: "owner",
					name: "Atlas",
					entityId: "e-atlas",
					aspectId: "a-config",
					value: "Feature is disabled by default.",
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(res.ok).toBe(true);
		expect((res.label as { ok: boolean }).ok).toBe(true);
		expect((res.duplicates as Array<unknown>).length).toBeGreaterThan(0);
		const contradiction = res.contradiction as Array<{ detected: boolean }>;
		expect(contradiction.some((c) => c.detected)).toBe(true);
	});

	it("attention_list returns pending and resolved hygiene records", async () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk", "owner");
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		await findTool(tools, "apply_ontology_ops").execute(
			"call",
			{
				agentId: "owner",
				operations: [
					{
						operation: "flag",
						payload: { subjectRef: "entity:e-husk", details: { entityId: "e-husk", reason: "zero_active_attributes" } },
					},
				],
			},
			undefined,
			undefined,
			{} as never,
		);

		const pending = readResult(
			await findTool(tools, "attention_list").execute(
				"call",
				{ kind: "hygiene", status: "pending" },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(pending.ok).toBe(true);
		const items = pending.items as Array<{ subjectRef: string; kind: string }>;
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ subjectRef: "entity:e-husk", kind: "hygiene" });
	});

	it("attention_list exposes scoped expired and approaching temporal claims", async () => {
		const expiredAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const approachingAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		insertEntity("e-trip", "Trip", "trip", "owner");
		insertEpisodicMemory("mem-expired", "Trip was planned for yesterday.", "owner", expiredAt);
		insertEpisodicMemory("mem-approaching", "Trip is planned for tomorrow.", "owner", approachingAt);
		insertEpisodicMemory("mem-intruder", "Other agent's expired plan.", "intruder", expiredAt);
		insertActiveAttribute("e-trip", "a-trip", "Trip was planned for yesterday.", "owner", "plans", "mem-expired");
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });

		const result = readResult(
			await findTool(tools, "attention_list").execute(
				"call",
				{ agentId: "owner", kind: "review_due", status: "pending" },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(result.ok).toBe(true);
		const items = result.items as Array<{
			agentId: string;
			details: { phase: string; attributeId: string | null };
			subjectRef: string;
		}>;
		expect(items.map((item) => item.details.phase)).toEqual(["expired", "approaching"]);
		expect(items.every((item) => item.agentId === "owner")).toBe(true);
		expect(items[0]).toMatchObject({ subjectRef: "memory:mem-expired", details: { attributeId: "a-trip-attribute" } });
	});

	it("decline_attention resolves a pending flag and is one-use and scoped", async () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk", "owner");
		const tools = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "owner",
			actor: "owner",
			passId: "pass-1",
		});
		const minted = readResult(
			await findTool(tools, "apply_ontology_ops").execute(
				"call",
				{
					agentId: "owner",
					operations: [
						{
							operation: "flag",
							payload: {
								subjectRef: "entity:e-husk",
								details: { entityId: "e-husk", reason: "zero_active_attributes" },
							},
						},
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(minted.ok).toBe(true);
		const mintedItems = minted.items as Array<{ result?: { attentionId?: string } }>;
		const attentionId = mintedItems[0]?.result?.attentionId;
		if (attentionId === undefined) throw new Error("flag op did not surface an attention id");

		// Declining from another scope fails closed: the record is untouched.
		const otherScope = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "intruder",
			actor: "intruder",
			passId: "pass-1",
		});
		const crossScope = readResult(
			await findTool(otherScope, "apply_ontology_ops").execute(
				"call",
				{
					agentId: "intruder",
					operations: [{ operation: "decline_attention", payload: { attentionId } }],
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect((crossScope.items as Array<{ ok: boolean }>)[0]?.ok).toBe(false);
		const stillPending = readResult(
			await findTool(tools, "attention_list").execute(
				"call",
				{ kind: "hygiene", status: "pending" },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(stillPending.items as Array<unknown>).toHaveLength(1);

		// The owning scope declines it once: resolved.
		const declined = readResult(
			await findTool(tools, "apply_ontology_ops").execute(
				"call",
				{
					agentId: "owner",
					operations: [{ operation: "decline_attention", payload: { attentionId } }],
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(declined.ok).toBe(true);
		expect((declined.items as Array<{ ok: boolean }>)[0]?.ok).toBe(true);

		// A flag is one-use: a second decline of the same record is rejected.
		const twice = readResult(
			await findTool(tools, "apply_ontology_ops").execute(
				"call",
				{
					agentId: "owner",
					operations: [{ operation: "decline_attention", payload: { attentionId } }],
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect((twice.items as Array<{ ok: boolean }>)[0]?.ok).toBe(false);

		const resolved = readResult(
			await findTool(tools, "attention_list").execute(
				"call",
				{ kind: "hygiene", status: "resolved" },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(resolved.ok).toBe(true);
		expect(resolved.items as Array<unknown>).toHaveLength(1);
	});

	it("flags and archives a junk entity in one apply batch", async () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk", "owner");
		const tools = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "owner",
			actor: "owner",
			passId: "pass-1",
		});
		const apply = readResult(
			await findTool(tools, "apply_ontology_ops").execute(
				"call",
				{
					agentId: "owner",
					operations: [
						{
							operation: "flag",
							payload: {
								subjectRef: "entity:e-husk",
								details: { entityId: "e-husk", reason: "zero_active_attributes" },
							},
						},
						{ operation: "archive_entity", payload: { target: "e-husk" }, provenance: "attention:$0" },
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(apply.ok).toBe(true);
		expect((apply.items as Array<{ ok: boolean }>).every((item) => item.ok)).toBe(true);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entities WHERE id = ?").get("e-husk")),
		).toEqual({ status: "archived" });
	});

	it("rejects a content write whose quote is not an exact substring of a stored source", async () => {
		insertEpisodicMemory("mem-1", "Acme switched its deployment target to edge runtime in Q2.");
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		const apply = readResult(
			await findTool(tools, "apply_ontology_ops").execute(
				"call",
				{
					agentId: "owner",
					operations: [
						{
							operation: "create_entity",
							payload: { name: "Acme", type: "project" },
							evidence: [
								{
									source_ref: "memory:mem-1",
									source_kind: "manual",
									source_id: "mem-1",
									quote: "This quote was never shown to the agent.",
								},
							],
						},
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(apply.ok).toBe(false);
		expect(apply.error).toContain("exact quote");
	});

	it("reports each Pi capability input, output, and outcome to the pass trace", async () => {
		insertEntity("e-owner", "Owner Entity", "owner entity", "owner");
		const traces: Array<{ tool: string; input: unknown; output: { ok: boolean }; latencyMs: number }> = [];
		const tools = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "owner",
			actor: "owner",
			onToolCall(trace) {
				traces.push(trace);
			},
		});
		const search = findTool(tools, "search_entities");
		await search.execute("pi-call-1", { agentId: "owner", query: "owner" }, undefined, undefined, {} as never);

		expect(traces).toHaveLength(1);
		expect(traces[0]).toMatchObject({
			tool: "search_entities",
			input: { agentId: "owner", query: "owner" },
			output: { tool: "search_entities", ok: true },
		});
		expect(traces[0]?.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("get_entity returns null result for an entity owned by another agent", async () => {
		insertEntity("e-other", "Other Entity", "other entity", "intruder");

		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		const getEntity = findTool(tools, "get_entity");
		const res = readResult(
			await getEntity.execute("call", { agentId: "owner", entityId: "e-other" }, undefined, undefined, {} as never),
		);
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Entity not found");
	});
});
