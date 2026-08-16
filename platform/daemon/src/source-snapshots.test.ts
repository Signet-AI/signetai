/**
 * Regression tests for source snapshot import/export.
 *
 * These pin the artifact/provenance fields written by source snapshot restore
 * after the 24-column memory_artifacts upsert was consolidated into the shared
 * `upsertMemoryArtifactInTx` helper in memory-lineage.ts. The consolidation
 * must preserve the exact source-snapshot semantics, in particular the
 * `conflictGuardSourceId` ON CONFLICT guard that only overwrites a conflicting
 * path when it already belongs to the same source_id.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SignetSourceEntry } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { hashNormalizedBody, upsertMemoryArtifactInTx } from "./memory-lineage";
import {
	SOURCE_SNAPSHOT_VERSION,
	type SourceSnapshot,
	type SourceSnapshotArtifact,
	importSourceSnapshot,
} from "./source-snapshots";

function makeSourceEntry(id: string, root: string): SignetSourceEntry {
	const now = new Date().toISOString();
	return {
		id,
		kind: "obsidian",
		name: `test-${id}`,
		root,
		enabled: true,
		mode: "read-only",
		createdAt: now,
		updatedAt: now,
	};
}

function makeArtifact(overrides: Partial<SourceSnapshotArtifact> = {}): SourceSnapshotArtifact {
	const content = overrides.content ?? "alpha bravo charlie delta echo foxtrot";
	return {
		sourcePath: overrides.sourcePath ?? "obsidian://vault/note-a.md",
		sourceSha256: overrides.sourceSha256 ?? hashNormalizedBody(content),
		sourceKind: overrides.sourceKind ?? "obsidian_note",
		sessionId: overrides.sessionId ?? "session-1",
		sessionKey: overrides.sessionKey ?? "native:obsidian",
		sessionToken: overrides.sessionToken ?? "tokaaaaaaaaaaaaaa",
		project: overrides.project ?? "vault",
		harness: overrides.harness ?? "obsidian",
		capturedAt: overrides.capturedAt ?? "2026-01-02T03:04:05.000Z",
		startedAt: overrides.startedAt ?? "2026-01-02T03:04:00.000Z",
		endedAt: overrides.endedAt ?? "2026-01-02T03:05:00.000Z",
		manifestPath: overrides.manifestPath ?? "memory/manifest.json",
		sourceNodeId: overrides.sourceNodeId ?? "node-1",
		memorySentence: overrides.memorySentence ?? "Indexed obsidian note.",
		memorySentenceQuality: overrides.memorySentenceQuality ?? "fallback",
		content,
		updatedAt: overrides.updatedAt ?? "2026-01-02T03:06:00.000Z",
		sourceMtimeMs: overrides.sourceMtimeMs !== undefined ? overrides.sourceMtimeMs : 1700000000000,
		sourceId: overrides.sourceId ?? "src-1",
		sourceRoot: overrides.sourceRoot ?? "/tmp/vault",
		sourceExternalId: overrides.sourceExternalId ?? "ext-1",
		sourceParentPath: overrides.sourceParentPath ?? "obsidian://vault",
		sourceMetaJson: overrides.sourceMetaJson ?? JSON.stringify({ name: "note-a" }),
	};
}

interface ArtifactRow {
	readonly agent_id: string;
	readonly source_path: string;
	readonly source_sha256: string;
	readonly source_kind: string;
	readonly session_id: string;
	readonly session_key: string | null;
	readonly session_token: string;
	readonly project: string | null;
	readonly harness: string | null;
	readonly captured_at: string;
	readonly started_at: string | null;
	readonly ended_at: string | null;
	readonly manifest_path: string | null;
	readonly source_node_id: string | null;
	readonly memory_sentence: string | null;
	readonly memory_sentence_quality: string | null;
	readonly content: string;
	readonly updated_at: string;
	readonly source_mtime_ms: number | null;
	readonly source_id: string | null;
	readonly source_root: string | null;
	readonly source_external_id: string | null;
	readonly source_parent_path: string | null;
	readonly source_meta_json: string | null;
	readonly is_deleted: number;
	readonly deleted_at: string | null;
}

function readArtifact(agentId: string, sourcePath: string): ArtifactRow | undefined {
	return getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT agent_id, source_path, source_sha256, source_kind, session_id,
				        session_key, session_token, project, harness, captured_at,
				        started_at, ended_at, manifest_path, source_node_id,
				        memory_sentence, memory_sentence_quality, content, updated_at,
				        source_mtime_ms, source_id, source_root, source_external_id,
				        source_parent_path, source_meta_json, is_deleted, deleted_at
				   FROM memory_artifacts
				  WHERE agent_id = ? AND source_path = ?`,
				)
				.get(agentId, sourcePath) as ArtifactRow | undefined,
	);
}

describe("source snapshot import", () => {
	let dir: string;
	let prevSignetPath: string | undefined;
	const agentId = "agent-snapshot-test";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-source-snapshots-"));
		prevSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: false
`,
		);
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (prevSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = prevSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	function snapshotFor(source: SignetSourceEntry, artifacts: readonly SourceSnapshotArtifact[]): SourceSnapshot {
		return {
			version: SOURCE_SNAPSHOT_VERSION,
			exportedAt: "2026-01-02T00:00:00.000Z",
			source: { id: source.id, kind: source.kind, name: source.name, root: source.root },
			agentId,
			artifacts,
			skipped: { localDiscordArtifacts: 0 },
		};
	}

	test("restores every artifact and provenance field through the shared upsert", async () => {
		const source = makeSourceEntry("src-1", "/tmp/vault");
		const artifact = makeArtifact();
		const result = await importSourceSnapshot({
			source,
			agentId,
			snapshot: snapshotFor(source, [artifact]),
		});

		expect(result).toEqual({ ok: true, imported: 1, skipped: { localDiscordArtifacts: 0 } });

		const row = readArtifact(agentId, artifact.sourcePath);
		expect(row).toBeDefined();
		expect(row?.agent_id).toBe(agentId);
		expect(row?.source_path).toBe(artifact.sourcePath);
		expect(row?.source_sha256).toBe(artifact.sourceSha256);
		expect(row?.source_kind).toBe(artifact.sourceKind);
		expect(row?.session_id).toBe(artifact.sessionId);
		expect(row?.session_key).toBe(artifact.sessionKey);
		// Explicit session_token must be preserved (not re-derived).
		expect(row?.session_token).toBe(artifact.sessionToken);
		expect(row?.project).toBe(artifact.project);
		expect(row?.harness).toBe(artifact.harness);
		expect(row?.captured_at).toBe(artifact.capturedAt);
		expect(row?.started_at).toBe(artifact.startedAt);
		expect(row?.ended_at).toBe(artifact.endedAt);
		expect(row?.manifest_path).toBe(artifact.manifestPath);
		expect(row?.source_node_id).toBe(artifact.sourceNodeId);
		expect(row?.memory_sentence).toBe(artifact.memorySentence);
		expect(row?.memory_sentence_quality).toBe(artifact.memorySentenceQuality);
		expect(row?.content).toBe(artifact.content);
		expect(row?.updated_at).toBe(artifact.updatedAt);
		expect(row?.source_mtime_ms).toBe(artifact.sourceMtimeMs);
		expect(row?.source_id).toBe(artifact.sourceId);
		expect(row?.source_root).toBe(artifact.sourceRoot);
		expect(row?.source_external_id).toBe(artifact.sourceExternalId);
		expect(row?.source_parent_path).toBe(artifact.sourceParentPath);
		expect(row?.source_meta_json).toBe(artifact.sourceMetaJson);
		expect(row?.is_deleted).toBe(0);
		expect(row?.deleted_at).toBeNull();
	});

	test("preserves a null source_mtime_ms through the shared upsert", async () => {
		const source = makeSourceEntry("src-1", "/tmp/vault");
		const artifact = makeArtifact({ sourceMtimeMs: null });
		const result = await importSourceSnapshot({
			source,
			agentId,
			snapshot: snapshotFor(source, [artifact]),
		});

		expect(result).toEqual({ ok: true, imported: 1, skipped: { localDiscordArtifacts: 0 } });
		const row = readArtifact(agentId, artifact.sourcePath);
		expect(row?.source_mtime_ms).toBeNull();
	});

	test("re-importing an updated snapshot overwrites the same-source row", async () => {
		const source = makeSourceEntry("src-1", "/tmp/vault");
		const original = makeArtifact({ content: "first version content", updatedAt: "2026-01-02T01:00:00.000Z" });
		// sha must match content; recompute to keep the snapshot valid.
		const first = { ...original, sourceSha256: hashNormalizedBody(original.content) };
		expect(await importSourceSnapshot({ source, agentId, snapshot: snapshotFor(source, [first]) })).toEqual({
			ok: true,
			imported: 1,
			skipped: { localDiscordArtifacts: 0 },
		});

		const updatedContent = "second version content here";
		const updated = makeArtifact({
			sourcePath: first.sourcePath,
			content: updatedContent,
			sourceSha256: hashNormalizedBody(updatedContent),
			updatedAt: "2026-01-02T02:00:00.000Z",
			memorySentence: "Updated sentence.",
		});
		expect(await importSourceSnapshot({ source, agentId, snapshot: snapshotFor(source, [updated]) })).toEqual({
			ok: true,
			imported: 1,
			skipped: { localDiscordArtifacts: 0 },
		});

		const row = readArtifact(agentId, first.sourcePath);
		expect(row?.content).toBe(updatedContent);
		expect(row?.updated_at).toBe("2026-01-02T02:00:00.000Z");
		expect(row?.memory_sentence).toBe("Updated sentence.");
		expect(row?.is_deleted).toBe(0);
	});

	test("rejects a snapshot artifact whose checksum does not match its content", async () => {
		const source = makeSourceEntry("src-1", "/tmp/vault");
		const artifact = makeArtifact({ sourceSha256: "deadbeef" });
		const result = await importSourceSnapshot({ source, agentId, snapshot: snapshotFor(source, [artifact]) });
		expect(result).toEqual({ ok: false, error: expect.stringMatching(/checksum mismatch/) });
	});
});

describe("upsertMemoryArtifactInTx conflictGuardSourceId", () => {
	let dir: string;
	let prevSignetPath: string | undefined;
	const agentId = "agent-guard-test";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-source-snapshots-guard-"));
		prevSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: false
`,
		);
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (prevSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = prevSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	function baseFields(sourceId: string, content: string, updatedAt: string) {
		return {
			agentId,
			sourcePath: "obsidian://vault/guarded.md",
			sourceSha256: hashNormalizedBody(content),
			sourceKind: "obsidian_note",
			sessionId: "session-guard",
			sessionKey: "native:obsidian",
			sessionToken: "guardtokaaaaaaaaaa",
			project: "vault",
			harness: "obsidian",
			capturedAt: "2026-01-02T03:04:05.000Z",
			startedAt: null,
			endedAt: null,
			manifestPath: null,
			sourceNodeId: null,
			memorySentence: null,
			memorySentenceQuality: null,
			content,
			updatedAt,
			sourceMtimeMs: 1700000000000,
			sourceId,
			sourceRoot: "/tmp/vault",
			sourceExternalId: null,
			sourceParentPath: null,
			sourceMetaJson: null,
		};
	}

	test("with the guard, does not overwrite a row owned by a different source_id", () => {
		// Seed a row owned by src-A (no guard, so it inserts unconditionally).
		getDbAccessor().withWriteTx((db) => {
			upsertMemoryArtifactInTx(db, baseFields("src-A", "owner content", "2026-01-02T01:00:00.000Z"), {
				conflictGuardSourceId: false,
			});
		});

		// Attempt to upsert the same path for src-B with the guard active.
		getDbAccessor().withWriteTx((db) => {
			upsertMemoryArtifactInTx(db, baseFields("src-B", "intruder content", "2026-01-02T02:00:00.000Z"), {
				conflictGuardSourceId: true,
			});
		});

		const row = readArtifact(agentId, "obsidian://vault/guarded.md");
		// Guard prevents the cross-source overwrite: src-A data survives.
		expect(row?.source_id).toBe("src-A");
		expect(row?.content).toBe("owner content");
		expect(row?.updated_at).toBe("2026-01-02T01:00:00.000Z");
	});

	test("with the guard, overwrites a row owned by the same source_id", () => {
		getDbAccessor().withWriteTx((db) => {
			upsertMemoryArtifactInTx(db, baseFields("src-A", "first", "2026-01-02T01:00:00.000Z"), {
				conflictGuardSourceId: false,
			});
		});

		getDbAccessor().withWriteTx((db) => {
			upsertMemoryArtifactInTx(db, baseFields("src-A", "second", "2026-01-02T02:00:00.000Z"), {
				conflictGuardSourceId: true,
			});
		});

		const row = readArtifact(agentId, "obsidian://vault/guarded.md");
		expect(row?.content).toBe("second");
		expect(row?.updated_at).toBe("2026-01-02T02:00:00.000Z");
	});
});
