import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compartmentFor, ensureCompartmentShards, type ReadScope } from "@signet/core";
import { normalizeAndHashContent } from "./content-normalization";
import { closeDbAccessor, getDbAccessor, initDbAccessor, type WriteDb } from "./db-accessor";
import { ensureEmbeddingIndexState } from "./embedding-index-state";
import { setFtsIndexIncomplete } from "./fts-index-state";
import { type ResolvedMemoryConfig, loadMemoryConfig } from "./memory-config";
import { type RecallParams, type RecallResponse, hybridRecall } from "./memory-search";
import { buildMemorySearchFilterClause } from "./memory-search-filters";
import { NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID } from "./native-memory-constants";
import { setActiveTelemetry } from "./telemetry";

const NOW = "2026-11-20T10:00:00.000Z";
const DIMS = 768;
const QUERY = "atlas deploy pipeline";

function axisVector(weights: Readonly<Record<number, number>>): number[] {
	const values = Array.from({ length: DIMS }, (_, index) => weights[index] ?? 0);
	const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
	return values.map((value) => value / norm);
}

function blob(values: readonly number[]): Buffer {
	return Buffer.from(new Float32Array(values).buffer);
}

function normalized(response: RecallResponse): unknown {
	const { timings: _timings, ...meta } = response.meta;
	return JSON.parse(JSON.stringify({ ...response, meta }));
}

const outsider = (): ReadScope => ({ reach: { kind: "all" }, compartments: [], projects: null });
const audience = (compartment: number): ReadScope => ({
	reach: { kind: "all" },
	compartments: [compartment],
	projects: null,
});

describe("hybridRecall read scope", () => {
	let dir = "";
	let prevSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-recall-scope-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "name: ScopeTest\n");
		prevSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"));
		setFtsIndexIncomplete(false);
	});

	afterEach(async () => {
		setActiveTelemetry(undefined);
		await closeDbAccessor();
		if (prevSignetPath === undefined) delete process.env.SIGNET_PATH;
		else process.env.SIGNET_PATH = prevSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	function cfg(graph: boolean): ResolvedMemoryConfig {
		const raw = loadMemoryConfig(dir);
		return {
			...raw,
			search: { ...raw.search, rehearsal_enabled: false, min_score: 0, temporal_prior_enabled: false },
			pipelineV2: {
				...raw.pipelineV2,
				hints: { ...raw.pipelineV2.hints, enabled: true },
				graph: { ...raw.pipelineV2.graph, enabled: graph, boostWeight: 0 },
				traversal: raw.pipelineV2.traversal ? { ...raw.pipelineV2.traversal, enabled: false } : undefined,
				reranker: { ...raw.pipelineV2.reranker, enabled: false },
			},
		};
	}

	async function knownProfile(): Promise<void> {
		const embedding = loadMemoryConfig(dir).embedding;
		await getDbAccessor().withWriteTxAsync((db) => ensureEmbeddingIndexState(db, embedding));
	}

	function memory(
		db: WriteDb,
		input: {
			readonly id: string;
			readonly content: string;
			readonly type?: string;
			readonly compartment?: number | null;
			readonly sourceId?: string | null;
			readonly project?: string | null;
		},
	): void {
		db.prepare(
			`INSERT INTO memories (id, content, type, agent_id, visibility, source_id, project, created_at, updated_at, updated_by, compartment_id)
			 VALUES (?, ?, ?, 'default', 'global', ?, ?, ?, ?, 'test', ?)`,
		).run(
			input.id,
			input.content,
			input.type ?? "fact",
			input.sourceId ?? null,
			input.project ?? null,
			NOW,
			NOW,
			input.compartment ?? null,
		);
	}

	function embedding(
		db: WriteDb,
		input: {
			readonly id: string;
			readonly sourceId: string;
			readonly sourceType: string;
			readonly vector: readonly number[];
			readonly compartment?: number | null;
			readonly chunkText?: string;
		},
	): void {
		db.prepare(
			`INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id, compartment_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'default', ?)`,
		).run(
			input.id,
			createHash("sha256").update(input.id).digest("hex"),
			blob(input.vector),
			DIMS,
			input.sourceType,
			input.sourceId,
			input.chunkText ?? input.sourceId,
			NOW,
			input.compartment ?? null,
		);
		const table = input.compartment ? `vec_embeddings__c${input.compartment}` : "vec_embeddings";
		db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ?)`).run(input.id, new Float32Array(input.vector));
	}

	function hint(db: WriteDb, id: string, memoryId: string, text: string, compartment: number | null = null): void {
		db.prepare(
			"INSERT INTO memory_hints (id, memory_id, agent_id, hint, created_at, compartment_id) VALUES (?, ?, 'default', ?, ?, ?)",
		).run(id, memoryId, text, NOW, compartment);
	}

	function transcriptArtifact(db: WriteDb, session: string, content: string, compartment: number | null = null): void {
		db.prepare(
			`INSERT INTO memory_artifacts (agent_id, source_path, source_sha256, source_kind, session_id, session_key, session_token,
				harness, captured_at, content, updated_at, is_deleted, compartment_id)
			 VALUES ('default', ?, ?, 'transcript', ?, ?, ?, 'claude-code', ?, ?, ?, 0, ?)`,
		).run(
			`transcripts/${session}.jsonl`,
			createHash("sha256").update(session).digest("hex"),
			session,
			session,
			`token-${session}`,
			NOW,
			content,
			NOW,
			compartment,
		);
	}

	function nativeArtifact(db: WriteDb, path: string, content: string, compartment: number | null = null): void {
		db.prepare(
			`INSERT INTO memory_artifacts (agent_id, source_path, source_sha256, source_kind, session_id, session_token, harness,
				captured_at, content, updated_at, is_deleted, source_node_id, compartment_id)
			 VALUES ('default', ?, ?, 'native_memory_registry', ?, ?, 'codex', ?, ?, ?, 0, ?, ?)`,
		).run(
			path,
			createHash("sha256").update(path).digest("hex"),
			`native-${path}`,
			`token-${path}`,
			NOW,
			content,
			NOW,
			NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID,
			compartment,
		);
	}

	function compartment(db: WriteDb, classification: string): number {
		db.prepare("INSERT OR IGNORE INTO classifications (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
			classification,
			classification,
			NOW,
			NOW,
		);
		const id = compartmentFor(db, [classification]);
		if (id === null) throw new Error("compartment missing");
		ensureCompartmentShards(db, id, DIMS);
		return id;
	}

	const queryVector = axisVector({ 0: 1 });

	function seedVisible(): void {
		getDbAccessor().withWriteTx((db) => {
			memory(db, { id: "vis-1", content: "atlas deploy pipeline rollout checklist for the platform team" });
			memory(db, { id: "vis-2", content: "atlas deploy pipeline incident review and follow ups" });
			memory(db, { id: "vis-3", content: "gardening schedule for the office plants" });
			embedding(db, { id: "emb-vis-1", sourceId: "vis-1", sourceType: "memory", vector: axisVector({ 0: 1, 1: 0.4 }) });
			embedding(db, { id: "emb-vis-2", sourceId: "vis-2", sourceType: "memory", vector: axisVector({ 0: 1, 2: 0.7 }) });
			hint(db, "hint-vis-3", "vis-3", "atlas deploy pipeline plants watering");
			transcriptArtifact(
				db,
				"vis-session",
				"user: how does the atlas deploy pipeline work? assistant: it ships nightly.",
			);
			nativeArtifact(db, "codex/memories/VISIBLE.md", "Codex notes: atlas deploy pipeline uses blue green slots.");
			embedding(db, {
				id: "emb-vis-chunk",
				sourceId: "obsidian:vault:visible.md#a:1-1:0",
				sourceType: "source_chunk",
				vector: axisVector({ 0: 1, 4: 0.9 }),
				chunkText: "source_path: /vault/visible.md\natlas deploy pipeline visible chunk",
			});
		});
	}

	function seedHidden(c: number, suffix = ""): void {
		getDbAccessor().withWriteTx((db) => {
			memory(db, {
				id: `hid-1${suffix}`,
				content: "atlas deploy pipeline secret merger plan atlas deploy pipeline",
				compartment: c,
			});
			embedding(db, {
				id: `emb-hid-1${suffix}`,
				sourceId: `hid-1${suffix}`,
				sourceType: "memory",
				vector: axisVector({ 0: 1, 3: 0.05 }),
				compartment: c,
			});
			hint(db, `hint-hid-vis${suffix}`, "vis-3", "atlas deploy pipeline merger codename", c);
			hint(db, `hint-hid-own${suffix}`, `hid-1${suffix}`, "atlas deploy pipeline merger", c);
			transcriptArtifact(
				db,
				`hid-session${suffix}`,
				"user: atlas deploy pipeline atlas deploy pipeline merger? assistant: confidential.",
				c,
			);
			nativeArtifact(
				db,
				`codex/memories/HIDDEN${suffix}.md`,
				"atlas deploy pipeline atlas deploy pipeline merger notes",
				c,
			);
			embedding(db, {
				id: `emb-hid-chunk${suffix}`,
				sourceId: `obsidian:vault:hidden${suffix}.md#a:1-1:0`,
				sourceType: "source_chunk",
				vector: axisVector({ 0: 1, 5: 0.05 }),
				compartment: c,
				chunkText: "source_path: /vault/hidden.md\natlas deploy pipeline hidden chunk",
			});
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, created_at, updated_at, compartment_id)
				 VALUES (?, 'Zephyrcorp', ?, 'organization', 'default', ?, ?, ?)`,
			).run(`ent-hid${suffix}`, `zephyrcorp${suffix}`, NOW, NOW, c);
			db.prepare(
				`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at, compartment_id)
				 VALUES (?, ?, 'default', 'status', ?, 0.5, ?, ?, ?)`,
			).run(`asp-hid${suffix}`, `ent-hid${suffix}`, `status${suffix}`, NOW, NOW, c);
			db.prepare(
				`INSERT INTO entity_attributes (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence,
					importance, status, created_at, updated_at, compartment_id)
				 VALUES (?, ?, 'default', 'vis-1', 'attribute', 'Zephyrcorp acquisition replaced the checklist', ?, 0.9, 0.9, 'superseded', ?, ?, ?)`,
			).run(`attr-hid${suffix}`, `asp-hid${suffix}`, `zephyrcorp acquisition${suffix}`, NOW, NOW, c);
		});
	}

	async function recall(scope: ReadScope, graph = false, extra: Partial<RecallParams> = {}): Promise<RecallResponse> {
		return await hybridRecall(
			{
				query: QUERY,
				keywordQuery: QUERY,
				limit: 10,
				agentId: "default",
				readPolicy: "isolated",
				trackRecallAccess: false,
				readScope: scope,
				...extra,
			},
			cfg(graph),
			async () => queryVector,
		);
	}

	it("never dedupes a readable artifact against a hidden content-hash mirror", async () => {
		const content = "atlas deploy pipeline public native mirror";
		await getDbAccessor().withWriteTxAsync((db) => {
			nativeArtifact(db, "hermes/public.md", content);
			db.prepare("UPDATE memory_artifacts SET harness='hermes-agent' WHERE source_path='hermes/public.md'").run();
		});
		const before = normalized(await recall(outsider(), false));
		expect(JSON.stringify(before)).toContain(content);
		await getDbAccessor().withWriteTxAsync((db) => {
			const classified = compartment(db, "cls_mirror");
			memory(db, { id: "hidden-mirror", content, compartment: classified });
			db.prepare("UPDATE memories SET source_type='hermes-memory-write',content_hash=? WHERE id='hidden-mirror'").run(
				normalizeAndHashContent(content).contentHash,
			);
			nativeArtifact(db, "hermes/hidden.md", content, classified);
			db.prepare(
				"UPDATE memory_artifacts SET harness='hermes-agent', source_sha256=(SELECT source_sha256 FROM memory_artifacts WHERE source_path='hermes/public.md') WHERE source_path='hermes/hidden.md'",
			).run();
		});
		expect(normalized(await recall(outsider(), false))).toEqual(before);
	});

	it("returns identical recall to an outsider before and after hidden inserts, updates and reclassification", async () => {
		await knownProfile();
		seedVisible();
		const baseline = normalized(await recall(outsider()));
		expect(JSON.stringify(baseline)).toContain("vis-1");

		let c = 0;
		let c2 = 0;
		getDbAccessor().withWriteTx((db) => {
			c = compartment(db, "cls_hr");
			c2 = compartment(db, "cls_legal");
		});
		seedHidden(c);
		expect(normalized(await recall(outsider()))).toEqual(baseline);

		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET content = ? WHERE id = 'hid-1'").run("atlas deploy pipeline atlas atlas deploy");
			db.prepare("UPDATE memory_hints SET hint = ? WHERE id = 'hint-hid-vis'").run("atlas deploy pipeline atlas");
		});
		expect(normalized(await recall(outsider()))).toEqual(baseline);

		getDbAccessor().withWriteTx((db) => {
			for (const table of [
				"memories",
				"memory_hints",
				"memory_artifacts",
				"entities",
				"entity_aspects",
				"entity_attributes",
			])
				db.prepare(`UPDATE ${table} SET compartment_id = ? WHERE compartment_id = ?`).run(c2, c);
			for (const id of ["emb-hid-1", "emb-hid-chunk"]) {
				const row = db.prepare(`SELECT embedding FROM vec_embeddings__c${c} WHERE id = ?`).get(id);
				db.prepare(`DELETE FROM vec_embeddings__c${c} WHERE id = ?`).run(id);
				db.prepare(`INSERT INTO vec_embeddings__c${c2} (id, embedding) VALUES (?, ?)`).run(id, row?.embedding);
				db.prepare("UPDATE embeddings SET compartment_id = ? WHERE id = ?").run(c2, id);
			}
		});
		expect(normalized(await recall(outsider()))).toEqual(baseline);
	});

	it("lets the audience recall hidden memories, hints, artifacts, transcripts and source chunks from shards", async () => {
		await knownProfile();
		seedVisible();
		let c = 0;
		getDbAccessor().withWriteTx((db) => {
			c = compartment(db, "cls_hr");
		});
		seedHidden(c);
		const response = await recall(audience(c));
		const ids = response.results.map((row) => row.id);
		expect(ids[0]).toBe("hid-1");
		expect(ids).toContain("vis-3");
		const outside = await recall(outsider());
		expect(outside.results.map((row) => row.id)).not.toContain("hid-1");

		const sourceOnly = await recall(audience(c), false, { sourceOnly: true });
		const sourceIds = sourceOnly.results.map((row) => row.source_path ?? row.id);
		expect(sourceIds).toContain("/vault/hidden.md");
		expect(sourceIds).toContain(`codex/memories/HIDDEN.md`);

		const visibleOnly = await recall(outsider(), false, { sourceOnly: true });
		const visibleSources = visibleOnly.results.map((row) => row.source_path ?? row.id);
		expect(visibleSources).toContain("/vault/visible.md");
		expect(visibleSources).not.toContain("/vault/hidden.md");
		expect(visibleSources).not.toContain("codex/memories/HIDDEN.md");

		const transcripts = await recall(audience(c), false, {
			limit: 3,
			query: "merger confidential",
			keywordQuery: "merger confidential",
		});
		expect(transcripts.results.some((row) => row.id === "transcript:hid-session")).toBe(true);
		const hiddenTranscripts = await recall(outsider(), false, {
			limit: 3,
			query: "merger confidential",
			keywordQuery: "merger confidential",
		});
		expect(hiddenTranscripts.results.some((row) => row.id.startsWith("transcript:hid"))).toBe(false);
		expect(JSON.stringify(hiddenTranscripts.results)).not.toContain("confidential");
	});

	it("keeps graph dampening, currentness and rationale linking blind to hidden evidence", async () => {
		await knownProfile();
		seedVisible();
		getDbAccessor().withWriteTx((db) => {
			memory(db, { id: "vis-dec", content: "atlas deploy pipeline decision to freeze releases", type: "decision" });
			memory(db, { id: "vis-rat", content: "rationale: freezes reduce weekend incidents", type: "rationale" });
			const entity = db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'concept', 'default', ?, ?)`,
			);
			entity.run("ent-e1", "Quokka", "quokka", NOW, NOW);
			entity.run("ent-e2", "Wombat", "wombat", NOW, NOW);
			const mention = db.prepare("INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES (?, ?)");
			mention.run("vis-1", "ent-e1");
			mention.run("vis-2", "ent-e2");
		});
		const baseline = normalized(await recall(outsider(), true));

		let c = 0;
		getDbAccessor().withWriteTx((db) => {
			c = compartment(db, "cls_hr");
		});
		seedHidden(c);
		getDbAccessor().withWriteTx((db) => {
			const mention = db.prepare("INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES (?, ?)");
			for (let index = 0; index < 4; index++) {
				memory(db, { id: `hid-hub-${index}`, content: `quiet archived note ${index}`, compartment: c });
				mention.run(`hid-hub-${index}`, "ent-e1");
			}
			mention.run("vis-dec", "ent-hid");
			mention.run("vis-rat", "ent-hid");
			mention.run("vis-2", "ent-hid");
		});
		expect(normalized(await recall(outsider(), true))).toEqual(baseline);
	});

	it("builds the memory filter from a provided read scope instead of the local agent policy", () => {
		const scoped = buildMemorySearchFilterClause({ agentId: "default", readPolicy: "shared", readScope: outsider() });
		expect(scoped.sql).toContain("m.compartment_id IS NULL");
		expect(scoped.sql).toContain("SELECT id FROM agents WHERE archived_at IS NULL");
		expect(scoped.sql).not.toContain("m.visibility = 'global'");
		const local = buildMemorySearchFilterClause({ agentId: "agent-a", readPolicy: "shared" });
		expect(local.sql).toContain("(m.visibility = 'global' OR m.agent_id = ?)");
		expect(local.args).toContain("agent-a");
	});

	it("hides rows under an in-flight classification from non-audience callers", async () => {
		await knownProfile();
		seedVisible();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO classifications (id, name, created_at, updated_at) VALUES ('cls_inflight', 'HR', ?, ?)",
			).run(NOW, NOW);
			db.prepare(
				"INSERT INTO classification_audience (classification_id, principal_kind, principal_id) VALUES ('cls_inflight', 'user', 'alice')",
			).run();
			memory(db, { id: "inflight-1", content: "atlas deploy pipeline inflight secret", sourceId: "inflight-session" });
			transcriptArtifact(db, "inflight-session", "user: atlas deploy pipeline inflight secret? assistant: sealed.");
			db.prepare(
				`INSERT INTO org_jobs (id, kind, status, params_json, created_at)
				 VALUES ('job_inflight', 'classify', 'pending', ?, ?)`,
			).run(
				JSON.stringify({ id: "cls_inflight", target: { kind: "session", id: "inflight-session", agentId: "default" } }),
				NOW,
			);
		});
		const scope: ReadScope = { ...outsider(), inFlightUserId: "bob" };
		const response = await recall(scope, false, {
			query: "inflight secret sealed",
			keywordQuery: "inflight secret sealed",
		});
		expect(JSON.stringify(response.results)).not.toContain("inflight");
		expect(JSON.stringify(response.results)).not.toContain("sealed");
		const allowed = await recall({ ...outsider(), inFlightUserId: "alice" }, false, {
			query: "inflight secret sealed",
			keywordQuery: "inflight secret sealed",
		});
		expect(allowed.results.map((row) => row.id)).toContain("transcript:inflight-session");
	});
});
