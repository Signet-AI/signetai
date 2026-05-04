import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addObsidianSource, loadSourcesConfig } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	claudeCodeNativeMemorySource,
	codexNativeMemorySource,
	indexNativeMemoryFile,
	obsidianNativeMemorySource,
	purgeNativeMemorySourceArtifacts,
	removeNativeMemoryFile,
	startNativeMemoryBridge,
} from "./native-memory-sources";

describe("native memory sources", () => {
	let dir = "";
	let prevSignetPath: string | undefined;
	let prevSignetAgentId: string | undefined;

	beforeEach(() => {
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
		removeNativeMemoryFile(source, file, "agent-native");
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
		removeNativeMemoryFile(source, file, "agent-native");

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
		removeNativeMemoryFile(source, file, "agent-native");
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

		closeDbAccessor();
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
				db.prepare("SELECT source_path, source_kind, harness, content FROM memory_artifacts").get() as {
					source_path: string;
					source_kind: string;
					harness: string;
					content: string;
				},
		);
		expect(row.source_path).toBe(file);
		expect(row.source_kind).toBe("source_obsidian_markdown");
		expect(row.harness).toBe("obsidian");
		expect(row.content).toContain("Obsidian source knowledge base note");
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

		removeNativeMemoryFile(source, file, "agent-native");

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
					embeddingConfig: { provider: "native", model: "test", dimensions: 3, base_url: "" },
					fetchEmbedding: async () => [1, 2, 3],
				},
			),
		).toBe(true);

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT source_id, chunk_text FROM embeddings WHERE source_type = 'source_obsidian_chunk' ORDER BY source_id",
					)
					.all() as Array<{ source_id: string; chunk_text: string }>,
		);
		expect(rows.length).toBeGreaterThanOrEqual(1);
		expect(rows.every((row) => row.source_id.startsWith("obsidian:test-vault:permanent/Signet.md#"))).toBe(true);
		expect(rows.every((row) => row.chunk_text.includes(`source_path: ${file}`))).toBe(true);
		expect(rows.some((row) => row.chunk_text.includes("heading: Signet Sources"))).toBe(true);
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

		const purged = purgeNativeMemorySourceArtifacts(source, "agent-native");

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

		const purged = purgeNativeMemorySourceArtifacts(source, "agent-native");

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

		const purged = purgeNativeMemorySourceArtifacts(source);

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
				embeddingConfig: { provider: "native", model: "test", dimensions: 3, base_url: "" },
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
						"SELECT COUNT(*) AS count FROM embeddings WHERE agent_id = ? AND source_type = 'source_obsidian_chunk' AND source_id >= ? AND source_id < ?",
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
						"SELECT COUNT(*) AS count FROM embeddings WHERE agent_id = ? AND source_type = 'source_obsidian_chunk' AND source_id >= ? AND source_id < ?",
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
			embeddingConfig: { provider: "native", model: "test", dimensions: 3, base_url: "" },
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
});
