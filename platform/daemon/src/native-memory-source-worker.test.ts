import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createNativeSourceWorker, NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES } from "./native-memory-source-worker";

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

describe("native source worker", () => {
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

	it("kills the isolated worker when cancellation is requested", async () => {
		const { source } = await fixture();
		const worker = createNativeSourceWorker();
		const scan = worker.scan({ source, cursor: null, pageSize: 1 });
		worker.cancel();
		await expect(scan).rejects.toThrow(/native source worker/);
		await worker.close();
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

	it("derives Codex source IDs in the isolated worker", async () => {
		const { root } = await fixture();
		const worker = createNativeSourceWorker();
		const page = await worker.scan({
			source: { root, harness: "codex", files: [{ glob: "**/*.md", kind: "markdown" }] },
			cursor: null,
			pageSize: 1,
		});
		await worker.close();
		expect(page.files[0]?.sourceId).toMatch(/^codex_native_memory:[0-9a-f]{16}$/);
	});

	it(`rejects a descriptor larger than the ${NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES}-byte IPC bound`, async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-bound-"));
		await writeFile(join(root, "huge.md"), "x".repeat(NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES + 1024));
		const worker = createNativeSourceWorker();
		await expect(
			worker.scan({
				source: { root, files: [{ glob: "**/*.md", kind: "markdown" }] },
				cursor: null,
				pageSize: 1,
			}),
		).rejects.toThrow(/IPC limit/);
		await worker.close();
	});
});
