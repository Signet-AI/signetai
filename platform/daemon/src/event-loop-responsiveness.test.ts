import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { yieldEvery } from "./async-yield";

describe("event-loop responsiveness during async file processing", () => {
	it("event loop remains responsive while processing 500+ files with yields", async () => {
		const dir = join(tmpdir(), `signet-el-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });

		for (let i = 0; i < 500; i++) {
			const ts = new Date(Date.now() - i * 1000).toISOString().replace(/:/g, "-").slice(0, -5);
			const token = Math.random().toString(36).slice(2, 18).padEnd(16, "a");
			const name = `${ts}--${token}--summary.md`;
			writeFileSync(
				join(dir, name),
				`---\nkind: summary\nagent_id: default\nsession_id: test\ncaptured_at: ${ts}\n---\nContent ${i}\n`,
			);
		}

		const latencies: number[] = [];
		let measuring = true;
		const measureLoop = async () => {
			while (measuring) {
				const start = performance.now();
				await new Promise<void>((r) => setImmediate(r));
				latencies.push(performance.now() - start);
			}
		};

		const measurePromise = measureLoop();

		const yielder = yieldEvery(50);
		const entries = await readdir(dir);
		for (const entry of entries) {
			await stat(join(dir, entry));
			await yielder();
		}

		measuring = false;
		await measurePromise;

		rmSync(dir, { recursive: true, force: true });

		const maxLatency = Math.max(...latencies);
		expect(maxLatency).toBeLessThan(200);
		expect(latencies.length).toBeGreaterThan(5);
	});
});
