import { expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeSourceWorker, NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES } from "./native-memory-source-worker";

for (const [count, matching] of [
	[60_000, 60_000],
	[100_000, 3],
]) {
	it(`checkpoints ${count} directory entries with ${matching} matches within bounded frames and enumeration pages`, async () => {
		if (count === undefined || matching === undefined) throw new Error("Missing scale case");
		const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-scale-"));
		const source = { root: join(root, "source"), files: [{ glob: "*.md", kind: "memory" }] };
		const stats = join(root, "stats.jsonl");
		const entry = join(root, "worker.ts");
		await mkdir(source.root);
		await writeFile(stats, "");
		await writeFile(
			entry,
			[
				'import { mock } from "bun:test";',
				'import * as fs from "node:fs/promises";',
				"const realFs = { ...fs };",
				'process.on("exit", () => mock.module("node:fs/promises", () => realFs));',
				'import { appendFileSync } from "node:fs";',
				'import { parentPort } from "node:worker_threads";',
				"const original = fs.opendir;",
				"let reads = 0;",
				"let previous = 0;",
				"const post = parentPort.postMessage.bind(parentPort);",
				`const log = (value) => appendFileSync(${JSON.stringify(stats)}, JSON.stringify(value) + "\\n");`,
				'parentPort.on("message", (frame) => log({ direction: "command", bytes: Buffer.byteLength(JSON.stringify(frame)) }));',
				'parentPort.postMessage = (frame) => { log({ direction: frame.type === "result" ? "result" : "event", bytes: Buffer.byteLength(JSON.stringify(frame)), reads: frame.type === "result" ? reads - previous : 0 }); if (frame.type === "result") previous = reads; return post(frame); };',
				`mock.module("node:fs/promises", () => ({ ...fs, opendir: async (...args) => { const dir = await original(...args); const read = async () => { ${matching < count ? "if (reads < 128) await Bun.sleep(2);" : ""} const entry = await dir.read(); if (entry !== null) reads++; return entry; }; return { read, close: () => dir.close(), async *[Symbol.asyncIterator]() { try { while (true) { const entry = await read(); if (entry === null) return; yield entry; } } finally { await dir.close(); } } }; } }));`,
				`await import(${JSON.stringify(join(import.meta.dir, "native-memory-source-worker.ts"))});`,
			].join("\n"),
		);
		const expected: string[] = [];
		for (let start = 0; start < count; start += 256) {
			await Promise.all(
				Array.from({ length: Math.min(256, count - start) }, async (_, offset): Promise<void> => {
					const index = start + offset;
					const path = join(source.root, `${String(index).padStart(6, "0")}.${index < matching ? "md" : "jsonl"}`);
					await writeFile(path, "memory");
					if (index < matching) expected.push(path);
				}),
			);
		}
		let worker = createNativeSourceWorker({ resolveEmbeddedPath: () => entry });
		const found: string[] = [];
		const times: number[] = [];
		let pages = 0;
		let restartedListing = false;
		let restartedOutput = false;
		const started = performance.now();
		try {
			const beforeFirst = performance.now();
			let page = await worker.scan({ source, cursor: null, pageSize: 100 });
			times.push(performance.now() - beforeFirst);
			expect(page.complete).toBe(false);
			while (true) {
				pages++;
				found.push(...page.files.map((file) => file.path));
				expect(page.rejected).toEqual([]);
				expect(Buffer.byteLength(JSON.stringify(page.frontier))).toBeLessThan(16_384);
				if (page.complete) break;
				if (!restartedListing || (!restartedOutput && found.length > 0)) {
					await worker.close();
					worker = createNativeSourceWorker({ resolveEmbeddedPath: () => entry });
					if (restartedListing) restartedOutput = true;
					restartedListing = true;
				}
				if (pages > 2_000) throw new Error("Scan failed to terminate");
				const before = performance.now();
				const checkpoint: unknown = JSON.parse(JSON.stringify(page.frontier));
				if (!Array.isArray(checkpoint) || !checkpoint.every((value): value is string => typeof value === "string")) {
					throw new Error("Invalid persisted frontier");
				}
				page = await worker.scan({ source, cursor: page.nextCursor, frontier: checkpoint, pageSize: 100 });
				times.push(performance.now() - before);
			}
			const frames: { readonly direction: string; readonly bytes: number; readonly reads?: number }[] = (
				await readFile(stats, "utf8")
			)
				.trim()
				.split("\n")
				.map((line: string) => JSON.parse(line));
			const results = frames.filter((frame) => frame.direction === "result");
			expect(found).toEqual(expected.sort());
			expect(new Set(found).size).toBe(matching);
			expect(restartedListing).toBe(true);
			if (matching === count) expect(restartedOutput).toBe(true);
			expect(results.length).toBe(pages);
			if (matching < count) expect(results[0]?.reads).toBeLessThan(128);
			expect(Math.max(...results.map((frame) => frame.reads ?? 0))).toBeLessThanOrEqual(4_096);
			expect(results.reduce((sum, frame) => sum + (frame.reads ?? 0), 0)).toBeLessThanOrEqual(count * 3);
			expect(Math.max(...frames.map((frame) => frame.bytes))).toBeLessThanOrEqual(
				NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES,
			);
			expect(Math.max(...times)).toBeLessThan(2_000);
			console.log(
				JSON.stringify({
					count,
					matching,
					pages,
					elapsedMs: performance.now() - started,
					maxPageMs: Math.max(...times),
					reads: results.reduce((sum, frame) => sum + (frame.reads ?? 0), 0),
					maxFrameBytes: Math.max(...frames.map((frame) => frame.bytes)),
				}),
			);
		} finally {
			await worker.close();
			await rm(root, { recursive: true, force: true });
		}
	}, 120_000);
}
