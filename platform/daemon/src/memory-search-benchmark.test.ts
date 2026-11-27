import { getSyncDbAccessor } from "../legacy-sync/db-accessor-sync";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { loadMemoryConfig } from "./memory-config";
import { hybridRecall as scopedHybridRecall } from "./memory-search";
import { type LocalScopeHint, withLocalReadScope } from "./test-support/local-read-scope";
import type { RecallParams } from "./memory-search";

type ScopedHybridRecallRest = Parameters<typeof scopedHybridRecall> extends [unknown, ...infer Rest] ? Rest : never;
function hybridRecall(
	params: Omit<RecallParams, "readScope"> & LocalScopeHint,
	...rest: ScopedHybridRecallRest
): ReturnType<typeof scopedHybridRecall> {
	return scopedHybridRecall(withLocalReadScope(params), ...rest);
}

(process.env.SIGNET_RECALL_BENCHMARK === "1" ? test : test.skip)(
	"measures scoped hybridRecall over 20000 unclassified memories",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-recall-benchmark-"));
		const previous = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		try {
			mkdirSync(join(dir, "memory"));
			writeFileSync(join(dir, "agent.yaml"), "name: RecallBenchmark\nembedding:\n  provider: none\n");
			initDbAccessor(join(dir, "memory", "memories.db"));
			getSyncDbAccessor().withWriteTx((db) => {
				const insert = db.prepare(
					"INSERT INTO memories(id,content,type,agent_id,created_at,updated_at,updated_by) VALUES (?,?,'fact','default','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','benchmark')",
				);
				for (let index = 0; index < 20000; index++)
					insert.run(
						`bench-${String(index).padStart(5, "0")}`,
						`atlas deployment pipeline database transaction release canary project ${index}`,
					);
			});
			const raw = loadMemoryConfig(dir);
			const config = {
				...raw,
				search: { ...raw.search, rehearsal_enabled: false, min_score: 0 },
				pipelineV2: { ...raw.pipelineV2, reranker: { ...raw.pipelineV2.reranker, enabled: false } },
			};
			const queries = ["atlas deployment pipeline", "database transaction", "release canary", "atlas project"];
			const samples: number[] = [];
			const stages = new Map<string, number[]>();
			for (let index = 0; index < 110; index++) {
				const start = performance.now();
				const response = await hybridRecall(
					{
						query: queries[index % queries.length] ?? "atlas",
						agentId: "default",
						limit: 10,
						readScope: { reach: { kind: "own", agentId: "default" }, compartments: [], projects: null },
						trackRecallAccess: false,
					},
					config,
					async () => null,
				);
				expect(response.results.length).toBe(10);
				if (index >= 10) {
					samples.push(performance.now() - start);
					for (const stage of response.meta.timings.stages) {
						const values = stages.get(stage.name) ?? [];
						values.push(stage.durationMs);
						stages.set(stage.name, values);
					}
				}
			}
			const sorted = [...samples].sort((a, b) => a - b);
			const report = {
				fixture: 20000,
				warmups: 10,
				samples: samples.length,
				p50: sorted[49],
				p95: sorted[94],
				durations: samples,
				stages: Object.fromEntries(
					[...stages].map(([name, values]) => [
						name,
						values.reduce((total, value) => total + value, 0) / values.length,
					]),
				),
			};
			console.log("RECALL_BENCHMARK", JSON.stringify(report));
			if (process.env.RECALL_BENCH_OUTPUT) writeFileSync(process.env.RECALL_BENCH_OUTPUT, JSON.stringify(report));
		} finally {
			await closeDbAccessor();
			if (previous === undefined) delete process.env.SIGNET_PATH;
			else process.env.SIGNET_PATH = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	},
	180000,
);
