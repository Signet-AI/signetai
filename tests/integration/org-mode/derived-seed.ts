import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	addObsidianSource,
	loadSourcesConfig,
	saveSourcesConfig,
	findSqliteVecExtension,
} from "../../../platform/core/dist/index";
import { record, text } from "./http";

export interface DerivedSeed {
	workspace: string;
	root: string;
	agentId: string;
	userId: string;
	entityId: string;
	attributeId: string;
	memoryId: string;
	publicMemoryIds: string[];
	hiddenMemoryIds: string[];
	sessionKey: string;
	marker: string;
	generation: number;
}
export function seedDerived(input: DerivedSeed) {
	assert.equal(process.env.SIGNET_PATH, input.workspace, "Offline seed must use the isolated workspace");
	assert(input.workspace.startsWith(`${input.root}/`));
	const db = new Database(join(input.workspace, "data/signet.db"));
	db.exec("PRAGMA foreign_keys=ON");
	const extension = findSqliteVecExtension();
	assert(extension, "sqlite-vec is required to exercise vector non-interference");
	db.loadExtension(extension);
	const memory = record(
		db.query("SELECT compartment_id FROM memories WHERE id = ? AND agent_id = ?").get(input.memoryId, input.agentId),
	);
	assert(
		typeof memory.compartment_id === "number" &&
			Number.isSafeInteger(memory.compartment_id) &&
			memory.compartment_id > 0,
		"Classification fixture must assign HR compartment before derived-read seeding",
	);
	const compartment = memory.compartment_id;
	const now = new Date().toISOString();
	const date = now.slice(0, 10);
	const content = `${input.marker} seeded derived-read fixture generation ${input.generation}`;
	const passId = "org-hr-pass";
	const summaryId = "org-hr-summary";
	const documentId = "org-hr-document";
	const reflectionId = "org-hr-reflection";
	const sourceRoot = join(input.root, input.marker);
	mkdirSync(sourceRoot, { recursive: true });
	const source = addObsidianSource({ root: sourceRoot, name: input.marker }, input.workspace);
	assert(source.ok, "Failed to configure isolated managed source");
	const config = loadSourcesConfig(input.workspace);
	saveSourcesConfig(
		{
			...config,
			sources: config.sources.map((entry) => (entry.id === source.source.id ? { ...entry, enabled: false } : entry)),
		},
		input.workspace,
	);
	const sourcePath = join(sourceRoot, "read-fixture.md");
	writeFileSync(sourcePath, content);
	db.transaction(() => {
		db.query(
			`INSERT INTO memory_artifacts(source_path,source_sha256,source_kind,source_id,content,agent_id,compartment_id,captured_at,updated_at,author_user_id)
			 VALUES(?,?,'file',?,?,?,?,?,?,?)
			 ON CONFLICT(agent_id,source_path) DO UPDATE SET source_sha256=excluded.source_sha256,source_id=excluded.source_id,
			 content=excluded.content,compartment_id=excluded.compartment_id,updated_at=excluded.updated_at,author_user_id=excluded.author_user_id`,
		).run(
			sourcePath,
			createHash("sha256").update(content).digest("hex"),
			source.source.id,
			content,
			input.agentId,
			compartment,
			now,
			now,
			input.userId,
		);
		db.query(
			"INSERT OR REPLACE INTO entity_communities (id,agent_id,name,member_count,compartment_id) VALUES (?,?,?,1,?)",
		).run("org-hr-community", input.agentId, content, compartment);
		db.query("UPDATE entities SET community_id=? WHERE id=? AND agent_id=?").run(
			"org-hr-community",
			input.entityId,
			input.agentId,
		);
		db.query(
			"INSERT OR REPLACE INTO epistemic_assertions (id,agent_id,subject_entity_id,claim_attribute_id,predicate,content,normalized_content,asserted_at,compartment_id) VALUES (?,?,?,?,'claims',?,?,?,?)",
		).run(
			"org-hr-assertion",
			input.agentId,
			input.entityId,
			input.attributeId,
			content,
			content.toLowerCase(),
			now,
			compartment,
		);
		db.query(
			"INSERT OR REPLACE INTO evidence_citations (derived_kind,derived_id,agent_id,evidence_kind,evidence_id) VALUES ('assertion',?,? ,'memory',?)",
		).run("org-hr-assertion", input.agentId, input.memoryId);
		db.query(
			"INSERT OR REPLACE INTO session_summaries (id,project,kind,content,earliest_at,latest_at,session_key,harness,agent_id,created_at,compartment_id) VALUES (?,'atlas','session',?,?,?,?, 'codex',?,?,?)",
		).run(summaryId, content, now, now, input.sessionKey, input.agentId, now, compartment);
		db.query(
			"INSERT OR REPLACE INTO daily_reflections (id,agent_id,date,summary,memory_ids,created_at,compartment_id) VALUES (?,?,?,?,?,?,?)",
		).run(reflectionId, input.agentId, date, content, JSON.stringify([input.memoryId]), now, compartment);
		db.query(
			"INSERT OR REPLACE INTO dreaming_passes (id,agent_id,mode,status,summary,scope_key,runbook_json,mutations_applied,tokens_consumed,compartment_id) VALUES (?,?,'incremental','running',?,?,?,?,?,?)",
		).run(
			passId,
			input.agentId,
			content,
			input.agentId,
			JSON.stringify({ summary: content, openQuestions: [], deferred: [] }),
			input.generation + 1,
			100 + input.generation,
			compartment,
		);
		db.query(
			"INSERT OR REPLACE INTO dreaming_tool_calls (id,agent_id,pass_id,sequence,tool_name,input_json,output_json,success,latency_ms,compartment_id) VALUES (?,?,?,0,'search_evidence','{}',?,1,1,?)",
		).run("org-hr-tool", input.agentId, passId, JSON.stringify({ ok: true, items: [{ content }] }), compartment);
		db.query(
			"INSERT OR REPLACE INTO dreaming_history_nodes (agent_id,scope_key,level,idx,pass_id,text,compartment_id) VALUES (?,?,0,0,?,?,?)",
		).run(input.agentId, input.agentId, passId, content, compartment);
		db.query(
			"INSERT OR REPLACE INTO documents (id,source_type,title,raw_content,status,agent_id,project,created_at,updated_at,author_user_id,compartment_id) VALUES (?,'text',?,?,'done',?,'atlas',?,?,?,?)",
		).run(documentId, input.marker, content, input.agentId, now, now, input.userId, compartment);
		db.query(
			"INSERT OR REPLACE INTO evidence_citations (derived_kind,derived_id,agent_id,evidence_kind,evidence_id) VALUES ('reflection',?,?,'memory',?)",
		).run(reflectionId, input.agentId, input.memoryId);
		db.query("INSERT OR REPLACE INTO document_memories (document_id,memory_id,chunk_index) VALUES (?,?,0)").run(
			documentId,
			input.memoryId,
		);
		db.query("UPDATE documents SET chunk_count=1,memory_count=1,completed_at=? WHERE id=?").run(now, documentId);
		const policyHash = createHash("sha256").update(content).digest("hex");
		db.query("UPDATE dreaming_passes SET started_at=? WHERE id=?").run(
			new Date(Date.now() + 3_600_000).toISOString(),
			passId,
		);
		db.query("INSERT OR REPLACE INTO dreaming_policies (hash,text,created_at) VALUES (?,?,?)").run(
			policyHash,
			content,
			now,
		);
		db.query("UPDATE dreaming_passes SET policy_source='custom',policy_hash=? WHERE id=?").run(policyHash, passId);
		db.query(
			"INSERT OR REPLACE INTO dreaming_passes (id,agent_id,mode,status,summary,completed_at,mutations_applied,tokens_consumed,compartment_id) VALUES (?,?,'incremental','completed',?,?,?,?,?)",
		).run(
			"org-hr-completed-pass",
			input.agentId,
			content,
			now,
			input.generation + 1,
			100 + input.generation,
			compartment,
		);
		const schema = text(record(db.query("SELECT sql FROM sqlite_master WHERE name='vec_embeddings'").get()).sql);
		const dimensions = Number(/FLOAT\s*\[\s*(\d+)\s*\]/i.exec(schema)?.[1]);
		assert(Number.isSafeInteger(dimensions) && dimensions > 0, "Cannot resolve fixture vector dimensions");
		const rows = [
			...input.publicMemoryIds.map((memoryId, index) => ({ memoryId, index, label: null })),
			...input.hiddenMemoryIds.map((memoryId, index) => ({ memoryId, index, label: compartment })),
		];
		for (const { index, memoryId, label } of rows) {
			if (label === null && input.generation > 0) continue;
			const embeddingId = `org-read-vector-${label === null ? "public" : "hidden"}-${index}`;
			const vector = new Float32Array(dimensions);
			vector[0] = label === null && index > 0 ? 0.9 + index / 100 : 1;
			vector[1] = label === null && index > 0 ? 0.45 - index / 100 : (input.generation + 1) / 1000;
			const bytes = Buffer.from(vector.buffer);
			db.query(
				"INSERT OR REPLACE INTO embeddings (id,content_hash,vector,dimensions,source_type,source_id,chunk_text,created_at,agent_id,compartment_id) VALUES (?,?,?,?,'memory',?,?,?,?,?)",
			).run(
				embeddingId,
				createHash("sha256").update(`${embeddingId}-${input.generation}`).digest("hex"),
				bytes,
				dimensions,
				memoryId,
				label === null ? "atlas public" : content,
				now,
				label === null
					? text(record(db.query("SELECT agent_id FROM memories WHERE id=?").get(memoryId)).agent_id)
					: input.agentId,
				label,
			);
			const table = label === null ? "vec_embeddings" : `vec_embeddings__c${label}`;
			db.query(`DELETE FROM ${table} WHERE id=?`).run(embeddingId);
			db.query(`INSERT INTO ${table} (id,embedding) VALUES (?,?)`).run(embeddingId, bytes);
		}
	})();
	db.close();
	return { sourceId: source.source.id, documentId, reflectionId, summaryId, passId };
}
function strings(value: unknown): string[] {
	assert(Array.isArray(value) && value.length > 0, "Expected nonempty fixture memory ids");
	return value.map(text);
}
if (import.meta.main) {
	const path = process.argv[2];
	assert(path, "Missing offline fixture input");
	const raw = record(JSON.parse(readFileSync(path, "utf8")));
	const generation = raw.generation;
	assert(typeof generation === "number");
	const result = seedDerived({
		workspace: text(raw.workspace),
		root: text(raw.root),
		agentId: text(raw.agentId),
		userId: text(raw.userId),
		entityId: text(raw.entityId),
		attributeId: text(raw.attributeId),
		memoryId: text(raw.memoryId),
		publicMemoryIds: strings(raw.publicMemoryIds),
		hiddenMemoryIds: strings(raw.hiddenMemoryIds),
		sessionKey: text(raw.sessionKey),
		marker: text(raw.marker),
		generation,
	});
	console.log(JSON.stringify(result));
}
