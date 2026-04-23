import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	codexNativeMemorySource,
	indexNativeMemoryFile,
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
		const root = join(dir, ".codex", "memories");
		mkdirSync(join(root, "rollout_summaries"), { recursive: true });
		const file = join(root, "rollout_summaries", "2026-04-22-test.md");
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

	it("uses the daemon agent id when no explicit agent id is provided", async () => {
		process.env.SIGNET_AGENT_ID = "agent-native";
		const root = join(dir, ".codex", "memories");
		mkdirSync(root, { recursive: true });
		const file = join(root, "memory_summary.md");
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
		const root = join(dir, ".codex", "memories");
		mkdirSync(root, { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "memory_summary.md");
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

	it("does not cache a fingerprint when persistence fails", async () => {
		const root = join(dir, ".codex", "memories");
		mkdirSync(root, { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "memory_summary.md");
		const stamp = new Date("2026-04-22T12:00:00Z");
		writeFileSync(file, "Codex remembered a retryable persistence failure.\n");
		utimesSync(file, stamp, stamp);

		closeDbAccessor();
		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(false);

		initDbAccessor(join(dir, "memory", "memories.db"));
		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
	});

	it("reindexes unchanged native files when the artifact row is missing", async () => {
		const root = join(dir, ".codex", "memories");
		mkdirSync(root, { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "memory_summary.md");
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

	it("indexes native memories when the source root is created after bridge startup", async () => {
		const root = join(dir, ".codex", "memories");
		const handle = startNativeMemoryBridge([codexNativeMemorySource(root)], {
			agentId: "agent-native",
			pollIntervalMs: 25,
		});
		try {
			mkdirSync(root, { recursive: true });
			const file = join(root, "memory_summary.md");
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

	it("skips files outside the declared native memory patterns", async () => {
		const root = join(dir, ".codex", "memories");
		mkdirSync(root, { recursive: true });
		const file = join(root, "notes.md");
		writeFileSync(file, "not a Codex native memory surface");

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file)).toBe(false);
	});
});
