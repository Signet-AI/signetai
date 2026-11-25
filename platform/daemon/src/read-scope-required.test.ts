import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readScopeSql, localAllReadScope } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { setFtsIndexIncomplete } from "./fts-index-state";
import { loadMemoryConfig } from "./memory-config";
import { hybridRecall, readOwnerVectorsBySource } from "./memory-search";
import { requestMemoryHead } from "./memory-head";
import { buildMemorySearchFilterClause } from "./memory-search-filters";
import { resolveTemporalRecall } from "./temporal-recall";

const NOW = "2026-11-20T10:00:00.000Z";

function invoke(fn: unknown, args: readonly unknown[]): unknown {
	if (typeof fn !== "function") throw new Error("not callable");
	return Reflect.apply(fn, undefined, [...args]);
}

describe("read scope is required at runtime", () => {
	let dir = "";
	let prevSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-read-scope-required-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "name: ScopeRequired\n");
		prevSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"));
		setFtsIndexIncomplete(false);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (id, content, type, agent_id, visibility, created_at, updated_at, updated_by)
				 VALUES ('foreign-1', 'zephyr launch codes for the foreign agent', 'fact', 'foreign', 'private', ?, ?, 'test')`,
			).run(NOW, NOW);
		});
	});

	afterEach(async () => {
		await closeDbAccessor();
		if (prevSignetPath === undefined) delete process.env.SIGNET_PATH;
		else process.env.SIGNET_PATH = prevSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	it("readScopeSql rejects a missing scope instead of dereferencing it", () => {
		expect(() => invoke(readScopeSql, ["m", undefined])).toThrow("read scope required");
		expect(() => invoke(readScopeSql, ["m", { compartments: "all", projects: null }])).toThrow("read scope required");
		expect(() =>
			invoke(readScopeSql, ["m", { reach: { kind: "own", agentId: "a" }, compartments: "everything", projects: null }]),
		).toThrow("read scope required");
	});

	it("memory search filters fail closed when the read scope is omitted", () => {
		expect(() => invoke(buildMemorySearchFilterClause, [{ scope: null }])).toThrow("read scope required");
		expect(() => invoke(buildMemorySearchFilterClause, [{ scope: null, agentId: "default" }])).toThrow(
			"read scope required",
		);
	});

	it("hybrid recall without a read scope is rejected instead of searching every agent", async () => {
		const cfg = loadMemoryConfig(dir);
		const outcome = Promise.resolve(
			invoke(hybridRecall, [
				{ query: "zephyr launch codes", keywordQuery: "zephyr launch codes", limit: 5, trackRecallAccess: false },
				cfg,
				async () => null,
			]),
		);
		await expect(outcome).rejects.toThrow("read scope required");
	});

	it("all-agent recall never invents the default acting agent", async () => {
		const cfg = loadMemoryConfig(dir);
		await expect(
			Promise.resolve(
				invoke(hybridRecall, [
					{ query: "zephyr launch", readScope: localAllReadScope({ kind: "all" }) },
					cfg,
					async () => null,
				]),
			),
		).rejects.toThrow("acting agent required for recall");
	});

	it("owner vector hydration rejects an omitted read scope", async () => {
		await expect(Promise.resolve(invoke(readOwnerVectorsBySource, [["foreign-1"], 3, async () => []]))).rejects.toThrow(
			"read scope required",
		);
	});

	it("generated memory-head inspection rejects a missing read scope", async () => {
		await expect(
			Promise.resolve(invoke(requestMemoryHead, [{ action: "inspect", agentId: "default", content: "" }])),
		).rejects.toThrow("read scope required");
	});

	it("temporal recall without a read scope is rejected instead of defaulting to the default agent", () => {
		expect(() =>
			invoke(resolveTemporalRecall, [{ query: "what happened yesterday", limit: 5, agentId: "foreign", scope: null }]),
		).toThrow("read scope required");
	});
});
