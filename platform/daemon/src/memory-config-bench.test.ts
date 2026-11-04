import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

describe("recall benchmark workspace configuration", () => {
	for (const database of ["memory/memories.db", "custom/recall.sqlite"]) {
		it(`copies the layout-selected ${database} instead of a stale data/signet.db`, async () => {
			const root = mkdtempSync(join(tmpdir(), "signet-bench-layout-"));
			const source = join(root, "source");
			const selected = join(source, database);
			mkdirSync(dirname(selected), { recursive: true });
			mkdirSync(join(source, "data"), { recursive: true });
			writeFileSync(selected, "selected database");
			writeFileSync(`${selected}-wal`, "selected wal");
			writeFileSync(`${selected}-shm`, "selected shm");
			writeFileSync(join(source, "data", "signet.db"), "stale database");
			writeFileSync(join(source, "workspace-layout.json"), JSON.stringify({ version: 2, overrides: { database } }));
			writeFileSync(join(source, "agent.yaml"), "name: Bench\nembedding:\n  provider: none\n  dimensions: 3\n");
			const script = `
import { mock } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
mock.module(${JSON.stringify(join(import.meta.dir, "embedding-fetch.ts"))}, () => ({ fetchEmbedding: async () => null }));
mock.module(${JSON.stringify(join(import.meta.dir, "db-accessor.ts"))}, () => ({
  initDbAccessor(path) {
    try {
      for (const [suffix, expected] of [["", "selected database"], ["-wal", "selected wal"], ["-shm", "selected shm"]]) {
        const actual = readFileSync(path + suffix, "utf8");
        if (actual !== expected) throw new Error("wrong benchmark database: " + actual);
      }
    } catch (error) {
      rmSync(dirname(dirname(path)), { recursive: true, force: true });
      throw error;
    }
  },
  getDbAccessor() { throw new Error("source benchmarks must not seed the database"); },
  closeDbAccessor() {},
}));
mock.module(${JSON.stringify(join(import.meta.dir, "memory-search.ts"))}, () => ({
  hybridRecall: async () => ({ results: [], meta: { timings: { stages: [] } } }),
}));
await import(${JSON.stringify(join(import.meta.dir, "memory-search.bench.ts"))});
`;
			try {
				const child = Bun.spawn([process.execPath, "--eval", script], {
					cwd: import.meta.dir,
					env: {
						...process.env,
						SIGNET_RECALL_BENCH_SOURCE_PATH: source,
						SIGNET_RECALL_BENCH_ITERS: "1",
						SIGNET_RECALL_BENCH_EMBED: "fake",
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
				expect(stdout).toContain("Hybrid recall latency benchmark");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
});
