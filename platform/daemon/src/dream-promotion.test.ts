import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { promoteDreamingEvidence } from "./dream-promotion";

describe("dreaming evidence promotion", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-dream-promotion-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	function insertMemory(id: string, content: string, agentId = "ant", updatedAt = "2026-05-16T10:00:00.000Z"): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories
				 (id, type, content, confidence, importance, project, created_at, updated_at, updated_by, agent_id)
				 VALUES (?, 'preference', ?, 0.9, 0.8, '/tmp/signet', ?, ?, 'test', ?)`,
			).run(id, content, updatedAt, updatedAt, agentId);
		});
	}

	function readActiveClaims(): Array<{
		content: string;
		status: string;
		version: number;
		previous_attribute_id: string | null;
		source_kind: string | null;
		source_id: string | null;
	}> {
		return getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT attr.content, attr.status, attr.version, attr.previous_attribute_id,
						        attr.source_kind, attr.source_id
						 FROM entity_attributes attr
						 JOIN entity_aspects asp ON asp.id = attr.aspect_id
						 JOIN entities e ON e.id = asp.entity_id
						 WHERE e.agent_id = 'ant'
						   AND e.name = 'Nicholai'
						   AND asp.name = 'preferences'
						   AND attr.group_key = 'workflow'
						   AND attr.claim_key = 'prefers_xyz_when_we_re_doing_that'
						   AND attr.kind = 'attribute'
						 ORDER BY attr.version ASC`,
					)
					.all() as Array<{
					content: string;
					status: string;
					version: number;
					previous_attribute_id: string | null;
					source_kind: string | null;
					source_id: string | null;
				}>,
		);
	}

	it("previews direct set_claim_value operations from saved memory artifacts without mutating attributes", async () => {
		insertMemory("mem-pref", "Nicholai prefers xyz to be like this when we're doing that.");

		const result = await promoteDreamingEvidence(getDbAccessor(), {
			agentId: "ant",
			from: "memory:mem-pref",
		});

		expect(result.dryRun).toBe(true);
		expect(result.count).toBe(1);
		expect(result.appliedCount).toBe(0);
		expect(result.sources[0]?.kind).toBe("memory");
		expect(result.operations[0]?.operation).toBe("set_claim_value");
		expect(result.operations[0]?.payload).toMatchObject({
			entity: "Nicholai",
			aspect: "preferences",
			group_key: "workflow",
			claim_key: "prefers_xyz_when_we_re_doing_that",
			value: "Nicholai prefers xyz to be like this when we're doing that.",
			kind: "attribute",
		});

		expect(readActiveClaims()).toHaveLength(0);
	});

	it("applies preference memories into the current attribute slot and supersedes older values", async () => {
		insertMemory("mem-pref-1", "Nicholai prefers xyz to be like this when we're doing that.");
		const first = await promoteDreamingEvidence(getDbAccessor(), {
			agentId: "ant",
			from: "memory:mem-pref-1",
			apply: true,
			actor: "test-dreaming",
		});

		expect(first.dryRun).toBe(false);
		expect(first.appliedCount).toBe(1);
		expect(readActiveClaims()).toMatchObject([
			{
				content: "Nicholai prefers xyz to be like this when we're doing that.",
				status: "active",
				version: 1,
				previous_attribute_id: null,
				source_kind: "memory",
				source_id: "mem-pref-1",
			},
		]);

		insertMemory(
			"mem-pref-2",
			"Nicholai prefers xyz to be updated when we're doing that.",
			"ant",
			"2026-05-16T11:00:00.000Z",
		);
		const second = await promoteDreamingEvidence(getDbAccessor(), {
			agentId: "ant",
			from: "memory:mem-pref-2",
			apply: true,
			actor: "test-dreaming",
		});

		expect(second.appliedCount).toBe(1);
		const claims = readActiveClaims();
		expect(claims).toHaveLength(2);
		expect(claims[0]).toMatchObject({
			content: "Nicholai prefers xyz to be like this when we're doing that.",
			status: "superseded",
			version: 1,
		});
		expect(claims[1]).toMatchObject({
			content: "Nicholai prefers xyz to be updated when we're doing that.",
			status: "active",
			version: 2,
			source_id: "mem-pref-2",
		});
		expect(claims[1]?.previous_attribute_id).toBeString();
	});

	it("reads all evidence sources in agent scope and skips deleted or other-agent artifacts", async () => {
		insertMemory("mem-all", "Nicholai prefers compact status updates when we're pairing.");
		insertMemory("mem-other", "Nicholai prefers noisy updates when we're pairing.", "other");
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_key, session_token,
				  project, harness, captured_at, content, updated_at, is_deleted)
				 VALUES
				 ('ant', 'memory/artifact.md', 'sha1', 'artifact', 'sess-a', 'sess-a', 'tok-a',
				  '/tmp/signet', 'codex', '2026-05-16T12:00:00.000Z',
				  'Nicholai prefers direct apply paths when evidence is explicit.', '2026-05-16T12:00:00.000Z', 0),
				 ('ant', 'memory/deleted.md', 'sha2', 'artifact', 'sess-b', 'sess-b', 'tok-b',
				  '/tmp/signet', 'codex', '2026-05-16T12:01:00.000Z',
				  'Nicholai prefers deleted evidence when testing.', '2026-05-16T12:01:00.000Z', 1),
				 ('other', 'memory/other.md', 'sha3', 'artifact', 'sess-c', 'sess-c', 'tok-c',
				  '/tmp/signet', 'codex', '2026-05-16T12:02:00.000Z',
				  'Nicholai prefers other-agent evidence when testing.', '2026-05-16T12:02:00.000Z', 0)`,
			).run();
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"sess-transcript",
				"Nicholai prefers transcript-backed evidence when explicit.",
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-16T12:03:00.000Z",
				"2026-05-16T12:03:00.000Z",
			);
		});

		const result = await promoteDreamingEvidence(getDbAccessor(), {
			agentId: "ant",
			from: "all",
			limit: 20,
		});

		expect(result.sources.map((source) => source.kind).sort()).toEqual(["artifact", "memory", "transcript"]);
		expect(result.operations.map((operation) => operation.sourceId)).toContain("mem-all");
		expect(result.operations.map((operation) => operation.sourcePath)).toContain("memory/artifact.md");
		expect(result.operations.map((operation) => operation.sourceId)).toContain("sess-transcript");
		expect(result.operations.map((operation) => operation.sourceId)).not.toContain("mem-other");
		expect(result.operations.map((operation) => operation.sourcePath)).not.toContain("memory/deleted.md");
		expect(result.operations.map((operation) => operation.sourcePath)).not.toContain("memory/other.md");
	});
});
