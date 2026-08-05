import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { createDreamingAgentTools } from "./dreaming-agent-tools";
import { DREAMING_CAPABILITY_IDS } from "./dreaming-capabilities";

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

	function insertEntity(id: string, name: string, canonicalName: string, agentId = "owner"): void {
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

	function insertEpisodicMemory(id: string, content: string, agentId = "owner"): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories
				 (id, content, source_type, memory_kind, visibility, agent_id, created_at, updated_at)
				 VALUES (?, ?, 'manual', 'episodic', 'normal', ?, datetime('now'), datetime('now'))`,
			).run(id, content, agentId);
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

	function findTool(tools: readonly ReturnType<typeof createDreamingAgentTools>, name: string) {
		const tool = tools.find((t) => t.name === name);
		if (!tool) throw new Error(`tool ${name} not registered`);
		return tool;
	}

	it("derives Pi tools and public metadata from the same capability registry", () => {
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		expect(tools.map((tool) => tool.name)).toEqual([...DREAMING_CAPABILITY_IDS]);
		expect(tools).toHaveLength(11);
	});

	it("isolates reads by agentId: search_entities only returns the caller's entities", async () => {
		insertEntity("e-owner", "Owner Entity", "owner entity", "owner");
		insertEntity("e-other", "Other Entity", "other entity", "intruder");

		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		const search = findTool(tools, "search_entities");
		const res = readResult(await search.execute("call", { agentId: "owner", query: "entity" }, undefined, undefined, {} as never));
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
			await findTool(tools, "get_entity").execute("call", { agentId: "owner", entityId: "e-atlas" }, undefined, undefined, {} as never),
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

	it("get_evidence resolves claim provenance and link provenance through one tool", async () => {
		insertEntity("e-atlas", "Atlas", "atlas", "owner");
		insertActiveAttribute("e-atlas", "a-config", "Feature is enabled by default.", "owner");
		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });

		const claim = readResult(
			await findTool(tools, "get_evidence").execute(
				"call",
				{ agentId: "owner", ref: { type: "claim", entity: "Atlas", aspect: "configuration", group: "configuration", claim: "default" } },
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
				{ agentId: "owner", name: "Atlas", entityId: "e-atlas", aspectId: "a-config", value: "Feature is disabled by default." },
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
		expect(traces[0]!.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("get_entity returns null result for an entity owned by another agent", async () => {
		insertEntity("e-other", "Other Entity", "other entity", "intruder");

		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		const getEntity = findTool(tools, "get_entity");
		const res = readResult(await getEntity.execute("call", { agentId: "owner", entityId: "e-other" }, undefined, undefined, {} as never));
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Entity not found");
	});
});
