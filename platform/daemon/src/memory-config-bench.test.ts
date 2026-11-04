import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

async function runBenchmark(
	source: string,
	temporary: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const script = `
import { mock } from "bun:test";
import { resolveWorkspaceLayout } from "@signet/core";
import { readFileSync } from "node:fs";
mock.module(${JSON.stringify(join(import.meta.dir, "embedding-fetch.ts"))}, () => ({ fetchEmbedding: async () => null }));
mock.module(${JSON.stringify(join(import.meta.dir, "db-accessor.ts"))}, () => ({
  initDbAccessor(path) {
    if (path !== resolveWorkspaceLayout(process.env.SIGNET_PATH).database) throw new Error("wrong benchmark destination: " + path);
    for (const [suffix, expected] of [["", "selected database"], ["-wal", "selected wal"], ["-shm", "selected shm"]]) {
      const actual = readFileSync(path + suffix, "utf8");
      if (actual !== expected) throw new Error("wrong benchmark database: " + actual);
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
	const child = Bun.spawn([process.execPath, "--eval", script], {
		cwd: import.meta.dir,
		env: {
			...process.env,
			TMPDIR: temporary,
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
	return { exitCode, stdout, stderr };
}

describe("recall benchmark workspace configuration", () => {
	for (const fixture of [
		{ name: "legacy data-only workspace", database: "data/signet.db", layout: undefined, stale: [] },
		{ name: "default v1 layout", database: "memory/memories.db", layout: undefined, stale: ["data/signet.db"] },
		{ name: "current v2 layout", database: "data/signet.db", layout: { version: 2 }, stale: ["memory/memories.db"] },
		{
			name: "overridden layout",
			database: "custom/recall.sqlite",
			layout: { version: 2, overrides: { database: "custom/recall.sqlite" } },
			stale: ["data/signet.db", "memory/memories.db"],
		},
	]) {
		it(`copies the selected database and sidecars from a ${fixture.name}`, async () => {
			const root = mkdtempSync(join(tmpdir(), "signet-bench-layout-"));
			const source = join(root, "source");
			try {
				const selected = join(source, fixture.database);
				mkdirSync(dirname(selected), { recursive: true });
				writeFileSync(selected, "selected database");
				writeFileSync(`${selected}-wal`, "selected wal");
				writeFileSync(`${selected}-shm`, "selected shm");
				for (const stale of fixture.stale) {
					mkdirSync(dirname(join(source, stale)), { recursive: true });
					writeFileSync(join(source, stale), "stale database");
				}
				if (fixture.layout) writeFileSync(join(source, "workspace-layout.json"), JSON.stringify(fixture.layout));
				writeFileSync(join(source, "agent.yaml"), "name: Bench\nembedding:\n  provider: none\n  dimensions: 3\n");
				const { exitCode, stdout, stderr } = await runBenchmark(source, root);
				expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
				expect(stdout).toContain("Hybrid recall latency benchmark");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	it("fails explicitly when the source has no database", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-bench-missing-"));
		const source = join(root, "source");
		try {
			mkdirSync(source);
			writeFileSync(join(source, "agent.yaml"), "name: Bench\n");
			const { exitCode, stdout, stderr } = await runBenchmark(source, root);
			expect(exitCode).not.toBe(0);
			expect(stderr).toContain("Source memory DB not found:");
			expect(stdout).not.toContain("Hybrid recall latency benchmark");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not copy a stale database when the persisted canonical database is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-bench-stale-"));
		const source = join(root, "source");
		try {
			mkdirSync(join(source, "data"), { recursive: true });
			writeFileSync(join(source, "data", "signet.db"), "stale database");
			writeFileSync(
				join(source, "workspace-layout.json"),
				JSON.stringify({ version: 2, overrides: { database: "custom/db.sqlite" } }),
			);
			writeFileSync(join(source, "agent.yaml"), "name: Bench\n");
			const { exitCode, stdout, stderr } = await runBenchmark(source, root);
			expect(exitCode).not.toBe(0);
			expect(stderr).toContain("Source memory DB not found:");
			expect(stdout).not.toContain("Hybrid recall latency benchmark");
			const workspaces = readdirSync(root).filter((name) => name.startsWith("signet-recall-bench-"));
			expect(workspaces).toHaveLength(1);
			for (const entry of workspaces) {
				expect(existsSync(join(root, entry, "memory", "memories.db"))).toBe(false);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
