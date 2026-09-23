import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	ensureCanonicalManifest,
	reindexMemoryArtifacts,
	removeCanonicalSession,
	writeSummaryArtifact,
} from "./memory-lineage";
import { cleanupTestTempDir, createTestTempDir } from "./test-temp-dir";

test("v2 resolves and reindexes migrated v1 manifest links without duplicating a session", async () => {
	const previousPath = process.env.SIGNET_PATH;
	const dir = createTestTempDir("signet-migrated-artifact-");
	process.env.SIGNET_PATH = dir;
	mkdirSync(join(dir, "memory"), { recursive: true });
	writeFileSync(join(dir, "agent.yaml"), "memory:\n  pipelineV2:\n    enabled: false\n");
	initDbAccessor(join(dir, "memory", "memories.db"));
	try {
		const capturedAt = new Date().toISOString();
		const seed = {
			agentId: "default",
			sessionId: "migrated-manifest",
			sessionKey: "migrated-manifest",
			project: "/home/user/project",
			harness: "codex",
			capturedAt,
			startedAt: capturedAt,
			endedAt: capturedAt,
		};
		const original = await writeSummaryArtifact({
			...seed,
			summary: "The original session summary must survive layout cutover.",
		});
		expect(original.manifestPath.startsWith("memory/")).toBe(true);
		const previousRows = await getDbAccessor().withReadDbAsync(
			async (db) =>
				db
					.prepare(
						"SELECT rowid AS row_id, source_kind, source_path FROM memory_artifacts WHERE session_id = ? ORDER BY source_kind",
					)
					.all(seed.sessionId) as Array<{ row_id: number; source_kind: string; source_path: string }>,
		);
		expect(previousRows).toHaveLength(2);
		const manifestBytes = readFileSync(join(dir, original.manifestPath));
		const transcriptsDir = join(dir, "transcripts");
		mkdirSync(transcriptsDir, { recursive: true });
		renameSync(join(dir, original.manifestPath), join(transcriptsDir, original.manifestPath.slice("memory/".length)));
		renameSync(join(dir, original.summaryPath), join(transcriptsDir, original.summaryPath.slice("memory/".length)));
		writeFileSync(join(dir, "workspace-layout.json"), JSON.stringify({ version: 2 }));
		expect(existsSync(join(dir, original.manifestPath))).toBe(false);
		const resumed = await ensureCanonicalManifest({
			...seed,
			capturedAt: new Date(Date.parse(capturedAt) + 1_000).toISOString(),
		});
		expect(resumed.path).toBe(join(transcriptsDir, original.manifestPath.slice("memory/".length)));
		expect(resumed.frontmatter.summary_path).toBe(original.summaryPath);
		expect(readFileSync(join(transcriptsDir, original.manifestPath.slice("memory/".length)))).toEqual(manifestBytes);
		await reindexMemoryArtifacts("default");
		const rows = await getDbAccessor().withReadDbAsync(
			async (db) =>
				db
					.prepare("SELECT source_path FROM memory_artifacts WHERE session_id = ? ORDER BY source_path")
					.all(seed.sessionId) as Array<{ source_path: string }>,
		);
		expect(rows.map((row) => row.source_path)).toEqual(
			[
				`transcripts/${original.manifestPath.slice("memory/".length)}`,
				`transcripts/${original.summaryPath.slice("memory/".length)}`,
			].sort(),
		);
		const currentRows = await getDbAccessor().withReadDbAsync(
			async (db) =>
				db
					.prepare(
						"SELECT rowid AS row_id, source_kind, source_path FROM memory_artifacts WHERE session_id = ? ORDER BY source_kind",
					)
					.all(seed.sessionId) as Array<{ row_id: number; source_kind: string; source_path: string }>,
		);
		expect(currentRows.map((row) => [row.row_id, row.source_kind])).toEqual(
			previousRows.map((row) => [row.row_id, row.source_kind]),
		);
	} finally {
		await closeDbAccessor();
		if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousPath;
		cleanupTestTempDir(dir);
	}
}, 60_000);

test("v2 reindex rejects a legacy path collision without changing either artifact row", async () => {
	const previousPath = process.env.SIGNET_PATH;
	const dir = createTestTempDir("signet-migrated-artifact-collision-");
	process.env.SIGNET_PATH = dir;
	mkdirSync(join(dir, "memory"), { recursive: true });
	writeFileSync(join(dir, "agent.yaml"), "memory:\n  pipelineV2:\n    enabled: false\n");
	initDbAccessor(join(dir, "memory", "memories.db"));
	try {
		const capturedAt = new Date().toISOString();
		const original = await writeSummaryArtifact({
			agentId: "default",
			sessionId: "migrated-collision",
			sessionKey: "migrated-collision",
			project: "/home/user/project",
			harness: "codex",
			capturedAt,
			startedAt: capturedAt,
			endedAt: capturedAt,
			summary: "A duplicate destination row must not replace source evidence.",
		});
		const target = `transcripts/${original.manifestPath.slice("memory/".length)}`;
		await getDbAccessor().withWriteTxAsync((db) =>
			db
				.prepare(
					`INSERT INTO memory_artifacts
					 (agent_id, source_path, source_sha256, source_kind, session_id, session_key,
					  session_token, captured_at, content, updated_at)
					 SELECT agent_id, ?, source_sha256, source_kind, session_id, session_key,
					        session_token, captured_at, content, updated_at
					 FROM memory_artifacts WHERE agent_id = ? AND source_path = ?`,
				)
				.run(target, "default", original.manifestPath),
		);
		const transcriptsDir = join(dir, "transcripts");
		mkdirSync(transcriptsDir, { recursive: true });
		renameSync(join(dir, original.manifestPath), join(transcriptsDir, original.manifestPath.slice("memory/".length)));
		renameSync(join(dir, original.summaryPath), join(transcriptsDir, original.summaryPath.slice("memory/".length)));
		writeFileSync(join(dir, "workspace-layout.json"), JSON.stringify({ version: 2 }));
		const readPaths = () =>
			getDbAccessor().withReadDbAsync(
				async (db) =>
					db
						.prepare(
							"SELECT source_path FROM memory_artifacts WHERE agent_id = ? AND session_id = ? ORDER BY source_path",
						)
						.all("default", "migrated-collision") as Array<{ source_path: string }>,
			);
		const before = await readPaths();
		expect(before).toHaveLength(3);
		await expect(reindexMemoryArtifacts("default")).rejects.toThrow("Migrated artifact path already indexed");
		expect(await readPaths()).toEqual(before);
	} finally {
		await closeDbAccessor();
		if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousPath;
		cleanupTestTempDir(dir);
	}
}, 60_000);

test("v2 removes migrated artifact files when legacy database paths are tombstoned", async () => {
	const previousPath = process.env.SIGNET_PATH;
	const dir = createTestTempDir("signet-migrated-artifact-delete-");
	process.env.SIGNET_PATH = dir;
	mkdirSync(join(dir, "memory"), { recursive: true });
	writeFileSync(join(dir, "agent.yaml"), "memory:\n  pipelineV2:\n    enabled: false\n");
	initDbAccessor(join(dir, "memory", "memories.db"));
	try {
		const capturedAt = new Date().toISOString();
		const original = await writeSummaryArtifact({
			agentId: "default",
			sessionId: "migrated-deletion",
			sessionKey: "migrated-deletion",
			project: "/home/user/project",
			harness: "codex",
			capturedAt,
			startedAt: capturedAt,
			endedAt: capturedAt,
			summary: "An artifact that is removed should not survive at the v2 path.",
		});
		const row = await getDbAccessor().withReadDbAsync(
			async (db) =>
				db
					.prepare("SELECT session_token FROM memory_artifacts WHERE session_id = ? LIMIT 1")
					.get("migrated-deletion") as { session_token: string },
		);
		const transcriptsDir = join(dir, "transcripts");
		mkdirSync(transcriptsDir, { recursive: true });
		const manifest = join(transcriptsDir, original.manifestPath.slice("memory/".length));
		const summary = join(transcriptsDir, original.summaryPath.slice("memory/".length));
		renameSync(join(dir, original.manifestPath), manifest);
		renameSync(join(dir, original.summaryPath), summary);
		writeFileSync(join(dir, "workspace-layout.json"), JSON.stringify({ version: 2 }));
		await removeCanonicalSession("default", row.session_token, "migration deletion test");
		expect(existsSync(manifest)).toBe(false);
		expect(existsSync(summary)).toBe(false);
	} finally {
		await closeDbAccessor();
		if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousPath;
		cleanupTestTempDir(dir);
	}
}, 60_000);
