import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
	createNativeSourceWorker,
	NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES,
	NATIVE_SOURCE_WORKER_MAX_SAME_CHECKPOINT_FAILURES,
} from "./native-memory-source-worker";

async function fixture(): Promise<{
	readonly root: string;
	readonly source: {
		readonly root: string;
		readonly files: readonly [{ readonly glob: "**/*.md"; readonly kind: "markdown" }];
	};
}> {
	const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-"));
	await mkdir(join(root, "nested"));
	await writeFile(join(root, "b.md"), "B");
	await writeFile(join(root, "nested", "a.md"), "A");
	return { root, source: { root, files: [{ glob: "**/*.md", kind: "markdown" }] } };
}

async function instrument(root: string): Promise<{ readonly entry: string; readonly stats: string }> {
	const entry = join(root, "worker.ts");
	const stats = join(root, "stats.jsonl");
	await writeFile(stats, "");
	await writeFile(
		entry,
		[
			'import { mock } from "bun:test";',
			'import * as fs from "node:fs/promises";',
			"const realFs = { ...fs };",
			'process.on("exit", () => mock.module("node:fs/promises", () => realFs));',
			"const original = fs.lstat;",
			`mock.module("node:fs/promises", () => ({ ...fs, lstat: async (...args) => { await fs.appendFile(${JSON.stringify(stats)}, JSON.stringify(String(args[0])) + "\\n"); return await original(...args); } }));`,
			`await import(${JSON.stringify(join(import.meta.dir, "native-memory-source-worker.ts"))});`,
		].join("\n"),
	);
	return { entry, stats };
}

async function metadataPaths(path: string): Promise<string[]> {
	return (await readFile(path, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line): string => {
			const value: unknown = JSON.parse(line);
			if (typeof value !== "string") throw new Error("Invalid metadata path");
			return value;
		});
}

describe("native source worker", () => {
	it("admits sparse Claude memories without metadata reads for transcript siblings or restored noise", async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-sparse-"));
		const source = {
			root: join(root, "source"),
			harness: "claude-code",
			sourceId: "claude:test",
			files: [
				{ glob: "projects/*/memory/MEMORY.md", kind: "index" },
				{ glob: "projects/*/memory/**/*.md", kind: "memory", excludeBasenames: ["MEMORY.md"] },
			],
		};
		const expected: { path: string; kind: string; content: string; sourceId: string }[] = [];
		const instrumentation = await instrument(root);
		const worker = createNativeSourceWorker({ resolveEmbeddedPath: () => instrumentation.entry });
		try {
			for (let project = 0; project < 64; project++) {
				const directory = join(source.root, "projects", `repo-${project}`);
				await mkdir(join(directory, "subagents", "deep"), { recursive: true });
				for (let session = 0; session < 64; session++) {
					await writeFile(join(directory, `session-${session}.jsonl`), "transcript");
				}
				await writeFile(join(directory, "subagents", "deep", "noise.md"), "not memory");
				if (project >= 59) continue;
				await mkdir(join(directory, "memory"));
				const path = join(directory, "memory", project === 0 ? "MEMORY.md" : "note.md");
				const content = `memory ${project}`;
				await writeFile(path, content);
				expected.push({ path, content, kind: project === 0 ? "index" : "memory", sourceId: "claude:test" });
			}
			const files = [];
			let page = await worker.scan({ source, cursor: null, pageSize: 100 });
			files.push(...page.files);
			for (let attempt = 0; !page.complete && attempt < 100; attempt++) {
				page = await worker.scan({ source, cursor: page.nextCursor, frontier: page.frontier, pageSize: 100 });
				files.push(...page.files);
			}
			expect(page.complete).toBe(true);
			expect(
				files
					.map(({ path, content, kind, sourceId }) => ({ path, content, kind, sourceId }))
					.sort((a, b) => a.path.localeCompare(b.path)),
			).toEqual(expected.sort((a, b) => a.path.localeCompare(b.path)));
			const restored = await worker.scan({
				source,
				cursor: page.nextCursor,
				frontier: [join(source.root, "projects", "repo-0", "session-0.jsonl"), join(source.root, "plugins", "missing")],
				pageSize: 100,
			});
			expect(restored.files).toEqual([]);
			expect(restored.complete).toBe(true);
			const paths = await metadataPaths(instrumentation.stats);
			expect(paths.filter((path) => path.endsWith(".jsonl"))).toEqual([]);
			expect(paths.filter((path) => path.includes("subagents") || path.includes("plugins"))).toEqual([]);
		} finally {
			await worker.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("checkpoints zero-match traversal within a path budget and resumes across worker restarts", async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-budget-"));
		const source = { root: join(root, "source"), files: [{ glob: "**/*.md", kind: "memory" }] };
		const instrumentation = await instrument(root);
		const expected = [source.root];
		let worker = createNativeSourceWorker({ resolveEmbeddedPath: () => instrumentation.entry });
		try {
			for (let index = 0; index < 400; index++) {
				const directory = join(source.root, `repo-${index}`);
				await mkdir(directory, { recursive: true });
				const path = join(directory, "empty.md");
				await writeFile(path, " \n");
				expected.push(directory, path);
			}
			let page = await worker.scan({ source, cursor: null, pageSize: 100 });
			expect(page.files).toEqual([]);
			expect(page.rejected).toEqual([]);
			expect(page.scanned).toBe(0);
			expect(page.nextCursor).toBeNull();
			expect(page.complete).toBe(false);
			expect(page.frontier.length).toBeGreaterThan(0);
			let count = (await metadataPaths(instrumentation.stats)).length;
			expect(count).toBeLessThanOrEqual(64);
			for (let attempt = 0; !page.complete && attempt < 20; attempt++) {
				await worker.close();
				worker = createNativeSourceWorker({ resolveEmbeddedPath: () => instrumentation.entry });
				const frontier = [...page.frontier];
				page = await worker.scan({ source, cursor: page.nextCursor, frontier, pageSize: 100 });
				expect(page.files).toEqual([]);
				expect(page.rejected).toEqual([]);
				expect(page.scanned).toBe(0);
				expect(page.frontier).not.toEqual(frontier);
				const next = (await metadataPaths(instrumentation.stats)).length;
				expect(next - count).toBeGreaterThan(0);
				expect(next - count).toBeLessThanOrEqual(64);
				count = next;
			}
			expect(page.complete).toBe(true);
			expect(page.frontier).toEqual([]);
			const paths = await metadataPaths(instrumentation.stats);
			expect([...new Set(paths)].sort()).toEqual(expected.sort());
			expect(paths.filter((path) => path.endsWith("empty.md"))).toHaveLength(400);
		} finally {
			await worker.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses one in-process worker thread for a scan", async () => {
		const { source } = await fixture();
		let started = 0;
		let delivered = 0;
		const worker = createNativeSourceWorker({
			onScanStarted: () => {
				started++;
			},
			onScanResult: () => {
				delivered++;
			},
		});
		try {
			const page = await worker.scan({ source, cursor: null, pageSize: 1 });
			expect(page.files.map((file) => file.content)).toEqual(["B"]);
			expect(started).toBe(1);
			expect(delivered).toBe(1);
		} finally {
			await worker.close();
		}
	});

	it("pages source content and resumes from a durable cursor after worker restart", async () => {
		const { source } = await fixture();
		const firstWorker = createNativeSourceWorker();
		const first = await firstWorker.scan({ source, cursor: null, pageSize: 1 });
		await firstWorker.close();

		const restartedWorker = createNativeSourceWorker();
		const second = await restartedWorker.scan({
			source,
			cursor: first.nextCursor,
			frontier: first.frontier,
			pageSize: 1,
		});
		const third = await restartedWorker.scan({
			source,
			cursor: second.nextCursor,
			frontier: second.frontier,
			pageSize: 1,
		});
		await restartedWorker.close();

		expect(first.files.map((file) => file.content)).toEqual(["B"]);
		expect(second.files.map((file) => file.content)).toEqual(["A"]);
		expect(second.frontier).not.toContain(source.root);
		expect(third.files).toEqual([]);
		expect(third.complete).toBe(true);
	});

	it("restores legacy string frontiers without replaying completed files", async () => {
		const { root, source } = await fixture();
		const worker = createNativeSourceWorker();
		try {
			const page = await worker.scan({
				source,
				cursor: join(root, "b.md"),
				frontier: [join(root, "nested")],
				pageSize: 100,
			});
			expect(page.files.map((file) => file.content)).toEqual(["A"]);
			expect(page.complete).toBe(true);
		} finally {
			await worker.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("kills the isolated worker when cancellation is requested", async () => {
		const { source } = await fixture();
		const worker = createNativeSourceWorker();
		const scan = worker.scan({ source, cursor: null, pageSize: 1 });
		worker.cancel();
		await expect(scan).rejects.toThrow(/native source worker/);
		await worker.close();
	});

	it("waits for cancelled worker termination before restarting", async () => {
		const { root } = await fixture();
		const script = [
			`const { createNativeSourceWorker } = await import(${JSON.stringify(join(import.meta.dir, "native-memory-source-worker.ts"))});`,
			"const worker = createNativeSourceWorker();",
			'const source = { root: process.env.NATIVE_SOURCE_WORKER_TEST_ROOT, files: [{ glob: "**/*.md", kind: "markdown" }] };',
			"await worker.scan({ source, cursor: null, pageSize: 1 });",
			"worker.cancel();",
			"await worker.scan({ source, cursor: null, pageSize: 1 });",
			"await worker.close();",
		].join("\n");
		const result = spawnSync(process.execPath, ["-e", script], {
			env: { ...process.env, NATIVE_SOURCE_WORKER_TEST_ROOT: root },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5_000,
		});
		expect(result.error).toBeUndefined();
		if (result.status !== 0)
			throw new Error(
				`worker lifecycle child exited with ${String(result.status)}: ${result.stderr || result.stdout || "no output"}`,
			);
	});

	it("prepares Obsidian chunks inside the isolated worker", async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-obsidian-"));
		await writeFile(
			join(root, "note.md"),
			"# Worker-owned chunking\n\nThis content is deliberately long enough to exercise the source chunk parser in the child process.\n",
		);
		const worker = createNativeSourceWorker();
		const page = await worker.scan({
			source: {
				root,
				harness: "obsidian",
				sourceId: "obsidian:test",
				files: [{ glob: "**/*.md", kind: "source_obsidian_markdown" }],
			},
			cursor: null,
			pageSize: 1,
		});
		await worker.close();
		expect(page.files[0]?.chunks?.length).toBe(1);
	});

	it("prunes Codex sessions while preserving rollout files and source identity", async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-codex-"));
		const source = {
			root: join(root, "source"),
			harness: "codex",
			files: [
				{ glob: "memories/MEMORY.md", kind: "registry" },
				{ glob: "memories/rollout_summaries/*.jsonl", kind: "rollout" },
			],
		};
		const instrumentation = await instrument(root);
		const worker = createNativeSourceWorker({ resolveEmbeddedPath: () => instrumentation.entry });
		try {
			await mkdir(join(source.root, "memories", "rollout_summaries"), { recursive: true });
			await mkdir(join(source.root, "sessions", "2026", "11", "17"), { recursive: true });
			await writeFile(join(source.root, "memories", "MEMORY.md"), "registry");
			await writeFile(join(source.root, "memories", "rollout_summaries", "rollout.jsonl"), "rollout");
			await writeFile(join(source.root, "sessions", "2026", "11", "17", "session.jsonl"), "transcript");
			const page = await worker.scan({ source, cursor: null, pageSize: 100 });
			expect(page.files.map((file) => [file.path, file.kind, file.content])).toEqual([
				[join(source.root, "memories", "MEMORY.md"), "registry", "registry"],
				[join(source.root, "memories", "rollout_summaries", "rollout.jsonl"), "rollout", "rollout"],
			]);
			expect(page.files[0]?.sourceId).toMatch(/^codex_native_memory:[0-9a-f]{16}$/);
			expect(page.files[1]?.sourceId).toBe(page.files[0]?.sourceId);
			expect(page.complete).toBe(true);
			expect((await metadataPaths(instrumentation.stats)).some((path) => path.includes("sessions"))).toBe(false);
		} finally {
			await worker.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")(
		"rejects matching file and directory symlinks, including restored paths",
		async () => {
			const { root, source } = await fixture();
			const worker = createNativeSourceWorker();
			try {
				const file = join(root, "link.md");
				const directory = join(root, "linked");
				await symlink(join(root, "b.md"), file);
				await symlink(join(root, "nested"), directory);
				const page = await worker.scan({ source, cursor: null, pageSize: 100 });
				expect(page.files.map((file) => file.content)).toEqual(["B", "A"]);
				expect(page.complete).toBe(true);
				const restored = await worker.scan({ source, cursor: null, frontier: [file, directory], pageSize: 100 });
				expect(restored.files).toEqual([]);
				expect(restored.complete).toBe(true);
			} finally {
				await worker.close();
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it(`returns a bounded item rejection for a descriptor larger than the ${NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES}-byte IPC bound`, async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-bound-"));
		const path = join(root, "huge.md");
		await writeFile(path, "x".repeat(NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES + 1024));
		const worker = createNativeSourceWorker();
		try {
			const page = await worker.scan({
				source: { root, files: [{ glob: "**/*.md", kind: "markdown" }] },
				cursor: null,
				pageSize: 1,
			});
			expect(page.files).toEqual([]);
			expect(page.rejected).toEqual([
				expect.objectContaining({
					path,
					code: "source_item_too_large",
					sizeBytes: NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES + 1024,
				}),
			]);
			expect(page.nextCursor).toBe(path);
			expect(page.complete).toBe(true);
		} finally {
			await worker.close();
		}
	});

	it("reuses the worker after returning an oversized-file rejection", async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-reuse-"));
		await writeFile(join(root, "huge.md"), "x".repeat(NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES + 1024));
		await writeFile(join(root, "ok.md"), "ok");
		const worker = createNativeSourceWorker();
		try {
			const rejected = await worker.scan({
				source: { root, files: [{ glob: "huge.md", kind: "markdown" }] },
				cursor: null,
				pageSize: 1,
			});
			expect(rejected.rejected).toHaveLength(1);
			const page = await worker.scan({
				source: { root, files: [{ glob: "ok.md", kind: "markdown" }] },
				cursor: null,
				pageSize: 1,
			});
			expect(page.files[0]?.content).toBe("ok");
		} finally {
			await worker.close();
		}
	});

	it("opens a circuit instead of replacing workers forever at one failed checkpoint", async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-circuit-"));
		const starts = join(root, "starts.log");
		const entry = join(root, "crash-worker.mjs");
		await writeFile(
			entry,
			`import { appendFileSync } from "node:fs";\nimport { parentPort } from "node:worker_threads";\nappendFileSync(${JSON.stringify(starts)}, "start\\n");\nparentPort.postMessage({ version: 1, type: "ready" });\nparentPort.on("message", () => process.exit(17));\n`,
		);
		const worker = createNativeSourceWorker({
			resolveEmbeddedPath: () => entry,
			circuitCooldownMs: 10,
		});
		const command = {
			source: { root, files: [{ glob: "**/*.md" as const, kind: "markdown" as const }] },
			cursor: null,
			frontier: null,
			pageSize: 1,
		};

		try {
			for (let attempt = 0; attempt < NATIVE_SOURCE_WORKER_MAX_SAME_CHECKPOINT_FAILURES; attempt++) {
				await expect(worker.scan(command)).rejects.toThrow("exited with code 17");
			}
			await expect(worker.scan(command)).rejects.toThrow("circuit is open");
			expect((await readFile(starts, "utf8")).trim().split("\n")).toHaveLength(
				NATIVE_SOURCE_WORKER_MAX_SAME_CHECKPOINT_FAILURES,
			);
			await Bun.sleep(20);
			await expect(worker.scan(command)).rejects.toThrow("exited with code 17");
			expect((await readFile(starts, "utf8")).trim().split("\n")).toHaveLength(
				NATIVE_SOURCE_WORKER_MAX_SAME_CHECKPOINT_FAILURES + 1,
			);
		} finally {
			await worker.close();
		}
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"prunes unrelated directories, including a saved frontier, but reports inaccessible matching directories",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-prune-"));
			const unrelated = join(root, "plugins", "cache");
			const relevant = join(root, "projects", "blocked", "memory");
			const worker = createNativeSourceWorker();
			try {
				await mkdir(unrelated, { recursive: true });
				await mkdir(relevant, { recursive: true });
				await mkdir(join(root, "projects", "repo", "memory", "notes"), { recursive: true });
				await mkdir(join(root, "projects", "repo", "subagents"), { recursive: true });
				await writeFile(join(root, "projects", "repo", "memory", "MEMORY.md"), "index");
				await writeFile(join(root, "projects", "repo", "memory", "notes", "deep.md"), "deep");
				await writeFile(join(root, "projects", "repo", "subagents", "other.md"), "other");
				await writeFile(join(unrelated, "noise.md"), "noise");
				await chmod(unrelated, 0o000);
				await chmod(relevant, 0o000);
				const source = {
					root: `${root}/`,
					files: [
						{ glob: "projects/*/memory/MEMORY.md", kind: "index" },
						{ glob: "projects/*/memory/**/*.md", kind: "memory", excludeBasenames: ["MEMORY.md"] },
					],
				};
				const page = await worker.scan({ source, cursor: null, pageSize: 100 });
				expect(page.files.map((file) => [file.kind, file.content]).sort()).toEqual([
					["index", "index"],
					["memory", "deep"],
				]);
				expect(page.permissionDeniedPaths).toEqual([relevant]);
				expect(page.complete).toBe(true);
				await worker.close();
				const resumed = await worker.scan({
					source,
					cursor: page.nextCursor,
					frontier: [join(root, "projects", "repo", "memory"), unrelated],
					pageSize: 100,
				});
				expect(resumed.files).toEqual(page.files);
				expect(resumed.permissionDeniedPaths).toEqual([]);
				expect(resumed.complete).toBe(true);
				expect(resumed.frontier).toEqual([]);
			} finally {
				await worker.close();
				await chmod(unrelated, 0o700);
				await chmod(relevant, 0o700);
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.each([
		{ glob: "ROOT.md", expected: ["root"] },
		{ glob: "projects/**/memory/*.md", expected: ["index", "many", "zero"] },
		{ glob: "projects/*/memory/**/*.md", expected: ["deep", "index"] },
		{ glob: "proj*/*/mem*/**/*.md", expected: ["deep", "index"] },
		{ glob: "projects\\*\\memory\\**\\*.md", expected: ["deep", "index"] },
		{
			glob: "**/*.md",
			excludeBasenames: ["MEMORY.md"],
			excludeGlobs: ["plugins/**", "**/notes/**"],
			expected: ["many", "root", "zero"],
		},
	])("preserves file matching for $glob", async ({ glob, expected, excludeBasenames, excludeGlobs }) => {
		const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-patterns-"));
		const worker = createNativeSourceWorker();
		try {
			for (const [path, content] of [
				["ROOT.md", "root"],
				["projects/memory/zero.md", "zero"],
				["projects/repo/memory/MEMORY.md", "index"],
				["projects/repo/memory/notes/deep.md", "deep"],
				["projects/team/repo/memory/many.md", "many"],
				["plugins/cache/noise.md", "noise"],
			] as const) {
				await mkdir(join(root, path, ".."), { recursive: true });
				await writeFile(join(root, path), content);
			}
			const page = await worker.scan({
				source: { root, files: [{ glob, kind: "memory", excludeBasenames, excludeGlobs }] },
				cursor: null,
				pageSize: 100,
			});
			expect(page.files.map((file) => file.content).sort()).toEqual([...expected]);
			expect(page.complete).toBe(true);
		} finally {
			await worker.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
