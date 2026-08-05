import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ONTOLOGY_PROPOSAL_OPERATIONS } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { createDreamingAgentTools } from "./dreaming-agent-tools";
import { DREAMING_CAPABILITY_IDS, getDreamingCapabilityManifest } from "./dreaming-capabilities";
import type { DreamingAgentEvidence } from "./dreaming-evidence";

/**
 * Regression coverage for the daemon-owned conceptual ontology tool factory
 * (#946). These tests pin four contracts:
 *  - agent isolation: tools scoped to one agentId cannot see another agent's graph
 *  - citation rejection: quotes that are not exact substrings of supplied evidence are rejected
 *  - per-op isolation: one failing op rolls back only itself inside the caller-owned tx
 *
 * No assertions are made about new feature quality — these pin the named
 * agent-isolation, vocabulary, citation, and transactional invariants.
 */
describe("dreaming-agent-tools", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-dreaming-agent-tools-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	function insertEntity(id: string, name: string, canonicalName: string, agentId: string): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', ?, 1, 0, '2026-05-06T00:00:00.000Z', '2026-05-06T00:00:00.000Z')`,
			).run(id, name, canonicalName, agentId);
		});
	}

	function insertActiveAttribute(entityId: string, aspectId: string, content: string, agentId: string): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES (?, ?, ?, 'configuration', 'configuration', 0.5, datetime('now'), datetime('now'))`,
			).run(aspectId, entityId, agentId);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content,
				  confidence, importance, status, group_key, claim_key,
				  version, version_root_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'attribute', ?, ?, 0.8, 0.5, 'active', 'configuration', 'default', 1, ?, datetime('now'), datetime('now'))`,
			).run(`${aspectId}-attribute`, aspectId, agentId, content, content.toLowerCase(), `${aspectId}-attribute`);
		});
	}

	const EVIDENCE_CONTENT = "Acme switched its deployment target to edge runtime in Q2.";
	const CITATION = {
		source_ref: "transcript:acme-q2",
		source_kind: "transcript",
		source_id: "acme-q2",
		quote: EVIDENCE_CONTENT,
	};
	const evidence: readonly DreamingAgentEvidence[] = [
		{
			sourceRef: "transcript:acme-q2",
			content: EVIDENCE_CONTENT,
			sourceKind: "transcript",
			sourceId: "acme-q2",
			sourcePath: null,
			sourceEntryId: null,
		},
	];

	function readResult(res: { readonly content: ReadonlyArray<{ readonly text: string }> }): {
		readonly tool: string;
		readonly ok: boolean;
		readonly [key: string]: unknown;
	} {
		return JSON.parse(res.content[0]!.text);
	}

	function findTool(tools: readonly ReturnType<typeof createDreamingAgentTools>, name: string) {
		const tool = tools.find((t) => t.name === name);
		if (!tool) throw new Error(`tool ${name} not registered`);
		return tool;
	}

	it("derives Pi tools and public metadata from the same capability registry", () => {
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		expect(tools.map((tool) => tool.name)).toEqual([...DREAMING_CAPABILITY_IDS]);
		expect(getDreamingCapabilityManifest().map((capability) => capability.id)).toEqual([...DREAMING_CAPABILITY_IDS]);
	});

	it("publishes the complete ontology operation vocabulary and payload fields to agents", () => {
		const manifest = getDreamingCapabilityManifest().find((capability) => capability.id === "apply_ontology_ops");
		expect(manifest).toBeDefined();
		const schema = JSON.stringify(manifest!.inputSchema);
		for (const operation of ONTOLOGY_PROPOSAL_OPERATIONS) {
			expect(schema).toContain(operation);
		}
		for (const requiredField of ["new_name", "claim_key", "link_type", "source_entity", "target_entity"]) {
			expect(schema).toContain(requiredField);
		}
	});

	it("isolates reads by agentId: search_entities only returns the caller's entities", async () => {
		insertEntity("e-owner", "Owner Entity", "owner entity", "owner");
		insertEntity("e-other", "Other Entity", "other entity", "intruder");

		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		const search = findTool(tools, "search_entities");
		const res = readResult(await search.execute("call", { query: "entity" }, undefined, undefined, {} as never));
		expect(res.ok).toBe(true);
		const items = res.items as Array<{ id: string; name: string }>;
		expect(items.map((i) => i.id)).toEqual(["e-owner"]);
		expect(items.some((i) => i.id === "e-other")).toBe(false);
	});

	it("exposes shared deterministic guards without writing semantic state", async () => {
		insertEntity("e-atlas", "Atlas", "atlas", "owner");
		insertEntity("e-atlas-duplicate", "Atlas App", "atlas", "owner");
		insertEntity("e-other-atlas", "Atlas Elsewhere", "atlas", "intruder");
		insertActiveAttribute("e-atlas", "a-configuration", "Feature is enabled by default.", "owner");
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });

		const label = readResult(
			await findTool(tools, "check_entity_label").execute(
				"label",
				{ name: "Status" },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(label).toMatchObject({
			tool: "check_entity_label",
			ok: true,
			result: { ok: false, reason: "generic_or_scaffolding_name" },
		});

		const duplicates = readResult(
			await findTool(tools, "find_duplicate_entities").execute(
				"duplicates",
				{ name: "Atlas" },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(duplicates).toMatchObject({ tool: "find_duplicate_entities", ok: true });
		expect((duplicates.items as Array<{ target: { id: string }; sources: Array<{ id: string }> }>)[0]).toMatchObject({
			target: { id: "e-atlas" },
			sources: [{ id: "e-atlas-duplicate" }],
		});

		const contradiction = readResult(
			await findTool(tools, "check_contradiction").execute(
				"contradiction",
				{ entityId: "e-atlas", aspectId: "a-configuration", value: "Feature is disabled by default." },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(contradiction).toMatchObject({ tool: "check_contradiction", ok: true });
		expect((contradiction.items as Array<{ detected: boolean; reason: string }>)[0]).toMatchObject({
			detected: true,
			reason: "antonym_conflict",
		});
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
		await search.execute("pi-call-1", { query: "owner" }, undefined, undefined, {} as never);

		expect(traces).toHaveLength(1);
		expect(traces[0]).toMatchObject({
			tool: "search_entities",
			input: { query: "owner" },
			output: { tool: "search_entities", ok: true },
		});
		expect(traces[0]!.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("get_entity returns null result for an entity owned by another agent", async () => {
		insertEntity("e-other", "Other Entity", "other entity", "intruder");

		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		const getEntity = findTool(tools, "get_entity");
		const res = readResult(await getEntity.execute("call", { entityId: "e-other" }, undefined, undefined, {} as never));
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Entity not found");
	});

	it("rejects an unsupported operation before touching the graph", async () => {
		const tools = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "ant",
			actor: "ant",
			evidence,
		});
		const apply = findTool(tools, "apply_ontology_ops");
		const res = readResult(
			await apply.execute(
				"call",
				{
					operations: [
						{
							operation: "drop_everything",
							payload: {},
							reason: "malicious",
							evidence: [CITATION],
						},
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("Invalid discriminator value");
		const count = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ?").get("ant") as { count: number },
		);
		expect(count.count).toBe(0);
	});

	it("rejects malformed payloads before asking the caller to supply citations", async () => {
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "ant", actor: "ant", evidence });
		const apply = findTool(tools, "apply_ontology_ops");
		const res = readResult(
			await apply.execute(
				"call",
				{ operations: [{ operation: "rename_entity", payload: { entity: "Acme" }, evidence: [CITATION] }] },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("new_name");
	});

	it("rejects citations whose quote is not an exact substring of supplied evidence", async () => {
		const tools = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "ant",
			actor: "ant",
			evidence,
		});
		const apply = findTool(tools, "apply_ontology_ops");
		const res = readResult(
			await apply.execute(
				"call",
				{
					operations: [
						{
							operation: "create_entity",
							payload: { name: "Fabricated" },
							reason: "hallucinated evidence",
							evidence: [{ ...CITATION, quote: "This quote was never shown to the agent." }],
						},
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("exact quote");
	});

	it("rejects operations when no evidence is supplied to the session", async () => {
		const tools = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "ant",
			actor: "ant",
			// no evidence array
		});
		const apply = findTool(tools, "apply_ontology_ops");
		const res = readResult(
			await apply.execute(
				"call",
				{
					operations: [
						{
							operation: "create_entity",
							payload: { name: "No Evidence" },
							reason: "none",
							evidence: [CITATION],
						},
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(res.ok).toBe(false);
	});

	it("provides per-op isolation: one failing op rolls back only itself while valid ops apply", async () => {
		// Regression: per-op SAVEPOINT isolation. The second op targets a
		// missing entity and must fail, but the first (create_entity) and
		// third (another create_entity) must still commit inside the same
		// caller-owned transaction.
		const tools = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "ant",
			actor: "ant",
			evidence,
		});
		const apply = findTool(tools, "apply_ontology_ops");

		const res = readResult(
			await apply.execute(
				"call",
				{
					operations: [
						{
							operation: "create_entity",
							payload: { name: "First Entity", entity_type: "project" },
							reason: "valid first op",
							evidence: [CITATION],
						},
						{
							// update_link against a non-existent dependency id throws
							// "Link not found" (404), exercising per-op rollback.
							operation: "update_link",
							payload: { id: "link-does-not-exist", link_type: "related_to", reason: "missing" },
							reason: "will fail",
							evidence: [CITATION],
						},
						{
							operation: "create_entity",
							payload: { name: "Third Entity", entity_type: "project" },
							reason: "valid third op",
							evidence: [CITATION],
						},
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		);

		expect(res.ok).toBe(true);
		const items = res.items as Array<{ index: number; ok: boolean; error?: string }>;
		expect(items).toHaveLength(3);
		expect(items[0]!.ok).toBe(true);
		expect(items[1]!.ok).toBe(false);
		expect(typeof items[1]!.error).toBe("string");
		expect(items[2]!.ok).toBe(true);

		// The valid ops committed despite the middle failure.
		const names = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT name FROM entities WHERE agent_id = ? ORDER BY name ASC").all("ant") as Array<{
					name: string;
				}>,
		);
		const nameSet = new Set(names.map((n) => n.name));
		expect(nameSet.has("First Entity")).toBe(true);
		expect(nameSet.has("Third Entity")).toBe(true);
	});

	it("returns JSON tool results and does not truncate create_entity output", async () => {
		const tools = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "ant",
			actor: "ant",
			evidence,
		});
		const apply = findTool(tools, "apply_ontology_ops");
		const res = await apply.execute(
			"call",
			{
				operations: [
					{
						operation: "create_entity",
						payload: { name: "Full Output Entity", entity_type: "project" },
						reason: "verify full JSON result",
						evidence: [CITATION],
					},
				],
			},
			undefined,
			undefined,
			{} as never,
		);
		// Result must be a single JSON text content block (no truncation markers).
		expect(res.content).toHaveLength(1);
		expect(res.content[0]!.type).toBe("text");
		const parsed = JSON.parse(res.content[0]!.text);
		expect(parsed.tool).toBe("apply_ontology_ops");
		expect(parsed.ok).toBe(true);
		expect(parsed.items[0].result.entityId).toBeDefined();
	});

	it("records hygiene attention and archives the flagged entity with its returned id", async () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk", "owner");
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner", evidence });

		const record = readResult(
			await findTool(tools, "record_hygiene_attention").execute(
				"record",
				{ subjectRef: "entity:e-husk", details: { entityId: "e-husk", reason: "zero_active_attributes" } },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(record).toMatchObject({
			tool: "record_hygiene_attention",
			ok: true,
			subjectRef: "entity:e-husk",
			kind: "hygiene",
		});
		const attentionId = record.id as string;
		expect(typeof attentionId).toBe("string");
		expect(attentionId.length).toBeGreaterThan(0);

		// Re-recording the same flagged target returns the same id (upsert keeps the original row).
		const again = readResult(
			await findTool(tools, "record_hygiene_attention").execute(
				"record",
				{
					subjectRef: "entity:e-husk",
					details: { entityId: "e-husk", reason: "zero_active_attributes", note: "rechecked" },
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(again.ok).toBe(true);
		expect(again.id).toBe(attentionId);

		// The returned id is citable provenance for the hygiene archive, no episodic quote needed.
		const apply = readResult(
			await findTool(tools, "apply_ontology_ops").execute(
				"apply",
				{
					operations: [
						{
							operation: "archive_entity",
							payload: { entity_id: "e-husk", reason: "Zero active attributes; non-concrete entity." },
							provenance: `attention:${attentionId}`,
						},
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(apply.ok).toBe(true);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entities WHERE id = ?").get("e-husk")),
		).toEqual({ status: "archived" });
		const evidenceRow = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT evidence FROM ontology_proposals WHERE agent_id = ?").get("owner") as { evidence: string },
		);
		expect(evidenceRow.evidence).toContain(`attention:${attentionId}`);
	});

	it("rejects an archive whose attention record names a different target", async () => {
		insertEntity("e-flagged", "Flagged", "flagged", "owner");
		insertEntity("e-unrelated", "Unrelated", "unrelated", "owner");
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner", evidence });

		const record = readResult(
			await findTool(tools, "record_hygiene_attention").execute(
				"record",
				{ subjectRef: "entity:e-flagged", details: { entityId: "e-flagged", reason: "zero_active_attributes" } },
				undefined,
				undefined,
				{} as never,
			),
		);
		const attentionId = record.id as string;

		const apply = readResult(
			await findTool(tools, "apply_ontology_ops").execute(
				"apply",
				{
					operations: [
						{
							operation: "archive_entity",
							payload: { entity_id: "e-unrelated" },
							provenance: `attention:${attentionId}`,
						},
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(apply.ok).toBe(false);
		expect(apply.error).toBe("Every operation must cite an exact quote from scoped episodic evidence");
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entities WHERE id = ?").get("e-unrelated")),
		).toEqual({ status: "active" });
	});

	it("rejects hygiene attention records without a valid subjectRef or target details", async () => {
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner", evidence });

		const badPrefix = readResult(
			await findTool(tools, "record_hygiene_attention").execute(
				"record",
				{ subjectRef: "bogus:1", details: { entityId: "e-husk" } },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(badPrefix.ok).toBe(false);
		expect(badPrefix.error).toContain("subjectRef must start with");

		const missingDetails = readResult(
			await findTool(tools, "record_hygiene_attention").execute(
				"record",
				{ subjectRef: "entity:e-husk", details: { reason: "zero_active_attributes" } },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(missingDetails.ok).toBe(false);
		expect(missingDetails.error).toContain("entityId");
	});
});
