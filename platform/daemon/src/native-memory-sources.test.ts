import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addObsidianSource, loadSourcesConfig } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { dbOwnerQuery, ownerStatement } from "./db-owner-runtime";
import { resetEmbeddingCircuitBreakers } from "./embedding-circuit-breaker";
import { logger } from "./logger";
import { buildObsidianSourceChunks, resetObsidianSourceEmbeddingBackoff } from "./obsidian-source-embeddings";
import { indexExternalMemoryArtifact } from "./memory-lineage";
import type { NativeMemoryBridgeOptions } from "./native-memory-sources";
import {
	claudeCodeNativeMemorySource,
	codexNativeMemorySource,
	hermesNativeMemorySource,
	indexNativeMemoryFile,
	obsidianNativeMemorySource,
	purgeNativeMemorySourceArtifacts,
	removeNativeMemoryFile,
	resetNativeMemoryIndexCache,
	resolveEmbeddingBridgeOptions,
	startNativeMemoryBridge,
} from "./native-memory-sources";

describe("native memory sources", () => {
	let dir = "";
	let prevSignetPath: string | undefined;
	let prevSignetAgentId: string | undefined;

	beforeEach(() => {
		resetEmbeddingCircuitBreakers();
		dir = mkdtempSync(join(tmpdir(), "signet-native-memory-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "name: NativeMemoryTest\n");
		prevSignetPath = process.env.SIGNET_PATH;
		prevSignetAgentId = process.env.SIGNET_AGENT_ID;
		process.env.SIGNET_PATH = dir;
		Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		resetEmbeddingCircuitBreakers();
		closeDbAccessor();
		if (prevSignetPath === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = prevSignetPath;
		}
		if (prevSignetAgentId === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		} else {
			process.env.SIGNET_AGENT_ID = prevSignetAgentId;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("indexes Codex memory artifacts as external artifacts", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories", "rollout_summaries"), { recursive: true });
		const file = join(root, "memories", "rollout_summaries", "2026-04-22-test.md");
		writeFileSync(file, "thread_id: abc\n\nCodex remembered the Hermes bridge decision.\n");

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file)).toBe(true);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT source_path, source_kind, harness, content FROM memory_artifacts").get() as {
					source_path: string;
					source_kind: string;
					harness: string;
					content: string;
				},
		);
		expect(row.source_path).toBe(file);
		expect(row.source_kind).toBe("native_rollout_summary");
		expect(row.harness).toBe("codex");
		expect(row.content).toContain("Hermes bridge decision");
	});

	it("does not flatten owner read failures into legacy indexing", () => {
		const source = readFileSync(new URL("./native-memory-sources.ts", import.meta.url), "utf8");
		expect(source).toContain("Owner read failed for native artifact hash");
		expect(source).toContain("Owner read failed for source graph existence");
		expect(source).toContain("Owner read failed for source embedding existence");
		expect(source).toContain("Owner read failed while listing native memory artifacts");
		expect(source).toContain("throw err;");
	});

	it("keeps production native bridges graph-enabled", () => {
		const daemon = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
		const routes = readFileSync(new URL("./routes/sources-routes.ts", import.meta.url), "utf8");
		expect(daemon).toContain("sourceGraphEnabled: true");
		expect(routes).toContain("sourceGraphEnabled: true");
	});

	it("heals legacy pre-epoch captured_at rows on rescan (#1149)", async () => {
		// Regression for #1149 (adversarial review F3): rows already stamped
		// with the 1980 DOS-epoch sentinel stay permanently pending — no
		// watermark can reach them, so content passes never early-exit and
		// re-list the same stale row forever. The watcher must re-stamp them
		// with the index time once.
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories", "rollout_summaries"), { recursive: true });
		const file = join(root, "memories", "rollout_summaries", "sentinel-heal.md");
		writeFileSync(file, "thread_id: sentinel\n\nLegacy artifact with a corrupt mtime.\n");
		const source = codexNativeMemorySource(root);

		expect(await indexNativeMemoryFile(source, file)).toBe(true);
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memory_artifacts SET captured_at = ? WHERE agent_id = ? AND source_path = ?").run(
				"1980-01-01T06:00:00.000Z",
				"default",
				file,
			);
		});

		// Cold scan (fresh daemon): the unchanged-file path heals the row.
		resetNativeMemoryIndexCache();
		expect(await indexNativeMemoryFile(source, file)).toBe(false);

		const healed = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT captured_at FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
					.get("default", file) as { captured_at: string } | undefined,
		);
		expect(healed).toBeDefined();
		if (healed === undefined) throw new Error("artifact row missing");
		expect(Date.parse(healed.captured_at)).toBeGreaterThan(Date.parse("2025-01-01T00:00:00.000Z"));
	});

	it("indexes Codex automation memory files as native artifacts", async () => {
		const root = join(dir, ".codex");
		const file = join(root, "automations", "obsidian-wiki", "memory.md");
		mkdirSync(join(root, "automations", "obsidian-wiki"), { recursive: true });
		writeFileSync(file, "# Automation Memory\n\nThe Obsidian wiki automation processed agent-memory research.\n");

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file)).toBe(true);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT source_path, source_kind, harness, content FROM memory_artifacts").get() as {
					source_path: string;
					source_kind: string;
					harness: string;
					content: string;
				},
		);
		expect(row.source_path).toBe(file);
		expect(row.source_kind).toBe("native_automation_memory");
		expect(row.harness).toBe("codex");
		expect(row.content).toContain("Obsidian wiki automation");
	});

	it("indexes Codex skills and ad-hoc memory notes with source metadata", async () => {
		const root = join(dir, ".codex");
		const skill = join(root, "memories", "skills", "debugging", "SKILL.md");
		const note = join(root, "memories", "extensions", "ad_hoc", "notes", "2026-05-24-note.md");
		mkdirSync(join(root, "memories", "skills", "debugging"), { recursive: true });
		mkdirSync(join(root, "memories", "extensions", "ad_hoc", "notes"), { recursive: true });
		writeFileSync(skill, "# Debugging\n\nUse repo truth first.\n");
		writeFileSync(note, "Remember the Codex note bridge.\n");

		const source = codexNativeMemorySource(root);
		expect(await indexNativeMemoryFile(source, skill, "agent-native")).toBe(true);
		expect(await indexNativeMemoryFile(source, note, "agent-native")).toBe(true);

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT source_kind, source_id, source_external_id, source_meta_json FROM memory_artifacts ORDER BY source_kind",
					)
					.all() as Array<{
					source_kind: string;
					source_id: string | null;
					source_external_id: string | null;
					source_meta_json: string;
				}>,
		);
		expect(rows.map((row) => row.source_kind)).toEqual(["native_ad_hoc_note", "native_skill_memory"]);
		expect(rows.every((row) => row.source_id?.startsWith("codex_native_memory:"))).toBe(true);
		expect(rows.map((row) => row.source_external_id)).toEqual([
			"memories/extensions/ad_hoc/notes/2026-05-24-note.md",
			"memories/skills/debugging/SKILL.md",
		]);
		expect(JSON.parse(rows[0]?.source_meta_json ?? "{}")).toMatchObject({
			sourceType: "codex_native_memory",
			lineStart: 1,
			lineEnd: 1,
		});
	});

	it("indexes Codex rollout jsonl files and extracts rollout IDs", async () => {
		const root = join(dir, ".codex");
		const rollout = join(root, "memories", "rollout_summaries", "2026-05-24-run.jsonl");
		mkdirSync(join(root, "memories", "rollout_summaries"), { recursive: true });
		writeFileSync(
			rollout,
			'{"session_meta":{"payload":{"id":"019e5b4c-c317-74b0-bc52-a658b16e0f5d"}}}\n{"event":"done"}\n',
		);

		const handle = startNativeMemoryBridge([codexNativeMemorySource(root)], {
			agentId: "agent-native",
			pollIntervalMs: 0,
		});
		try {
			expect(await handle.syncExisting()).toBe(1);
			const row = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT source_kind, source_meta_json FROM memory_artifacts").get() as {
						source_kind: string;
						source_meta_json: string;
					},
			);
			expect(row.source_kind).toBe("native_rollout_summary");
			expect(JSON.parse(row.source_meta_json)).toMatchObject({
				rolloutId: "019e5b4c-c317-74b0-bc52-a658b16e0f5d",
				lineEnd: 2,
			});
		} finally {
			await handle.close();
		}
	});

	it("rejects symlinked Codex memory files", async () => {
		const root = join(dir, ".codex");
		const outside = join(dir, "outside.md");
		const link = join(root, "memories", "MEMORY.md");
		mkdirSync(join(root, "memories"), { recursive: true });
		writeFileSync(outside, "Do not index through a symlink.\n");
		symlinkSync(outside, link);

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), link, "agent-native")).toBe(false);
		const count = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts").get() as { count: number },
		).count;
		expect(count).toBe(0);
	});

	it("indexes Claude Code memdir files through the native bridge", async () => {
		const root = join(dir, ".claude");
		const file = join(root, "projects", "repo", "memory", "project-note.md");
		mkdirSync(join(root, "projects", "repo", "memory"), { recursive: true });
		writeFileSync(file, "---\ntype: project\n---\n\nClaude remembered the native memdir contract.\n");

		expect(await indexNativeMemoryFile(claudeCodeNativeMemorySource(root), file)).toBe(true);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT source_path, source_kind, harness, content FROM memory_artifacts").get() as {
					source_path: string;
					source_kind: string;
					harness: string;
					content: string;
				},
		);
		expect(row.source_path).toBe(file);
		expect(row.source_kind).toBe("native_claude_memory");
		expect(row.harness).toBe("claude-code");
		expect(row.content).toContain("native memdir contract");
	});

	it("indexes Claude Code memory index and agent memory files", async () => {
		const root = join(dir, ".claude");
		const indexFile = join(root, "projects", "repo", "memory", "MEMORY.md");
		const agentFile = join(root, "agent-memory", "builder", "preference.md");
		mkdirSync(join(root, "projects", "repo", "memory"), { recursive: true });
		mkdirSync(join(root, "agent-memory", "builder"), { recursive: true });
		writeFileSync(indexFile, "# Memory Index\n\n- [project] project-note.md: contract note\n");
		writeFileSync(agentFile, "Builder agent prefers clean native memory bridges.\n");

		const source = claudeCodeNativeMemorySource(root);
		expect(await indexNativeMemoryFile(source, indexFile)).toBe(true);
		expect(await indexNativeMemoryFile(source, agentFile)).toBe(true);

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT source_kind FROM memory_artifacts ORDER BY source_kind").all() as {
					source_kind: string;
				}[],
		);
		expect(rows.map((row) => row.source_kind)).toEqual(["native_claude_agent_memory", "native_claude_memory_index"]);
	});

	it("indexes Hermes MEMORY.md and USER.md with profile provenance", async () => {
		const profileRoot = join(dir, "hermes", "profiles", "research");
		const memoriesRoot = join(profileRoot, "memories");
		const memoryFile = join(memoriesRoot, "MEMORY.md");
		const userFile = join(memoriesRoot, "USER.md");
		const stamp = new Date("2026-04-22T12:00:00Z");
		mkdirSync(memoriesRoot, { recursive: true });
		writeFileSync(memoryFile, "# Hermes Memory\n\nHermes keeps curated profile context here.\n");
		writeFileSync(userFile, "# Hermes User\n\nThe user prefers portable memory.\n");
		utimesSync(memoryFile, stamp, stamp);
		utimesSync(userFile, stamp, stamp);

		const source = hermesNativeMemorySource(profileRoot);
		const handle = startNativeMemoryBridge([source], { agentId: "agent-hermes", pollIntervalMs: 0 });
		try {
			expect(await handle.syncExisting()).toBe(2);
			expect(await handle.syncExisting()).toBe(0);

			const rows = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT source_kind, source_id, source_root, source_external_id,
							        source_parent_path, source_meta_json, source_mtime_ms
							 FROM memory_artifacts
							 WHERE agent_id = ? ORDER BY source_kind`,
						)
						.all("agent-hermes") as Array<{
						source_kind: string;
						source_id: string;
						source_root: string;
						source_external_id: string;
						source_parent_path: string;
						source_meta_json: string;
						source_mtime_ms: number;
					}>,
			);
			expect(rows.map((row) => row.source_kind)).toEqual(["native_hermes_memory", "native_hermes_user"]);
			expect(rows.every((row) => row.source_id.startsWith("hermes_native_memory:"))).toBe(true);
			expect(rows.every((row) => row.source_root === profileRoot)).toBe(true);
			expect(rows.map((row) => row.source_external_id)).toEqual(["memories/MEMORY.md", "memories/USER.md"]);
			expect(rows.every((row) => row.source_parent_path === "memories")).toBe(true);
			expect(rows.every((row) => row.source_mtime_ms === stamp.getTime())).toBe(true);
			expect(JSON.parse(rows[0]?.source_meta_json ?? "{}")).toMatchObject({
				sourceType: "hermes_native_memory",
				provider: "hermes-agent",
				profileId: "research",
				profileRoot,
				relativePath: "memories/MEMORY.md",
				visibility: "private",
				project: null,
			});
		} finally {
			await handle.close();
		}
	});

	it("resolves the configured Hermes profile memory directory", () => {
		const profileRoot = join(dir, "hermes", "profiles", "configured");
		const previousHermesHome = process.env.HERMES_HOME;
		process.env.HERMES_HOME = profileRoot;
		try {
			expect(hermesNativeMemorySource()).toMatchObject({
				root: join(profileRoot, "memories"),
				sourceRoot: profileRoot,
			});
		} finally {
			if (previousHermesHome === undefined) {
				Reflect.deleteProperty(process.env, "HERMES_HOME");
			} else {
				process.env.HERMES_HOME = previousHermesHome;
			}
		}
	});

	it("reconciles changed and deleted Hermes profile artifacts idempotently", async () => {
		const profileRoot = join(dir, "hermes-profile");
		const memoriesRoot = join(profileRoot, "memories");
		const memoryFile = join(memoriesRoot, "MEMORY.md");
		const userFile = join(memoriesRoot, "USER.md");
		mkdirSync(memoriesRoot, { recursive: true });
		writeFileSync(memoryFile, "# Hermes Memory\n\nOriginal curated profile context.\n");
		writeFileSync(userFile, "# Hermes User\n\nOriginal user context.\n");

		const source = hermesNativeMemorySource(profileRoot);
		const handle = startNativeMemoryBridge([source], { agentId: "agent-hermes", pollIntervalMs: 0 });
		try {
			expect(await handle.syncExisting()).toBe(2);
			const before = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT source_sha256 FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
						.get("agent-hermes", memoryFile) as { source_sha256: string },
			);
			expect(await handle.syncExisting()).toBe(0);

			writeFileSync(memoryFile, "# Hermes Memory\n\nUpdated curated profile context.\n");
			expect(await handle.syncExisting()).toBe(1);
			const after = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT source_sha256, content FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
						.get("agent-hermes", memoryFile) as { source_sha256: string; content: string },
			);
			expect(after.source_sha256).not.toBe(before.source_sha256);
			expect(after.content).toContain("Updated curated profile context");

			rmSync(userFile);
			expect(await handle.syncExisting()).toBe(0);
			const deleted = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT is_deleted, deleted_at FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
						.get("agent-hermes", userFile) as { is_deleted: number; deleted_at: string | null },
			);
			expect(deleted).toMatchObject({ is_deleted: 1 });
			expect(deleted.deleted_at).toBeTruthy();
		} finally {
			await handle.close();
		}
	});

	it("soft-deletes a Hermes artifact when its curated file is cleared", async () => {
		const profileRoot = join(dir, "hermes-profile-empty");
		const memoriesRoot = join(profileRoot, "memories");
		const memoryFile = join(memoriesRoot, "MEMORY.md");
		mkdirSync(memoriesRoot, { recursive: true });
		writeFileSync(memoryFile, "# Hermes Memory\n\nCurated context that will be cleared.\n");

		const source = hermesNativeMemorySource(profileRoot);
		const handle = startNativeMemoryBridge([source], { agentId: "agent-hermes", pollIntervalMs: 0 });
		try {
			expect(await handle.syncExisting()).toBe(1);
			writeFileSync(memoryFile, "\n");
			expect(await handle.syncExisting()).toBe(0);

			const row = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT is_deleted, deleted_at FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
						.get("agent-hermes", memoryFile) as { is_deleted: number; deleted_at: string | null },
			);
			expect(row).toMatchObject({ is_deleted: 1 });
			expect(row.deleted_at).toBeTruthy();
		} finally {
			await handle.close();
		}
	});

	it("reconciles Hermes artifacts when the memories directory is absent after restart", async () => {
		const profileRoot = join(dir, "hermes-profile-removed");
		const memoriesRoot = join(profileRoot, "memories");
		const userFile = join(memoriesRoot, "USER.md");
		mkdirSync(memoriesRoot, { recursive: true });
		writeFileSync(userFile, "# Hermes User\n\nContext from a directory that will be removed.\n");

		const source = hermesNativeMemorySource(profileRoot);
		const initialBridge = startNativeMemoryBridge([source], { agentId: "agent-hermes", pollIntervalMs: 0 });
		try {
			expect(await initialBridge.syncExisting()).toBe(1);
		} finally {
			await initialBridge.close();
		}

		rmSync(memoriesRoot, { recursive: true, force: true });
		resetNativeMemoryIndexCache();
		const restartedBridge = startNativeMemoryBridge([source], { agentId: "agent-hermes", pollIntervalMs: 0 });
		try {
			expect(await restartedBridge.syncExisting()).toBe(0);
			const row = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT is_deleted, deleted_at FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
						.get("agent-hermes", userFile) as { is_deleted: number; deleted_at: string | null },
			);
			expect(row).toMatchObject({ is_deleted: 1 });
			expect(row.deleted_at).toBeTruthy();
		} finally {
			await restartedBridge.close();
		}
	});

	it("keeps Hermes profile and Signet agent boundaries separate", async () => {
		const profileA = join(dir, "hermes", "profiles", "alpha");
		const profileB = join(dir, "hermes", "profiles", "beta");
		const fileA = join(profileA, "memories", "MEMORY.md");
		const fileB = join(profileB, "memories", "MEMORY.md");
		mkdirSync(join(profileA, "memories"), { recursive: true });
		mkdirSync(join(profileB, "memories"), { recursive: true });
		writeFileSync(fileA, "# Shared preference\n\nProfile alpha memory boundary marker.\n");
		writeFileSync(fileB, "# Shared preference\n\nProfile beta memory boundary marker.\n");

		const sourceA = hermesNativeMemorySource(profileA);
		const sourceB = hermesNativeMemorySource(profileB);
		const handle = startNativeMemoryBridge([sourceA, sourceB], { agentId: "agent-a", pollIntervalMs: 0 });
		try {
			expect(await handle.syncExisting()).toBe(2);
			expect(await indexNativeMemoryFile(sourceA, fileA, "agent-b")).toBe(true);

			const rows = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							"SELECT agent_id, source_root, source_meta_json FROM memory_artifacts ORDER BY agent_id, source_root",
						)
						.all() as Array<{ agent_id: string; source_root: string; source_meta_json: string }>,
			);
			expect(rows.map((row) => row.agent_id)).toEqual(["agent-a", "agent-a", "agent-b"]);
			expect(rows.filter((row) => row.agent_id === "agent-a").map((row) => row.source_root)).toEqual([
				profileA,
				profileB,
			]);
			expect(JSON.parse(rows[2]?.source_meta_json ?? "{}").profileId).toBe("alpha");
		} finally {
			await handle.close();
		}
	});

	it("uses the daemon agent id when no explicit agent id is provided", async () => {
		process.env.SIGNET_AGENT_ID = "agent-native";
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories"), { recursive: true });
		const file = join(root, "memories", "memory_summary.md");
		writeFileSync(file, "Codex remembered a non-default agent preference.\n");

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file)).toBe(true);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT agent_id FROM memory_artifacts").get() as {
					agent_id: string;
				},
		);
		expect(row.agent_id).toBe("agent-native");
	});

	it("clears the dedupe fingerprint when a native memory file is removed", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories"), { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "memories", "memory_summary.md");
		const stamp = new Date("2026-04-22T12:00:00Z");
		writeFileSync(file, "Codex remembered the same recreated file.\n");
		utimesSync(file, stamp, stamp);

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		await removeNativeMemoryFile(source, file, "agent-native");
		writeFileSync(file, "Codex remembered the same recreated file.\n");
		utimesSync(file, stamp, stamp);

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		const count = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts").get() as { count: number },
		).count;
		expect(count).toBe(1);
	});

	it("soft-deletes native memory artifacts when their source file is removed", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "automations", "smoke"), { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "automations", "smoke", "memory.md");
		writeFileSync(file, "# Smoke\n\nCodex remembered a soft deleted native artifact.\n");

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		await removeNativeMemoryFile(source, file, "agent-native");

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT is_deleted, deleted_at FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
					.get("agent-native", file) as {
					is_deleted: number;
					deleted_at: string | null;
				},
		);
		expect(row.is_deleted).toBe(1);
		expect(row.deleted_at).toBeTruthy();
	});

	it("restores soft-deleted native artifacts when the source file returns", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "automations", "smoke"), { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "automations", "smoke", "memory.md");
		writeFileSync(file, "# Smoke\n\nCodex remembered a restored native artifact.\n");

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		await removeNativeMemoryFile(source, file, "agent-native");
		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT is_deleted, deleted_at FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
					.get("agent-native", file) as {
					is_deleted: number;
					deleted_at: string | null;
				},
		);
		expect(row.is_deleted).toBe(0);
		expect(row.deleted_at).toBeNull();
	});

	it("does not cache a fingerprint when persistence fails", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories"), { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "memories", "memory_summary.md");
		const stamp = new Date("2026-04-22T12:00:00Z");
		writeFileSync(file, "Codex remembered a retryable persistence failure.\n");
		utimesSync(file, stamp, stamp);

		await closeDbAccessor();
		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(false);

		initDbAccessor(join(dir, "memory", "memories.db"));
		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
	});

	it("reindexes unchanged native files when the artifact row is missing", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories"), { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "memories", "memory_summary.md");
		const stamp = new Date("2026-04-22T12:00:00Z");
		writeFileSync(file, "Codex remembered a deleted artifact row.\n");
		utimesSync(file, stamp, stamp);

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		getDbAccessor().withWriteTx((db) => {
			db.prepare("DELETE FROM memory_artifacts WHERE agent_id = ? AND source_path = ?").run("agent-native", file);
		});

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		const count = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts").get() as { count: number },
		).count;
		expect(count).toBe(1);
	});

	it("skips unchanged native files when the artifact row already exists after a cold cache start", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories"), { recursive: true });
		const file = join(root, "memories", "memory_summary.md");
		const content = "Codex remembered a persisted artifact row.\n";
		writeFileSync(file, content);
		await indexExternalMemoryArtifact({
			agentId: "agent-native",
			sourcePath: file,
			sourceKind: "native_memory_summary",
			harness: "codex",
			content,
			sourceMtimeMs: Date.now(),
		});

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file, "agent-native")).toBe(false);
		const count = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts").get() as { count: number },
		).count;
		expect(count).toBe(1);
	});

	it("reindexes same-size native files when content changes", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories"), { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "memories", "memory_summary.md");
		const stamp = new Date("2026-04-22T12:00:00Z");
		writeFileSync(file, "Codex remembered alpha state.\n");
		utimesSync(file, stamp, stamp);

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		writeFileSync(file, "Codex remembered bravo state.\n");
		utimesSync(file, stamp, stamp);

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT content FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
					.get("agent-native", file) as { content: string },
		);
		expect(row.content).toContain("bravo state");
	});

	it("indexes native memories when the source root is created after bridge startup", async () => {
		const root = join(dir, ".codex");
		const handle = startNativeMemoryBridge([codexNativeMemorySource(root)], {
			agentId: "agent-native",
			pollIntervalMs: 25,
		});
		try {
			mkdirSync(join(root, "memories"), { recursive: true });
			const file = join(root, "memories", "memory_summary.md");
			writeFileSync(file, "Codex remembered a late-created native memory root.\n");

			let indexed = false;
			for (let i = 0; i < 20; i++) {
				await Bun.sleep(25);
				const count = getDbAccessor().withReadDb(
					(db) => db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts").get() as { count: number },
				).count;
				if (count > 0) {
					indexed = true;
					break;
				}
			}
			expect(indexed).toBe(true);
		} finally {
			await handle.close();
		}
	});

	it("soft-deletes removed native memories during bridge sync", async () => {
		const root = join(dir, ".codex");
		const file = join(root, "memories", "memory_summary.md");
		mkdirSync(join(root, "memories"), { recursive: true });
		writeFileSync(file, "Codex remembered a native memory that will disappear.\n");

		const handle = startNativeMemoryBridge([codexNativeMemorySource(root)], {
			agentId: "agent-native",
			pollIntervalMs: 0,
		});
		try {
			expect(await handle.syncExisting()).toBe(1);
			rmSync(file);
			expect(await handle.syncExisting()).toBe(0);

			const row = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT is_deleted, deleted_at FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
						.get("agent-native", file) as {
						is_deleted: number;
						deleted_at: string | null;
					},
			);
			expect(row.is_deleted).toBe(1);
			expect(row.deleted_at).toBeTruthy();
		} finally {
			await handle.close();
		}
	});

	it("does not soft-delete artifacts beyond a capped scan", async () => {
		const root = join(dir, "vault");
		const first = join(root, "first.md");
		const second = join(root, "second.md");
		mkdirSync(root, { recursive: true });
		writeFileSync(first, "# First\n\nThe first source document remains active.\n");
		writeFileSync(second, "# Second\n\nThe second source document remains active.\n");
		const source = obsidianNativeMemorySource(root, "Capped Vault", "obsidian:capped-vault");

		const initial = startNativeMemoryBridge([source], {
			agentId: "agent-native",
			pollIntervalMs: 0,
			sourceGraphEnabled: false,
		});
		try {
			expect(await initial.syncExisting()).toBe(2);
		} finally {
			await initial.close();
		}

		const capped = startNativeMemoryBridge([source], {
			agentId: "agent-native",
			pollIntervalMs: 0,
			maxFilesPerScan: 1,
			sourceGraphEnabled: false,
		});
		try {
			expect(await capped.syncExisting()).toBe(0);
		} finally {
			await capped.close();
		}

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT source_path, is_deleted FROM memory_artifacts WHERE agent_id = ? ORDER BY source_path")
					.all("agent-native") as Array<{ source_path: string; is_deleted: number }>,
		);
		expect(rows).toEqual([
			{ source_path: first, is_deleted: 0 },
			{ source_path: second, is_deleted: 0 },
		]);
	});

	it("preserves the Obsidian path index across an async graph-enabled scan", async () => {
		const root = join(dir, "vault");
		const sourceFile = join(root, "folder-a", "Source.md");
		const targetFile = join(root, "folder-b", "Target.md");
		mkdirSync(join(root, "folder-a"), { recursive: true });
		mkdirSync(join(root, "folder-b"), { recursive: true });
		writeFileSync(sourceFile, "# Source\n\nLinks to [[Target]].\n");
		writeFileSync(targetFile, "# Target\n\nThe cross-folder target is indexed as source graph structure.\n");
		const source = obsidianNativeMemorySource(root, "Async Graph Vault", "obsidian:async-graph");
		const handle = startNativeMemoryBridge([source], {
			agentId: "agent-native",
			pollIntervalMs: 0,
			sourceGraphEnabled: true,
		});
		try {
			expect(await handle.syncExisting()).toBe(2);
		} finally {
			await handle.close();
		}

		const target = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT entity_type, source_path FROM entities WHERE agent_id = ? AND canonical_name = ?")
					.get("agent-native", "obsidian:obsidian:async-graph:document:folder-b/Target.md") as
					| { entity_type: string; source_path: string }
					| undefined,
		);
		expect(target).toEqual({ entity_type: "source_document", source_path: targetFile });
	});

	it("can defer stale source cleanup during bridge sync", async () => {
		const root = join(dir, "vault");
		const file = join(root, "permanent", "Old.md");
		mkdirSync(join(root, "permanent"), { recursive: true });
		writeFileSync(file, "# Old\n\nThis source file will be removed after initial indexing.\n");
		const source = obsidianNativeMemorySource(root, "Cleanup Vault", "obsidian:cleanup-test");

		const handle = startNativeMemoryBridge([source], {
			agentId: "agent-native",
			pollIntervalMs: 0,
			sourceCleanupEnabled: false,
		});
		try {
			expect(await handle.syncExisting()).toBe(1);
			rmSync(file);
			expect(await handle.syncExisting()).toBe(0);

			const row = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							"SELECT is_deleted FROM memory_artifacts WHERE agent_id = ? AND source_path = ? AND harness = 'obsidian'",
						)
						.get("agent-native", file) as { is_deleted: number | null },
			);
			expect(row.is_deleted ?? 0).toBe(0);
		} finally {
			await handle.close();
		}
	});

	it("soft-deletes known native memories when their source root is removed", async () => {
		const root = join(dir, ".codex");
		const file = join(root, "memories", "memory_summary.md");
		mkdirSync(join(root, "memories"), { recursive: true });
		writeFileSync(file, "Codex remembered a native root that will disappear.\n");

		const handle = startNativeMemoryBridge([codexNativeMemorySource(root)], {
			agentId: "agent-native",
			pollIntervalMs: 0,
		});
		try {
			expect(await handle.syncExisting()).toBe(1);
			rmSync(root, { recursive: true, force: true });
			expect(await handle.syncExisting()).toBe(0);

			const row = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT is_deleted, deleted_at FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
						.get("agent-native", file) as {
						is_deleted: number;
						deleted_at: string | null;
					},
			);
			expect(row.is_deleted).toBe(1);
			expect(row.deleted_at).toBeTruthy();
		} finally {
			await handle.close();
		}
	});

	it("keeps known native memory state isolated by source root", async () => {
		const rootA = join(dir, ".codex-a");
		const rootB = join(dir, ".codex-b");
		const fileA = join(rootA, "memories", "memory_summary.md");
		const fileB = join(rootB, "memories", "memory_summary.md");
		mkdirSync(join(rootA, "memories"), { recursive: true });
		mkdirSync(join(rootB, "memories"), { recursive: true });
		writeFileSync(fileA, "Codex remembered source A.\n");
		writeFileSync(fileB, "Codex remembered source B.\n");

		const handle = startNativeMemoryBridge([codexNativeMemorySource(rootA), codexNativeMemorySource(rootB)], {
			agentId: "agent-native",
			pollIntervalMs: 0,
		});
		try {
			expect(await handle.syncExisting()).toBe(2);
			expect(await handle.syncExisting()).toBe(0);

			const rows = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT source_path, is_deleted FROM memory_artifacts WHERE agent_id = ? ORDER BY source_path")
						.all("agent-native") as Array<{
						source_path: string;
						is_deleted: number;
					}>,
			);
			expect(rows).toEqual([
				{ source_path: fileA, is_deleted: 0 },
				{ source_path: fileB, is_deleted: 0 },
			]);
		} finally {
			await handle.close();
		}
	});

	it("skips nested files below Codex automation memory files", async () => {
		const root = join(dir, ".codex");
		const file = join(root, "automations", "obsidian-wiki", "nested", "memory.md");
		mkdirSync(join(root, "automations", "obsidian-wiki", "nested"), { recursive: true });
		writeFileSync(file, "not a direct automation memory surface");

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file)).toBe(false);
	});

	it("skips files outside the declared native memory patterns", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories"), { recursive: true });
		const file = join(root, "memories", "notes.md");
		writeFileSync(file, "not a Codex native memory surface");

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file)).toBe(false);
	});

	it("indexes Obsidian markdown as read-only source artifacts", async () => {
		const root = join(dir, "vault");
		mkdirSync(join(root, "permanent"), { recursive: true });
		const file = join(root, "permanent", "Signet.md");
		writeFileSync(file, "# Signet\n\nObsidian source knowledge base note.\n");

		expect(await indexNativeMemoryFile(obsidianNativeMemorySource(root), file, "agent-obsidian")).toBe(true);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT source_path, source_kind, harness, source_id, source_root,
						        source_external_id, source_parent_path, source_meta_json, content
						 FROM memory_artifacts`,
					)
					.get() as {
					source_path: string;
					source_kind: string;
					harness: string;
					source_id: string;
					source_root: string;
					source_external_id: string;
					source_parent_path: string;
					source_meta_json: string;
					content: string;
				},
		);
		expect(row.source_path).toBe(file);
		expect(row.source_kind).toBe("source_obsidian_markdown");
		expect(row.harness).toBe("obsidian");
		expect(row.source_id).toStartWith("obsidian:");
		expect(row.source_root).toBe(root);
		expect(row.source_external_id).toBe("permanent/Signet.md");
		expect(row.source_parent_path).toBe("permanent");
		expect(JSON.parse(row.source_meta_json)).toMatchObject({ provider: "obsidian" });
		expect(row.content).toContain("Obsidian source knowledge base note");
	});

	it("can defer Obsidian graph projection while still indexing source artifacts", async () => {
		const root = join(dir, "vault");
		const file = join(root, "permanent", "Signet.md");
		mkdirSync(join(root, "permanent"), { recursive: true });
		writeFileSync(file, "# Signet\n\nSource-backed memory can defer graph expansion out of the daemon sync path.\n");

		expect(
			await indexNativeMemoryFile(obsidianNativeMemorySource(root, "Vault", "obsidian:vault"), file, "agent-native", {
				sourceGraphEnabled: false,
			}),
		).toBe(true);

		const rows = getDbAccessor().withReadDb((db) => ({
			artifacts: (
				db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE source_path = ?").get(file) as {
					count: number;
				}
			).count,
			entities: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND source_id = ?")
					.get("agent-native", "obsidian:vault") as { count: number }
			).count,
		}));
		expect(rows).toEqual({ artifacts: 1, entities: 0 });
	});

	it("can expand unchanged Obsidian artifacts after a lightweight source scan", async () => {
		const root = join(dir, "vault");
		const source = obsidianNativeMemorySource(root, "Vault", "obsidian:vault");
		const file = join(root, "permanent", "Signet.md");
		mkdirSync(join(root, "permanent"), { recursive: true });
		writeFileSync(
			file,
			"# Signet Sources\n\nSource-backed memory can first index the file artifact, then later add graph rows and embeddings without changing the note.\n",
		);

		expect(
			await indexNativeMemoryFile(source, file, "agent-native", {
				sourceGraphEnabled: false,
			}),
		).toBe(true);
		expect(
			await indexNativeMemoryFile(source, file, "agent-native", {
				embeddingConfig: { provider: "native", model: "test", dimensions: 3, base_url: "", profile: "test" },
				fetchEmbedding: async () => [1, 2, 3],
			}),
		).toBe(true);

		const rows = getDbAccessor().withReadDb((db) => ({
			entities: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND source_id = ?")
					.get("agent-native", "obsidian:vault") as { count: number }
			).count,
			embeddings: (
				db
					.prepare("SELECT COUNT(*) AS count FROM embeddings WHERE agent_id = ? AND source_type = ?")
					.get("agent-native", "source_chunk") as { count: number }
			).count,
		}));
		expect(rows.entities).toBeGreaterThan(0);
		expect(rows.embeddings).toBeGreaterThan(0);
	});

	it("skips hidden Obsidian vault directories by default", async () => {
		const root = join(dir, "vault");
		mkdirSync(join(root, ".claude"), { recursive: true });
		const file = join(root, ".claude", "CLAUDE.md");
		writeFileSync(file, "# Hidden agent prompt\n\nThis should stay out of source recall by default.\n");

		expect(await indexNativeMemoryFile(obsidianNativeMemorySource(root), file, "agent-obsidian")).toBe(false);
	});

	it("honors custom Obsidian exclude globs", async () => {
		const root = join(dir, "vault");
		mkdirSync(join(root, "private"), { recursive: true });
		const file = join(root, "private", "Secret.md");
		writeFileSync(file, "# Private\n\nThis folder is excluded by user glob.\n");

		const source = obsidianNativeMemorySource(root, "Vault", "obsidian:test", ["private/**"]);
		expect(await indexNativeMemoryFile(source, file, "agent-obsidian")).toBe(false);
	});

	it("treats bare Obsidian exclude globs as vault-wide filename patterns", async () => {
		const root = join(dir, "vault");
		mkdirSync(join(root, "nested"), { recursive: true });
		const nestedFile = join(root, "nested", "Draft.tmp.md");
		writeFileSync(nestedFile, "# Draft\n\nThis nested file should be excluded by a bare filename glob.\n");

		const source = obsidianNativeMemorySource(root, "Vault", "obsidian:test", ["*.tmp.md"]);
		expect(await indexNativeMemoryFile(source, nestedFile, "agent-obsidian")).toBe(false);
	});

	it("removes Obsidian graph rows when a source markdown file disappears", async () => {
		const root = join(dir, "vault");
		const source = obsidianNativeMemorySource(root, "Research Vault", "obsidian:remove-file-vault");
		const file = join(root, "permanent", "Deleted.md");
		mkdirSync(join(root, "permanent"), { recursive: true });
		writeFileSync(file, "# Deleted\n\nThis graph claim should disappear when the markdown file is removed.\n");

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		const before = getDbAccessor().withReadDb((db) => ({
			entities: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND source_path = ?")
					.get("agent-native", file) as { count: number }
			).count,
			attrs: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE agent_id = ? AND source_path = ?")
					.get("agent-native", file) as { count: number }
			).count,
		}));
		expect(before.entities).toBeGreaterThan(0);
		expect(before.attrs).toBeGreaterThan(0);

		await removeNativeMemoryFile(source, file, "agent-native");

		const after = getDbAccessor().withReadDb((db) => ({
			artifacts: (
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0",
					)
					.get("agent-native", file) as { count: number }
			).count,
			entities: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND source_path = ?")
					.get("agent-native", file) as { count: number }
			).count,
			attrs: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE agent_id = ? AND source_path = ?")
					.get("agent-native", file) as { count: number }
			).count,
		}));
		expect(after).toEqual({ artifacts: 0, entities: 0, attrs: 0 });
	});

	it("drops a vanished artifact from the index on ENOENT and stops retrying it (#1142)", async () => {
		const root = join(dir, "vault");
		const source = obsidianNativeMemorySource(root, "Vault", "obsidian:enoent-vault");
		const file = join(root, "permanent", "Vanished.md");
		mkdirSync(join(root, "permanent"), { recursive: true });
		writeFileSync(file, "# Vanished\n\nThis file is deleted between the scan listing and the read.\n");

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							"SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0",
						)
						.get("agent-native", file) as { count: number },
			).count,
		).toBe(1);

		// The file vanishes before the watcher reads it (ENOENT).
		rmSync(file);

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(false);
		// The stale row is soft-deleted instead of being retried every scan.
		const after = getDbAccessor().withReadDb((db) => ({
			active: (
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0",
					)
					.get("agent-native", file) as { count: number }
			).count,
			softDeleted: (
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 1",
					)
					.get("agent-native", file) as { count: number }
			).count,
		}));
		expect(after.active).toBe(0);
		expect(after.softDeleted).toBe(1);

		// Re-attempting the gone path stays a no-op.
		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(false);
	});

	it("keeps artifact rows on transient read failures and backs off retries (#1142)", async () => {
		const root = join(dir, ".codex");
		const file = join(root, "memories", "memory_summary.md");
		mkdirSync(join(root, "memories"), { recursive: true });
		writeFileSync(file, "Codex remembered the locked-file contract.\n");

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file, "agent-native")).toBe(true);

		// Make the path fail with a non-ENOENT error (parent replaced by a
		// file -> ENOTDIR), standing in for a transiently locked file.
		rmSync(root, { recursive: true, force: true });
		writeFileSync(join(dir, ".codex"), "now a plain file\n");

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file, "agent-native")).toBe(false);
		// Transient failures must NOT drop the artifact row (only ENOENT does).
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							"SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0",
						)
						.get("agent-native", file) as { count: number },
			).count,
		).toBe(1);

		// The path is in failure cooldown: the retry is skipped, still false,
		// and the row is untouched.
		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file, "agent-native")).toBe(false);
	});

	it("embeds heading-aware Obsidian source chunks when embedding options are provided", async () => {
		const root = join(dir, "vault");
		const file = join(root, "permanent", "Signet.md");
		mkdirSync(join(root, "permanent"), { recursive: true });
		writeFileSync(
			file,
			"# Signet Sources\n\nObsidian source embeddings should preserve canonical file paths and heading-level retrieval chunks.\n\n## Recall\n\nVector recall should be able to retrieve this note through an embedded source chunk.\n",
		);

		expect(
			await indexNativeMemoryFile(
				obsidianNativeMemorySource(root, "Research Vault", "obsidian:test-vault"),
				file,
				"agent-native",
				{
					embeddingConfig: { provider: "native", model: "test", dimensions: 3, base_url: "", profile: "test" },
					fetchEmbedding: async () => [1, 2, 3],
				},
			),
		).toBe(true);

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT source_id, chunk_text FROM embeddings WHERE source_type = 'source_chunk' ORDER BY source_id")
					.all() as Array<{ source_id: string; chunk_text: string }>,
		);
		expect(rows.length).toBeGreaterThanOrEqual(1);
		expect(rows.every((row) => row.source_id.startsWith("obsidian:test-vault:permanent/Signet.md#"))).toBe(true);
		expect(rows.every((row) => row.chunk_text.includes(`source_path: ${file}`))).toBe(true);
		expect(rows.some((row) => row.chunk_text.includes("heading: Signet Sources"))).toBe(true);
	});

	it("pauses a source before scanning when its embedding provider is unavailable", async () => {
		const root = join(dir, "provider-down-vault");
		const file = join(root, "permanent", "Pending.md");
		mkdirSync(join(root, "permanent"), { recursive: true });
		writeFileSync(file, "# Pending Embeddings\n\nProvider availability must gate all source work.\n");
		let fetches = 0;
		const indexed: string[] = [];
		const source = obsidianNativeMemorySource(root, "Provider Down Vault", "obsidian:provider-down");
		const makeHandle = () =>
			startNativeMemoryBridge([source], {
				agentId: "agent-native",
				pollIntervalMs: 0,
				sourceGraphEnabled: false,
				embeddingConfig: { provider: "native", model: "down-model", dimensions: 3, base_url: "", profile: "down" },
				fetchEmbedding: async (_text, _cfg, _role, options) => {
					fetches++;
					options?.onFailure?.("provider_unavailable");
					return null;
				},
				onFileIndexed: (event) => indexed.push(event.filePath),
			});
		const handle = makeHandle();
		try {
			expect(await handle.syncExisting()).toBe(0);
			expect(fetches).toBe(1);
			expect(indexed).toEqual([]);
			expect(handle.getLastSyncResult?.()).toMatchObject({
				status: "paused",
				indexed: 0,
				pausedSources: [
					{ sourceId: "obsidian:provider-down", resumeFrontier: null, pauseReason: "provider_unavailable" },
				],
			});
			expect(
				await getDbAccessor().withReadDbAsync(
					(db) =>
						db
							.prepare(
								"SELECT status, checkpoint_path, pause_reason FROM native_source_sync_state WHERE agent_id = ? AND source_key = ?",
							)
							.get("agent-native", "obsidian:provider-down") as {
							status: string;
							checkpoint_path: string | null;
							pause_reason: string | null;
						},
				),
			).toEqual({ status: "paused", checkpoint_path: null, pause_reason: "provider_unavailable" });
		} finally {
			await handle.close();
		}

		// A new bridge must honor the durable pause without rescanning, owner
		// churn, or a legacy artifact fallback.
		const restarted = makeHandle();
		try {
			expect(await restarted.syncExisting()).toBe(0);
			expect(fetches).toBe(1);
			expect(indexed).toEqual([]);
		} finally {
			await restarted.close();
		}
	});

	it("joins a polling bridge scan from a manual bridge without duplicating provider calls", async () => {
		const root = join(dir, "cross-instance-vault");
		const file = join(root, "permanent", "Shared.md");
		mkdirSync(join(root, "permanent"), { recursive: true });
		writeFileSync(file, "# Shared\n\nOne provider call must serve both the polling and manual bridge instances.\n");
		const source = obsidianNativeMemorySource(root, "Cross Instance Vault", "obsidian:cross-instance");
		let releaseEmbedding = () => {};
		const embeddingGate = new Promise<void>((resolve) => {
			releaseEmbedding = resolve;
		});
		let embeddingStarted = false;
		let providerCalls = 0;
		let probeCalls = 0;
		let embeddingCalls = 0;
		const embeddingOptions: Pick<NativeMemoryBridgeOptions, "embeddingConfig" | "fetchEmbedding"> = {
			embeddingConfig: { provider: "native", model: "cross-instance", dimensions: 3, base_url: "", profile: "cross" },
			fetchEmbedding: async (text: string) => {
				providerCalls++;
				if (text.trim().length > 0) {
					embeddingCalls++;
					embeddingStarted = true;
					await embeddingGate;
				} else {
					probeCalls++;
				}
				return [1, 2, 3];
			},
		};
		const pollingBridge = startNativeMemoryBridge([source], {
			agentId: "agent-native",
			pollIntervalMs: 0,
			...embeddingOptions,
		});
		const manualBridge = startNativeMemoryBridge([source], {
			agentId: "agent-native",
			pollIntervalMs: 0,
			...embeddingOptions,
		});
		try {
			const pollingRun = pollingBridge.syncExisting();
			for (let attempt = 0; attempt < 200 && !embeddingStarted; attempt++) await Bun.sleep(10);
			expect(embeddingStarted).toBe(true);
			const manualRun = manualBridge.syncExisting();
			await Bun.sleep(20);
			expect(providerCalls).toBe(3); // two availability probes and one file embedding from the polling scan
			expect(probeCalls).toBe(2);
			expect(embeddingCalls).toBe(1);
			releaseEmbedding();
			expect(await pollingRun).toBe(1);
			expect(await manualRun).toBe(1);
			expect(providerCalls).toBe(3);
		} finally {
			releaseEmbedding();
			await pollingBridge.close();
			await manualBridge.close();
		}
	});

	it("resumes a paused source from its durable checkpoint after provider recovery", async () => {
		const root = join(dir, "checkpoint-vault");
		const first = join(root, "permanent", "A.md");
		const second = join(root, "permanent", "B.md");
		mkdirSync(join(root, "permanent"), { recursive: true });
		writeFileSync(first, "# Checkpoint A\n\nThe first note completes before the provider fails.\n");
		writeFileSync(
			second,
			"# Checkpoint B\n\nThe second note resumes after recovery and contains enough durable source text to require an embedding checkpoint.\n",
		);
		let failSecond = true;
		let chunkCalls = 0;
		const calls: string[] = [];
		const indexed: string[] = [];
		const source = obsidianNativeMemorySource(root, "Checkpoint Vault", "obsidian:checkpoint");
		const makeHandle = () =>
			startNativeMemoryBridge([source], {
				agentId: "agent-native",
				pollIntervalMs: 0,
				sourceGraphEnabled: false,
				embeddingConfig: {
					provider: "native",
					model: "checkpoint-model",
					dimensions: 3,
					base_url: "",
					profile: "checkpoint",
				},
				fetchEmbedding: async (text, _cfg, _role, options) => {
					calls.push(text);
					if (text.trim().length > 0) {
						chunkCalls++;
						if (failSecond && chunkCalls === 2) {
							options?.onFailure?.("provider_unavailable");
							return null;
						}
					}
					return [1, 2, 3];
				},
				onFileIndexed: (event) => indexed.push(event.filePath),
			});
		const firstHandle = makeHandle();
		try {
			expect(await firstHandle.syncExisting()).toBe(2);
			expect(indexed).toContain(first);
			expect(indexed).toContain(second);
			expect(
				await getDbAccessor().withReadDbAsync(
					(db) =>
						db
							.prepare(
								"SELECT status, checkpoint_path, pause_reason FROM native_source_sync_state WHERE agent_id = ? AND source_key = ?",
							)
							.get("agent-native", "obsidian:checkpoint") as {
							status: string;
							checkpoint_path: string | null;
							pause_reason: string | null;
						},
				),
			).toEqual({ status: "paused", checkpoint_path: first, pause_reason: "provider_unavailable" });
		} finally {
			await firstHandle.close();
		}

		failSecond = false;
		resetEmbeddingCircuitBreakers();
		resetObsidianSourceEmbeddingBackoff();
		const callsBeforeRecovery = calls.length;
		const indexedBeforeRecovery = indexed.length;
		const recovered = makeHandle();
		try {
			expect(await recovered.syncExisting()).toBe(1);
			expect(indexed.slice(indexedBeforeRecovery)).toEqual([second]);
			expect(calls.slice(callsBeforeRecovery).some((text) => text.includes("Checkpoint A"))).toBe(false);
			expect(calls.slice(callsBeforeRecovery).some((text) => text.includes("Checkpoint B"))).toBe(true);
			expect(
				await getDbAccessor().withReadDbAsync(
					(db) =>
						db
							.prepare(
								"SELECT status, checkpoint_path, pause_reason FROM native_source_sync_state WHERE agent_id = ? AND source_key = ?",
							)
							.get("agent-native", "obsidian:checkpoint") as {
							status: string;
							checkpoint_path: string | null;
							pause_reason: string | null;
						},
				),
			).toEqual({ status: "running", checkpoint_path: null, pause_reason: null });
		} finally {
			await recovered.close();
		}
	});

	it("bounds worker-owned provider probes across a multi-file outage", async () => {
		const root = join(dir, "worker-owned-provider-vault");
		mkdirSync(join(root, "notes"), { recursive: true });
		const files = ["A.md", "B.md", "C.md"].map((name) => join(root, "notes", name));
		for (const [index, file] of files.entries())
			writeFileSync(file, `# Note ${index}\n\nThis source remains safe while embeddings are unavailable.\n`);
		const source = obsidianNativeMemorySource(root, "Worker-owned Provider Vault", "obsidian:worker-owned-provider");
		let providerCalls = 0;
		const provider = Bun.serve({
			port: 0,
			fetch: () => {
				providerCalls++;
				return new Response("provider unavailable", { status: 503 });
			},
		});
		const bridge = startNativeMemoryBridge([source], {
			agentId: "agent-worker-owned-provider",
			pollIntervalMs: 0,
			maxFilesPerScan: files.length,
			workerOwnedIndexing: true,
			embeddingConfig: {
				provider: "openai",
				model: "worker-owned-outage",
				dimensions: 3,
				base_url: `http://127.0.0.1:${provider.port}/v1`,
				api_key: "test",
			},
			fetchEmbedding: async () => [9, 9, 9],
		});
		try {
			expect(await bridge.syncExisting()).toBe(1);
			expect(providerCalls).toBe(1);
			expect(bridge.getLastSyncResult()).toMatchObject({
				status: "paused",
				pausedSources: [{ pauseReason: "provider_unavailable", scanned: 1, indexed: 1 }],
			});
			expect(await bridge.syncExisting()).toBe(0);
			expect(providerCalls).toBe(1);
			expect(bridge.getLastSyncResult()).toMatchObject({
				status: "paused",
				pausedSources: [{ pauseReason: "provider_unavailable", scanned: 0, indexed: 0 }],
			});
			const rows = await dbOwnerQuery<readonly { readonly source_path: string }[]>(
				ownerStatement(
					"SELECT source_path FROM memory_artifacts WHERE agent_id = ? ORDER BY source_path",
					["agent-worker-owned-provider"],
					"all",
				),
				{ operation: "test.worker-owned-provider.artifacts", lane: "read" },
			);
			expect(rows).toHaveLength(1);
			const graphRows = await dbOwnerQuery<readonly { readonly count: number }[]>(
				ownerStatement(
					"SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND entity_type = 'source_document'",
					["agent-worker-owned-provider"],
					"all",
				),
				{ operation: "test.worker-owned-provider.graph", lane: "read" },
			);
			expect(graphRows[0]?.count).toBeGreaterThan(0);
			const checkpoint = await dbOwnerQuery<readonly { readonly frontier: string | null; readonly complete: number }[]>(
				ownerStatement(
					"SELECT frontier, complete FROM source_sync_checkpoints WHERE agent_id = ? AND source_key = ? AND phase = 'content'",
					["agent-worker-owned-provider", `agent-worker-owned-provider:obsidian:${root}`],
					"all",
				),
				{ operation: "test.worker-owned-provider.checkpoint", lane: "read" },
			);
			expect(checkpoint[0]?.complete).toBe(0);
			expect(JSON.parse(checkpoint[0]?.frontier ?? "[]")).toEqual(expect.arrayContaining(files));
		} finally {
			await bridge.close();
			provider.stop();
		}
	});

	it("leaves a provider-failed descriptor pending for restart after a mid-batch failure", async () => {
		const root = join(dir, "mid-batch-provider-vault");
		const file = join(root, "permanent", "Pending.md");
		mkdirSync(join(root, "permanent"), { recursive: true });
		const content =
			"# First section\n\nThe first chunk completes before the provider fails. It contains enough source text to be embedded independently.\n\n" +
			"## Second section\n\nThe second chunk fails during the same descriptor and must remain pending for the next daemon run.\n";
		writeFileSync(file, content);
		const source = obsidianNativeMemorySource(root, "Mid-batch Provider Vault", "obsidian:mid-batch-provider");
		const chunks = buildObsidianSourceChunks({ sourceId: source.sourceId ?? "", root, filePath: file, content });
		expect(chunks.length).toBeGreaterThan(1);
		let failSecondChunk = true;
		const calls: string[] = [];
		const provider = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body = (await request.json()) as { readonly input?: string | readonly string[] };
				const text = typeof body.input === "string" ? body.input : (body.input?.join("\n") ?? "");
				calls.push(text);
				if (failSecondChunk && text.includes("Second section"))
					return new Response("provider unavailable", { status: 503 });
				return Response.json({ data: [{ embedding: [1, 2, 3] }] });
			},
		});
		const makeHandle = () =>
			startNativeMemoryBridge([source], {
				agentId: "agent-mid-batch-provider",
				pollIntervalMs: 0,
				maxFilesPerScan: 1,
				sourceGraphEnabled: false,
				workerOwnedIndexing: true,
				embeddingConfig: {
					provider: "openai",
					model: "mid-batch",
					dimensions: 3,
					base_url: `http://127.0.0.1:${provider.port}/v1`,
					api_key: "test",
				},
				fetchEmbedding: async (text) => {
					calls.push(`parent:${text}`);
					return [9, 9, 9];
				},
			});

		const first = makeHandle();
		try {
			expect(await first.syncExisting()).toBe(1);
		} finally {
			await first.close();
		}

		const checkpointRows = await dbOwnerQuery<
			readonly { readonly cursor: string | null; readonly frontier: string | null; readonly complete: number }[]
		>(
			ownerStatement(
				"SELECT cursor, frontier, complete FROM source_sync_checkpoints WHERE agent_id = ? AND source_key = ? AND phase = 'content'",
				["agent-mid-batch-provider", `agent-mid-batch-provider:obsidian:${root}`],
				"all",
			),
			{ operation: "test.mid-batch-provider.checkpoint", lane: "read" },
		);
		const checkpoint = checkpointRows[0] ?? null;
		expect(checkpoint).not.toBeNull();
		expect(checkpoint?.cursor).toBeNull();
		expect(JSON.parse(checkpoint?.frontier ?? "[]")).toContain(file);
		expect(checkpoint?.complete).toBe(0);

		failSecondChunk = false;
		resetEmbeddingCircuitBreakers();
		resetObsidianSourceEmbeddingBackoff();
		const callsBeforeRecovery = calls.length;
		const recovered = makeHandle();
		try {
			expect(await recovered.syncExisting()).toBe(0);
		} finally {
			await recovered.close();
		}
		expect(calls.slice(callsBeforeRecovery).some((text) => text.includes("Second section"))).toBe(true);
		provider.stop();
	});

	it("purges all artifacts below a disconnected Obsidian source root", async () => {
		const root = join(dir, "vault");
		const source = obsidianNativeMemorySource(root, "Research Vault");
		const fileA = join(root, "permanent", "Signet.md");
		const fileB = join(root, "fleeting", "Idea.md");
		const outsideRoot = join(dir, "other-vault");
		const outsideFile = join(outsideRoot, "Keep.md");
		mkdirSync(join(root, "permanent"), { recursive: true });
		mkdirSync(join(root, "fleeting"), { recursive: true });
		mkdirSync(outsideRoot, { recursive: true });
		writeFileSync(fileA, "# Signet\n\nRemove this source artifact.\n");
		writeFileSync(fileB, "# Idea\n\nRemove this source artifact too.\n");
		writeFileSync(outsideFile, "# Other\n\nKeep this source artifact.\n");

		expect(await indexNativeMemoryFile(source, fileA, "agent-native")).toBe(true);
		expect(await indexNativeMemoryFile(source, fileB, "agent-native")).toBe(true);
		expect(await indexNativeMemoryFile(obsidianNativeMemorySource(outsideRoot), outsideFile, "agent-native")).toBe(
			true,
		);

		const purged = await purgeNativeMemorySourceArtifacts(source, "agent-native");

		expect(purged).toBeGreaterThanOrEqual(2);
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT source_path FROM memory_artifacts WHERE agent_id = ? ORDER BY source_path")
					.all("agent-native") as {
					source_path: string;
				}[],
		);
		expect(rows).toEqual([{ source_path: outsideFile }]);
	});

	it("purges source artifacts without treating wildcard characters in roots as LIKE patterns", async () => {
		const root = join(dir, "vault_%");
		const siblingRoot = join(dir, "vault_AX");
		const source = obsidianNativeMemorySource(root, "Wildcard Vault", "obsidian:wildcard-vault");
		const siblingSource = obsidianNativeMemorySource(siblingRoot, "Sibling Vault", "obsidian:sibling-vault");
		const file = join(root, "notes", "Remove.md");
		const siblingFile = join(siblingRoot, "notes", "Keep.md");
		mkdirSync(join(root, "notes"), { recursive: true });
		mkdirSync(join(siblingRoot, "notes"), { recursive: true });
		writeFileSync(file, "# Remove\n\nOnly this wildcard-root source artifact should be purged.\n");
		writeFileSync(siblingFile, "# Keep\n\nThis sibling source artifact should not be matched by SQL wildcards.\n");

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		expect(await indexNativeMemoryFile(siblingSource, siblingFile, "agent-native")).toBe(true);

		const purged = await purgeNativeMemorySourceArtifacts(source, "agent-native");

		expect(purged).toBeGreaterThanOrEqual(1);
		const remaining = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT source_path FROM memory_artifacts WHERE agent_id = ? ORDER BY source_path")
					.all("agent-native") as Array<{ source_path: string }>,
		);
		expect(remaining).toEqual([{ source_path: siblingFile }]);
	});

	it("purges a disconnected source across source-owned agent scopes when no agent id is supplied", async () => {
		const root = join(dir, "vault");
		const source = obsidianNativeMemorySource(root, "Research Vault", "obsidian:cross-agent-vault");
		const fileA = join(root, "AgentA.md");
		const fileB = join(root, "AgentB.md");
		mkdirSync(root, { recursive: true });
		writeFileSync(fileA, "# Agent A\n\nRemove this source artifact.\n");
		writeFileSync(fileB, "# Agent B\n\nRemove this source artifact too.\n");

		expect(await indexNativeMemoryFile(source, fileA, "agent-a")).toBe(true);
		expect(await indexNativeMemoryFile(source, fileB, "agent-b")).toBe(true);

		const purged = await purgeNativeMemorySourceArtifacts(source);

		expect(purged).toBeGreaterThanOrEqual(2);
		const remaining = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE harness = 'obsidian' AND source_path LIKE ?")
					.get(`${root.replace(/\\/g, "/")}/%`) as { count: number },
		);
		expect(remaining.count).toBe(0);
	});

	it("purges previously indexed Obsidian files that become excluded after restart", async () => {
		const root = join(dir, "vault");
		const privateFile = join(root, "private", "Secret.md");
		mkdirSync(join(root, "private"), { recursive: true });
		writeFileSync(
			privateFile,
			"# Secret\n\nPreviously indexed private source content with enough text for source chunk embeddings.\n",
		);
		const addedInitial = addObsidianSource({ root, name: "Exclude Vault", excludeGlobs: [] }, dir);
		expect(addedInitial.ok).toBe(true);
		if (addedInitial.ok === false) throw new Error(addedInitial.error);
		const sourceId = addedInitial.source.id;
		const initialSource = obsidianNativeMemorySource(root, "Exclude Vault", sourceId, []);

		expect(
			await indexNativeMemoryFile(initialSource, privateFile, "agent-native", {
				embeddingConfig: { provider: "native", model: "test", dimensions: 3, base_url: "", profile: "test" },
				fetchEmbedding: async () => [1, 2, 3],
			}),
		).toBe(true);

		const before = getDbAccessor().withReadDb((db) => ({
			artifacts: (
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0",
					)
					.get("agent-native", privateFile) as { count: number }
			).count,
			chunks: (
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM embeddings WHERE agent_id = ? AND source_type = 'source_chunk' AND source_id >= ? AND source_id < ?",
					)
					.get("agent-native", `${sourceId}:`, `${sourceId}:\uffff`) as { count: number }
			).count,
			entities: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND source_path = ?")
					.get("agent-native", privateFile) as { count: number }
			).count,
		}));
		expect(before.artifacts).toBe(1);
		expect(before.chunks).toBeGreaterThan(0);
		expect(before.entities).toBeGreaterThan(0);

		const added = addObsidianSource({ root, name: "Exclude Vault", excludeGlobs: ["private/**"] }, dir);
		expect(added.ok).toBe(true);
		if (added.ok === false) throw new Error(added.error);

		const handle = startNativeMemoryBridge([codexNativeMemorySource(join(dir, ".codex"))], {
			agentId: "agent-native",
			agentsDir: dir,
			includeConfiguredSources: true,
			pollIntervalMs: 0,
		});
		try {
			expect(await handle.syncExisting()).toBe(0);
		} finally {
			await handle.close();
		}

		const after = getDbAccessor().withReadDb((db) => ({
			artifacts: (
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0",
					)
					.get("agent-native", privateFile) as { count: number }
			).count,
			chunks: (
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM embeddings WHERE agent_id = ? AND source_type = 'source_chunk' AND source_id >= ? AND source_id < ?",
					)
					.get("agent-native", `${sourceId}:`, `${sourceId}:\uffff`) as { count: number }
			).count,
			entities: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND source_path = ?")
					.get("agent-native", privateFile) as { count: number }
			).count,
		}));
		expect(after).toEqual({ artifacts: 0, chunks: 0, entities: 0 });
	});

	it("does not mark a configured Obsidian source indexed when the root is missing", async () => {
		const root = join(dir, "missing-vault");
		mkdirSync(root, { recursive: true });
		const added = addObsidianSource({ root, name: "Missing Vault" }, dir);
		expect(added.ok).toBe(true);
		rmSync(root, { recursive: true, force: true });

		const handle = startNativeMemoryBridge([codexNativeMemorySource(join(dir, ".codex"))], {
			agentId: "agent-native",
			agentsDir: dir,
			includeConfiguredSources: true,
			pollIntervalMs: 0,
		});
		try {
			expect(await handle.syncExisting()).toBe(0);
			const stored = loadSourcesConfig(dir).sources.find((source) => source.root === root);
			expect(stored?.lastIndexedAt).toBeUndefined();
		} finally {
			await handle.close();
		}
	});

	it("reloads configured Obsidian sources on each sync and updates them in place", async () => {
		const root = join(dir, "vault");
		const file = join(root, "permanent", "Live.md");
		mkdirSync(join(root, "permanent"), { recursive: true });
		writeFileSync(file, "# Live\n\nInitial source text.\n");
		const added = addObsidianSource({ root, name: "Live Vault" }, dir);
		expect(added.ok).toBe(true);

		const handle = startNativeMemoryBridge([codexNativeMemorySource(join(dir, ".codex"))], {
			agentId: "agent-native",
			agentsDir: dir,
			includeConfiguredSources: true,
			pollIntervalMs: 0,
		});
		try {
			expect(await handle.syncExisting()).toBe(1);
			writeFileSync(file, "# Live\n\nUpdated source text.\n");
			expect(await handle.syncExisting()).toBe(1);
			const row = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT content FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
						.get("agent-native", file) as { content: string },
			);
			expect(row.content).toContain("Updated source text");
		} finally {
			await handle.close();
		}
	});

	it("can sync configured Obsidian sources without scanning harness memory roots", async () => {
		const codexRoot = join(dir, ".codex");
		const codexFile = join(codexRoot, "memories", "memory_summary.md");
		mkdirSync(join(codexRoot, "memories"), { recursive: true });
		writeFileSync(codexFile, "Codex memory should not be pulled into source-only startup scans.\n");
		const vault = join(dir, "vault");
		const vaultFile = join(vault, "literature", "Source Note.md");
		mkdirSync(join(vault, "literature"), { recursive: true });
		writeFileSync(vaultFile, "# Source Note\n\nSource-only bridge scans should still index configured vault files.\n");
		const added = addObsidianSource({ root: vault, name: "Source Vault" }, dir);
		expect(added.ok).toBe(true);

		const handle = startNativeMemoryBridge([], {
			agentId: "agent-native",
			agentsDir: dir,
			includeConfiguredSources: true,
			pollIntervalMs: 0,
		});
		try {
			expect(await handle.syncExisting()).toBe(1);
			const rows = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT harness, source_path FROM memory_artifacts ORDER BY source_path").all() as Array<{
						harness: string;
						source_path: string;
					}>,
			);
			expect(rows).toEqual([{ harness: "obsidian", source_path: vaultFile }]);
		} finally {
			await handle.close();
		}
	});

	it("reports per-source file progress when a bridge scans multiple sources", async () => {
		const vaultA = join(dir, "vault-a");
		const vaultB = join(dir, "vault-b");
		mkdirSync(join(vaultA, "notes"), { recursive: true });
		mkdirSync(join(vaultB, "notes"), { recursive: true });
		writeFileSync(join(vaultA, "notes", "A1.md"), "# A1\n\nFirst vault note.");
		writeFileSync(join(vaultA, "notes", "A2.md"), "# A2\n\nSecond vault note.");
		writeFileSync(join(vaultB, "notes", "B1.md"), "# B1\n\nThird vault note.");
		const events: Array<{ sourceId?: string; scanned: number; total: number; changed: number }> = [];
		const handle = startNativeMemoryBridge(
			[
				obsidianNativeMemorySource(vaultA, "Vault A", "obsidian:vault-a"),
				obsidianNativeMemorySource(vaultB, "Vault B", "obsidian:vault-b"),
			],
			{
				agentId: "agent-native",
				pollIntervalMs: 0,
				onFileIndexed: (event) => {
					events.push({
						sourceId: event.source.sourceId,
						scanned: event.scanned,
						total: event.total,
						changed: event.changed,
					});
				},
			},
		);
		try {
			expect(await handle.syncExisting()).toBe(3);
			expect(events).toEqual([
				{ sourceId: "obsidian:vault-a", scanned: 1, total: 2, changed: 1 },
				{ sourceId: "obsidian:vault-a", scanned: 2, total: 2, changed: 2 },
				{ sourceId: "obsidian:vault-b", scanned: 1, total: 1, changed: 1 },
			]);
		} finally {
			await handle.close();
		}
	});

	it("streams a large source path set without collecting all files first", async () => {
		const root = join(dir, "large-vault");
		mkdirSync(root, { recursive: true });
		for (let index = 0; index < 1_000; index++) {
			writeFileSync(join(root, `note-${index}.md`), `# Note ${index}\n\nStreaming source note ${index}.`);
		}
		let firstFileSeen = false;
		let indexed = 0;
		const handle = startNativeMemoryBridge([obsidianNativeMemorySource(root, "Large Vault", "obsidian:large-vault")], {
			agentId: "agent-native",
			pollIntervalMs: 0,
			sourceFileDelayMs: 0,
			sourceGraphEnabled: false,
			onFileIndexed: () => {
				firstFileSeen = true;
				indexed++;
			},
		});
		try {
			expect(await handle.syncExisting()).toBe(1_000);
			expect(firstFileSeen).toBe(true);
			expect(indexed).toBe(1_000);
		} finally {
			await handle.close();
		}
	}, 30_000);

	it("coalesces overlapping source sync requests and runs one trailing resync", async () => {
		const root = join(dir, "vault");
		const file = join(root, "permanent", "Burst.md");
		mkdirSync(join(root, "permanent"), { recursive: true });
		writeFileSync(
			file,
			"# Burst\n\nFirst version with enough durable source context to produce an embedded chunk before the overlapping write arrives.\n",
		);
		const source = obsidianNativeMemorySource(root, "Burst Vault", "obsidian:burst-vault");
		let embeddingCalls = 0;
		let handle!: ReturnType<typeof startNativeMemoryBridge>;
		handle = startNativeMemoryBridge([source], {
			agentId: "agent-native",
			pollIntervalMs: 0,
			embeddingConfig: { provider: "native", model: "test", dimensions: 3, base_url: "", profile: "test" },
			fetchEmbedding: async () => {
				embeddingCalls++;
				if (embeddingCalls === 1) {
					writeFileSync(file, "# Burst\n\nSecond version after overlapping change.\n");
					void handle.syncExisting();
					await Bun.sleep(5);
				}
				return [1, 2, 3];
			},
		});
		try {
			await handle.syncExisting();
			const row = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT content FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
						.get("agent-native", file) as { content: string },
			);
			expect(row.content).toContain("Second version after overlapping change");
		} finally {
			await handle.close();
		}
	});

	it("does not let polling ticks queue trailing full rescans while a source sync is already running", async () => {
		const root = join(dir, "vault");
		const file = join(root, "permanent", "Slow.md");
		mkdirSync(join(root, "permanent"), { recursive: true });
		writeFileSync(
			file,
			"# Slow\n\nA slow source embedding request gives the polling timer enough time to fire while the first scan is still in flight.\n",
		);
		const events: Array<{ scanned: number; total: number }> = [];
		const handle = startNativeMemoryBridge([obsidianNativeMemorySource(root, "Slow Vault", "obsidian:slow-vault")], {
			agentId: "agent-native",
			pollIntervalMs: 1,
			embeddingConfig: { provider: "native", model: "test", dimensions: 3, base_url: "", profile: "test" },
			fetchEmbedding: async () => {
				await Bun.sleep(20);
				return [1, 2, 3];
			},
			onFileIndexed: (event) => {
				events.push({ scanned: event.scanned, total: event.total });
			},
		});
		try {
			expect(await handle.syncExisting()).toBe(1);
			expect(events).toEqual([{ scanned: 1, total: 1 }]);
		} finally {
			await handle.close();
		}
	});

	it("keeps a 200-file mixed-size source scan off parent sync surfaces", async () => {
		const root = join(dir, "large-source");
		mkdirSync(root, { recursive: true });
		for (let index = 0; index < 200; index += 1) {
			const content =
				index % 3 === 0
					? `# Small ${index}\n\nSmall native memory note ${index}.\n`
					: index % 3 === 1
						? `# Medium ${index}\n\n${"Medium native memory content. ".repeat(5)}\n`
						: `# Large ${index}\n\n${"Large native memory content. ".repeat(15)}\n`;
			writeFileSync(join(root, `note-${index}.md`), content);
		}
		const accessor = getDbAccessor() as typeof getDbAccessor extends () => infer T
			? T & Record<string, unknown>
			: never;
		const originalRead = accessor.withReadDb;
		const originalWrite = accessor.withWriteTx;
		let parentCrossings = 0;
		(accessor as Record<string, unknown>).withReadDb = (..._args: unknown[]) => {
			parentCrossings += 1;
			throw new Error("parent synchronous SQLite crossed during native source sync");
		};
		(accessor as Record<string, unknown>).withWriteTx = (..._args: unknown[]) => {
			parentCrossings += 1;
			throw new Error("parent synchronous SQLite crossed during native source sync");
		};
		const criticalWarnings: string[] = [];
		const originalWarn = logger.warn;
		const originalInfo = logger.info;
		logger.warn = ((_category: unknown, message: unknown) => {
			if (/critical|event.?loop|block/i.test(String(message))) criticalWarnings.push(String(message));
		}) as typeof logger.warn;
		logger.info = (() => {}) as typeof logger.info;
		const handle = startNativeMemoryBridge(
			[obsidianNativeMemorySource(root, "Large source", "obsidian:large-source")],
			{
				agentId: "agent-native",
				pollIntervalMs: 0,
				sourceFileDelayMs: 0,
				sourceGraphEnabled: false,
				workerOwnedIndexing: true,
			},
		);
		try {
			expect(await handle.syncExisting()).toBe(200);
			expect(parentCrossings).toBe(0);
			const implementation = readFileSync(new URL("./native-memory-sources.ts", import.meta.url), "utf8");
			const indexingPath = implementation.slice(
				implementation.indexOf("export async function indexNativeMemoryFile"),
				implementation.indexOf("export async function removeNativeMemoryFile"),
			);
			expect(indexingPath).not.toMatch(/\b(?:readFileSync|statSync|lstatSync|createHash)\b/);
			expect(implementation).not.toContain('from "node:crypto"');
			// This is the runtime attribution shim: warnings are inspected by
			// category/message rather than inferred from elapsed wall-clock time.
			expect(criticalWarnings).toEqual([]);
		} finally {
			logger.warn = originalWarn;
			logger.info = originalInfo;
			(accessor as Record<string, unknown>).withReadDb = originalRead;
			(accessor as Record<string, unknown>).withWriteTx = originalWrite;
			await handle.close();
		}
	}, 5_000);

	it("resumes from the committed per-file worker frontier after a capped scan", async () => {
		const root = join(dir, "resume-frontier-source");
		mkdirSync(root, { recursive: true });
		for (let index = 0; index < 3; index += 1) {
			writeFileSync(join(root, `note-${index}.md`), `# Resume ${index}\n\nfrontier ${index}\n`);
		}
		const source = obsidianNativeMemorySource(root, "Resume source", "obsidian:resume-frontier");
		const first = startNativeMemoryBridge([source], {
			agentId: "agent-resume-frontier",
			pollIntervalMs: 0,
			maxFilesPerScan: 1,
			sourceGraphEnabled: false,
		});
		try {
			expect(await first.syncExisting()).toBe(1);
		} finally {
			await first.close();
		}

		const checkpointRows = await dbOwnerQuery<
			readonly { readonly cursor: string | null; readonly frontier: string | null; readonly complete: number }[]
		>(
			ownerStatement(
				"SELECT cursor, frontier, complete FROM source_sync_checkpoints WHERE agent_id = ? AND source_key = ? AND phase = 'content'",
				["agent-resume-frontier", `agent-resume-frontier:obsidian:${root}`],
				"all",
			),
			{ operation: "test.resume-frontier.checkpoint", lane: "read" },
		);
		const checkpoint = checkpointRows[0] ?? null;
		expect(checkpoint?.cursor).toContain("note-");
		expect(JSON.parse(checkpoint?.frontier ?? "[]")).not.toContain(root);
		expect(checkpoint?.complete).toBe(0);

		const second = startNativeMemoryBridge([source], {
			agentId: "agent-resume-frontier",
			pollIntervalMs: 0,
			maxFilesPerScan: 1,
			sourceGraphEnabled: false,
		});
		try {
			expect(await second.syncExisting()).toBe(1);
		} finally {
			await second.close();
		}
		const artifactRows = await dbOwnerQuery<readonly { readonly count: number }[]>(
			ownerStatement(
				"SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ?",
				["agent-resume-frontier"],
				"all",
			),
			{ operation: "test.resume-frontier.artifacts", lane: "read" },
		);
		const artifactCount = artifactRows[0]?.count ?? 0;
		expect(artifactCount).toBe(2);
	});

	it("resumes from the durable frontier after the source worker is killed during traversal", async () => {
		const root = join(dir, "killed-resume-source");
		mkdirSync(root, { recursive: true });
		for (let index = 0; index < 3; index += 1) {
			writeFileSync(join(root, `note-${index}.md`), `# Killed ${index}\n\nworker resume ${index}\n`);
		}
		const source = obsidianNativeMemorySource(root, "Killed resume source", "obsidian:killed-resume");
		const firstIndexed: string[] = [];
		let scanStarts = 0;
		const first = startNativeMemoryBridge([source], {
			agentId: "agent-killed-resume",
			pollIntervalMs: 0,
			maxFilesPerScan: 1,
			sourceGraphEnabled: false,
			onSourceWorkerScanStarted: () => {
				scanStarts += 1;
				// The first scan commits note-0. The second scan is killed from
				// the worker-start event, before its descriptor is returned.
				if (scanStarts === 2) first.cancel();
			},
			onFileIndexed: ({ filePath }) => firstIndexed.push(filePath),
		});
		expect(await first.syncExisting()).toBe(1);
		await expect(first.syncExisting()).rejects.toThrow(/native source sync cancelled|native source worker/);
		await first.close();
		expect(firstIndexed).toHaveLength(1);

		const checkpointRows = await dbOwnerQuery<
			readonly { readonly frontier: string | null; readonly complete: number }[]
		>(
			ownerStatement(
				"SELECT frontier, complete FROM source_sync_checkpoints WHERE agent_id = ? AND source_key = ? AND phase = 'content'",
				["agent-killed-resume", `agent-killed-resume:obsidian:${root}`],
				"all",
			),
			{ operation: "test.native-memory-resume-checkpoint", lane: "read" },
		);
		const checkpoint = checkpointRows[0] ?? null;
		expect(checkpoint).not.toBeNull();
		const frontier: unknown = JSON.parse(checkpoint?.frontier ?? "null");
		expect(Array.isArray(frontier)).toBe(true);
		expect(frontier).toHaveLength(2);
		expect(frontier).not.toContain(root);
		expect(checkpoint?.complete).toBe(0);

		const restartedIndexed: string[] = [];
		const restarted = startNativeMemoryBridge([source], {
			agentId: "agent-killed-resume",
			pollIntervalMs: 0,
			maxFilesPerScan: 1,
			sourceGraphEnabled: false,
			onFileIndexed: ({ filePath }) => restartedIndexed.push(filePath),
		});
		try {
			expect(await restarted.syncExisting()).toBe(1);
		} finally {
			await restarted.close();
		}
		expect(restartedIndexed).toHaveLength(1);
		expect(restartedIndexed[0]).not.toBe(firstIndexed[0]);
	});

	it("keeps the provider-enabled frontier resumable when traversal is killed", async () => {
		const root = join(dir, "provider-frontier-source");
		mkdirSync(root, { recursive: true });
		const firstPath = join(root, "note-a.md");
		const secondPath = join(root, "note-b.md");
		writeFileSync(firstPath, "# Provider A\n\nProvider frontier first descriptor.\n");
		writeFileSync(secondPath, "# Provider B\n\nProvider frontier next descriptor.\n");
		const provider = Bun.serve({
			port: 0,
			fetch: () => Response.json({ data: [{ embedding: [1, 2, 3] }] }),
		});
		const embeddingConfig = {
			provider: "openai" as const,
			model: "provider-frontier-test",
			dimensions: 3,
			base_url: `http://127.0.0.1:${provider.port}/v1`,
			api_key: "test",
			indexGeneration: "staging" as const,
		};
		const source = obsidianNativeMemorySource(root, "Provider frontier source", "obsidian:provider-frontier");
		let scanStarts = 0;
		const firstIndexed: string[] = [];
		const first = startNativeMemoryBridge([source], {
			agentId: "agent-provider-frontier",
			pollIntervalMs: 0,
			maxFilesPerScan: 1,
			sourceGraphEnabled: false,
			workerOwnedIndexing: false,
			embeddingConfig,
			fetchEmbedding: async () => [9, 9, 9],
			onSourceWorkerScanStarted: () => {
				scanStarts += 1;
				if (scanStarts === 2) first.cancel();
			},
			onFileIndexed: ({ filePath }) => firstIndexed.push(filePath),
		});
		try {
			expect(await first.syncExisting()).toBe(1);
			await expect(first.syncExisting()).rejects.toThrow(/native source sync cancelled|native source worker/);
		} finally {
			await first.close();
		}
		expect(firstIndexed).toEqual([firstPath]);

		const restartedIndexed: string[] = [];
		const restarted = startNativeMemoryBridge([source], {
			agentId: "agent-provider-frontier",
			pollIntervalMs: 0,
			maxFilesPerScan: 1,
			sourceGraphEnabled: false,
			workerOwnedIndexing: false,
			embeddingConfig,
			fetchEmbedding: async () => [9, 9, 9],
			onFileIndexed: ({ filePath }) => restartedIndexed.push(filePath),
		});
		try {
			expect(await restarted.syncExisting()).toBe(1);
		} finally {
			await restarted.close();
			provider.stop();
		}
		expect(restartedIndexed).toEqual([secondPath]);
	});

	it("keeps embedding work and the crash-window frontier in the owner process", async () => {
		const root = join(dir, "owner-embedding-resume-source");
		mkdirSync(root, { recursive: true });
		const firstPath = join(root, "note-a.md");
		const secondPath = join(root, "note-b.md");
		writeFileSync(
			firstPath,
			"# Owner A\n\nThe first owner-indexed source note has enough content for a durable chunk.\n",
		);
		writeFileSync(
			secondPath,
			"# Owner B\n\nThe second owner-indexed source note proves restart resumes at the next frontier.\n",
		);
		const provider = Bun.serve({
			port: 0,
			fetch: () => Response.json({ data: [{ embedding: [1, 2, 3] }] }),
		});
		let parentEmbeddingCalls = 0;
		const source = obsidianNativeMemorySource(root, "Owner embedding source", "obsidian:owner-embedding");
		const embeddingConfig = {
			provider: "openai" as const,
			model: "owner-test",
			dimensions: 3,
			base_url: `http://127.0.0.1:${provider.port}/v1`,
			api_key: "test",
			indexGeneration: "staging" as const,
		};
		const firstIndexed: string[] = [];
		const first = startNativeMemoryBridge([source], {
			agentId: "agent-owner-embedding",
			pollIntervalMs: 0,
			maxFilesPerScan: 2,
			sourceGraphEnabled: false,
			workerOwnedIndexing: true,
			embeddingConfig,
			fetchEmbedding: async () => {
				parentEmbeddingCalls++;
				return [9, 9, 9];
			},
			onFileIndexed: ({ filePath }) => {
				firstIndexed.push(filePath);
				if (firstIndexed.length === 1) first.cancel();
			},
		});
		try {
			await expect(first.syncExisting()).rejects.toThrow(/native source sync cancelled|native source worker/);
		} finally {
			await first.close();
		}
		expect(parentEmbeddingCalls).toBe(0);
		expect(firstIndexed).toHaveLength(1);
		const checkpoint = await dbOwnerQuery<readonly { readonly frontier: string | null; readonly complete: number }[]>(
			ownerStatement(
				"SELECT frontier, complete FROM source_sync_checkpoints WHERE agent_id = ? AND source_key = ? AND phase = 'content'",
				["agent-owner-embedding", `agent-owner-embedding:obsidian:${root}`],
				"all",
			),
			{ operation: "test.owner-embedding.frontier", lane: "read" },
		);
		expect(JSON.parse(checkpoint[0]?.frontier ?? "[]")).toHaveLength(1);
		expect(checkpoint[0]?.complete).toBe(0);

		const restartedIndexed: string[] = [];
		const restarted = startNativeMemoryBridge([source], {
			agentId: "agent-owner-embedding",
			pollIntervalMs: 0,
			maxFilesPerScan: 1,
			sourceGraphEnabled: false,
			workerOwnedIndexing: true,
			embeddingConfig,
			fetchEmbedding: async () => {
				parentEmbeddingCalls++;
				return [9, 9, 9];
			},
			onFileIndexed: ({ filePath }) => restartedIndexed.push(filePath),
		});
		try {
			expect(await restarted.syncExisting()).toBe(1);
		} finally {
			await restarted.close();
			provider.stop();
		}
		expect(restartedIndexed).toEqual([secondPath]);
		expect(parentEmbeddingCalls).toBe(0);
	});

	it("kills only the source worker and leaves the DB owner usable", async () => {
		const root = join(dir, "killable-source");
		mkdirSync(root, { recursive: true });
		for (let index = 0; index < 5_000; index += 1) {
			writeFileSync(
				join(root, `note-${index}.md`),
				`# Note ${index}\n\nA source worker kill must not kill the database owner.\n`,
			);
		}
		const handle = startNativeMemoryBridge(
			[obsidianNativeMemorySource(root, "Killable source", "obsidian:killable-source")],
			{
				agentId: "agent-native",
				pollIntervalMs: 0,
				maxFilesPerScan: 1,
			},
		);
		const sync = handle.syncExisting();
		handle.cancel();
		await expect(sync).rejects.toThrow(/native source (worker|sync)/);
		expect(
			await dbOwnerQuery<{ readonly value: number }>(ownerStatement("SELECT 1 AS value", [], "get"), {
				operation: "test.parent-remains-serviceable",
				lane: "read",
			}),
		).toEqual({ value: 1 });
		await handle.close();
	});
});

describe("resolveEmbeddingBridgeOptions", () => {
	const fetchEmbedding = async () => [1, 2, 3];

	it("wires embeddingConfig and fetchEmbedding through when an embedding provider is configured", () => {
		const options = resolveEmbeddingBridgeOptions(
			{ provider: "native", model: "test", dimensions: 3, base_url: "" },
			fetchEmbedding,
		);
		expect(options.embeddingConfig).toEqual({ provider: "native", model: "test", dimensions: 3, base_url: "" });
		expect(options.fetchEmbedding).toBe(fetchEmbedding);
	});

	it("omits embeddingConfig and fetchEmbedding when the embedding provider is 'none'", () => {
		// Regression guard: source-sync callers (daemon startup, manual re-sync
		// routes) must skip embedding wiring when embeddings are disabled, but
		// must NOT skip it merely because a caller forgot to pass the config.
		// This previously caused Obsidian (and other) sources to be recorded in
		// memory_artifacts but never chunked/embedded.
		const options = resolveEmbeddingBridgeOptions(
			{ provider: "none", model: "", dimensions: 0, base_url: "" },
			fetchEmbedding,
		);
		expect(options.embeddingConfig).toBeUndefined();
		expect(options.fetchEmbedding).toBeUndefined();
	});
});
