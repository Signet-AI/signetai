import { getSyncDbAccessor } from "../legacy-sync/db-accessor-sync";
import { expect, test } from "bun:test";
import { compartmentFor, ensureCompartmentShards } from "@signet/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify } from "./classifications";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { ensureEmbeddingIndexState } from "./embedding-index-state";
import { getDbOwner } from "./db-owner-runtime";
import { constructContextBlocksViaOwner } from "./pipeline/context-construction";
import { handleUserPromptSubmit } from "./hooks";
import { loadMemoryConfig } from "./memory-config";
import { hybridRecall } from "./memory-search";
import { NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID } from "./native-memory-constants";
import { resolveReadScope, type ReadScope } from "./read-scope";

const timestamp = "2026-11-25T12:00:00.000Z";

test("hybrid recall and prompt injection cannot observe hidden corpus mutations", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-recall-noninterference-"));
	const previous = process.env.SIGNET_PATH;
	process.env.SIGNET_PATH = dir;
	try {
		mkdirSync(join(dir, "memory"));
		writeFileSync(
			join(dir, "agent.yaml"),
			"name: Noninterference\nembedding:\n  provider: none\nhooks:\n  userPromptSubmit:\n    minScore: 0\n",
		);
		initDbAccessor(join(dir, "memory", "memories.db"));
		const raw = loadMemoryConfig(dir);
		const config = {
			...raw,
			search: { ...raw.search, rehearsal_enabled: false, min_score: 0 },
			pipelineV2: {
				...raw.pipelineV2,
				graph: { ...raw.pipelineV2.graph, enabled: true },
				traversal: raw.pipelineV2.traversal ? { ...raw.pipelineV2.traversal, enabled: true } : undefined,
				reranker: { ...raw.pipelineV2.reranker, enabled: false },
				continuity: { ...raw.pipelineV2.continuity, enabled: false },
				feedback: { ...raw.pipelineV2.feedback, enabled: false },
			},
		};
		const vector = new Float32Array(Array.from({ length: config.embedding.dimensions }, (_, i) => (i === 0 ? 1 : 0)));
		const seed = (prefix: string, compartment: number | null) =>
			getSyncDbAccessor().withWriteTx((db) => {
				db.prepare(
					"INSERT INTO memories(id,content,type,agent_id,compartment_id,created_at,updated_at,updated_by,importance) VALUES (?,?,'fact','default',?,?,?,'test',0.8)",
				).run(`${prefix}-memory`, `Atlas deployment pipeline ${prefix} evidence`, compartment, timestamp, timestamp);
				db.prepare(
					"INSERT INTO memory_hints(id,memory_id,agent_id,hint,compartment_id,created_at) VALUES (?,?,'default',?,?,?)",
				).run(`${prefix}-hint`, `${prefix}-memory`, `Atlas deployment ${prefix} hint`, compartment, timestamp);
				db.prepare(
					"INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,compartment_id,mentions,created_at,updated_at) VALUES (?,?,?,'project','default',?,10,?,?)",
				).run(
					`${prefix}-entity`,
					prefix === "visible" ? "Atlas" : "Atlas classified",
					prefix === "visible" ? "atlas" : "atlas classified",
					compartment,
					timestamp,
					timestamp,
				);
				db.prepare(
					"INSERT INTO entity_aspects(id,entity_id,agent_id,name,canonical_name,weight,compartment_id,created_at,updated_at) VALUES (?,?,'default','deployment','deployment',0.9,?,?,?)",
				).run(`${prefix}-aspect`, `${prefix}-entity`, compartment, timestamp, timestamp);
				for (const linked of [true, false])
					db.prepare(
						"INSERT INTO entity_attributes(id,aspect_id,agent_id,memory_id,kind,content,normalized_content,confidence,importance,status,compartment_id,proposal_evidence,created_at,updated_at) VALUES (?,?,'default',?,'attribute',?,?,1,0.9,'active',?,?,?,?)",
					).run(
						`${prefix}-${linked ? "attribute" : "claim"}`,
						`${prefix}-aspect`,
						linked ? `${prefix}-memory` : null,
						`Atlas deployment pipeline ${prefix} claim`,
						`atlas deployment pipeline ${prefix} claim`,
						compartment,
						JSON.stringify([
							{
								source_kind: "memory",
								source_id: `${prefix}-memory`,
								quote: `Atlas deployment pipeline ${prefix} evidence`,
							},
						]),
						timestamp,
						timestamp,
					);
				db.prepare(
					"INSERT INTO memory_entity_mentions(memory_id,entity_id,mention_text,confidence,created_at) VALUES (?,?, 'Atlas',1,?)",
				).run(`${prefix}-memory`, `${prefix}-entity`, timestamp);
				db.prepare(
					"INSERT INTO session_transcripts(session_key,content,harness,agent_id,compartment_id,created_at,updated_at,completed_at) VALUES (?,?,'codex','default',?,?,?,?)",
				).run(
					`${prefix}-session`,
					`user: Atlas deployment pipeline ${prefix} transcript`,
					compartment,
					timestamp,
					timestamp,
					timestamp,
				);
				for (const kind of ["transcript", "native_memory"])
					db.prepare(
						"INSERT INTO memory_artifacts(agent_id,source_path,source_sha256,source_kind,session_id,session_key,session_token,harness,captured_at,content,updated_at,compartment_id,source_node_id) VALUES ('default',?,?,?,?,?,?,'codex',?,?,?,?,?)",
					).run(
						`${prefix}/${kind}.md`,
						`${prefix}-${kind}-hash`,
						kind,
						`${prefix}-session`,
						`${prefix}-session`,
						`${prefix}-token`,
						timestamp,
						`user: Atlas deployment pipeline ${prefix} ${kind} document`,
						timestamp,
						compartment,
						NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID,
					);
				db.prepare(
					"INSERT INTO embeddings(id,content_hash,vector,dimensions,source_type,source_id,chunk_text,created_at,agent_id,compartment_id) VALUES (?,?,?,?, 'memory',?,?,?,'default',?)",
				).run(
					`${prefix}-embedding`,
					`${prefix}-hash`,
					vector,
					vector.length,
					`${prefix}-memory`,
					`Atlas ${prefix}`,
					timestamp,
					compartment,
				);
				const table = compartment === null ? "vec_embeddings" : `vec_embeddings__c${compartment}`;
				db.prepare(`INSERT INTO ${table}(id,embedding) VALUES (?,?)`).run(`${prefix}-embedding`, vector);
			});
		getSyncDbAccessor().withWriteTx((db) => {
			db.exec(
				"INSERT INTO classifications(id,name) VALUES ('cls_recall_hr','Recall HR'),('cls_recall_legal','Recall legal'); INSERT INTO classification_audience VALUES ('cls_recall_hr','user','carol'),('cls_recall_legal','user','carol')",
			);
			ensureEmbeddingIndexState(db, config.embedding);
		});
		seed("visible", null);
		const outsider = await resolveReadScope(
			{ reach: { kind: "own", agentId: "default" }, projects: null },
			{ local: false, userId: "alice", groupIds: [] },
		);
		const recall = async (readScope: ReadScope) => {
			const response = await hybridRecall(
				{ query: "Atlas deployment pipeline", limit: 10, agentId: "default", readScope, trackRecallAccess: false },
				config,
				async () => Array.from(vector),
			);
			return {
				...response,
				results: response.results.map((row) =>
					row.source === "constructed" ? { ...row, created_at: undefined } : row,
				),
				meta: { ...response.meta, timings: undefined },
			};
		};
		let promptSequence = 0;
		const prompt = async (readScope: ReadScope) => {
			const response = await handleUserPromptSubmit(
				{
					harness: "codex",
					agentId: "default",
					sessionKey: `proof-${promptSequence++}`,
					userPrompt: "How does Atlas deploy its deployment pipeline?",
				},
				{
					now: () => Date.parse(timestamp),
					loadMemoryConfig: () => config,
					fetchEmbedding: async () => Array.from(vector),
					hybridRecall,
					appendSessionTranscriptAsync: async () => {},
					trackFtsHits: () => {},
				},
				{ readScope },
			);
			return { inject: response.inject, dynamicContext: response.dynamicContext, memoryCount: response.memoryCount };
		};
		const constructed = async () =>
			constructContextBlocksViaOwner(
				await getDbOwner(),
				"default",
				["visible-entity", "hidden-entity"],
				10,
				undefined,
				true,
				outsider,
			);
		const before = { recall: await recall(outsider), prompt: await prompt(outsider), constructed: await constructed() };
		expect(before.recall.results.map((r) => r.id)).toContain("visible-memory");
		expect(before.prompt.inject).toContain("visible");
		const compartment = getSyncDbAccessor().withWriteTx((db) => {
			const id = compartmentFor(db, ["cls_recall_hr"]);
			if (id === null) throw new Error("Missing fixture compartment");
			ensureCompartmentShards(db, id, vector.length);
			return id;
		});
		seed("hidden", compartment);
		const snapshot = async () => ({
			recall: await recall(outsider),
			prompt: await prompt(outsider),
			constructed: await constructed(),
		});
		expect(JSON.stringify(await snapshot())).toBe(JSON.stringify(before));
		getSyncDbAccessor().withWriteTx((db) => {
			for (const [table, key, column] of [
				["memories", "id", "content"],
				["memory_hints", "id", "hint"],
				["memory_artifacts", "source_path", "content"],
				["session_transcripts", "session_key", "content"],
				["entities", "id", "name"],
				["entity_attributes", "id", "content"],
			] as const)
				db.prepare(
					`UPDATE ${table} SET ${column}=${column}||' Atlas deployment altered secret' WHERE ${key} LIKE 'hidden%'`,
				).run();
			db.prepare("UPDATE embeddings SET vector=? WHERE id='hidden-embedding'").run(vector);
		});
		expect(JSON.stringify(await snapshot())).toBe(JSON.stringify(before));
		await classify({ kind: "memory", id: "hidden-memory", agentId: "default" }, "cls_recall_legal", {
			userId: "carol",
			groupIds: [],
			local: false,
			compliance: true,
			boundAgentId: null,
			allowedProjects: null,
			credential: "session:fixture",
		});
		expect(JSON.stringify(await snapshot())).toBe(JSON.stringify(before));
		const audience = await resolveReadScope(
			{ reach: { kind: "own", agentId: "default" }, projects: null },
			{ local: false, userId: "carol", groupIds: [] },
		);
		const audienceResults = (await recall(audience)).results;
		expect(audienceResults.map((r) => r.id)).toContain("hidden-memory");
		expect(audienceResults.map((r) => r.id)).toContain("ontology-claim:hidden-claim");
		expect(audienceResults.some((r) => r.source_path === "hidden/native_memory.md")).toBe(true);
		expect((await prompt(audience)).inject).toContain("hidden");
	} finally {
		await closeDbAccessor();
		if (previous === undefined) delete process.env.SIGNET_PATH;
		else process.env.SIGNET_PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}, 60000);
