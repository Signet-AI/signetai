import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { localPrincipal } from "../auth/principal";
import { closeDbAccessor, initDbAccessor } from "../db-accessor";
import { dbOwnerQuery } from "../db-owner-runtime";
import { registerTelemetryRoutes } from "./telemetry-routes";

const previousPath = process.env.SIGNET_PATH;
let dir = "";
let app: Hono;
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "signet-telemetry-export-"));
	process.env.SIGNET_PATH = dir;
	initDbAccessor(join(dir, "test.db"), { agentsDir: dir });
	await dbOwnerQuery(
		{ sql: "INSERT INTO compartments(id,key) VALUES(2,'export-public')", result: "run" },
		{ operation: "test.export.seed", lane: "write" },
	);
	app = new Hono();
	app.use("*", async (c, next) => {
		c.set("principal", localPrincipal());
		await next();
	});
	registerTelemetryRoutes(app);
});
afterEach(async () => {
	await closeDbAccessor();
	if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousPath;
	rmSync(dir, { recursive: true, force: true });
});
async function seed(count: number, query: string) {
	await dbOwnerQuery(
		{
			sql: "INSERT INTO memory_search_telemetry(id,created_at,route,agent_id,query,filters_json,method,result_count,no_hits,duration_ms,timings_json,results_json,compartment_id) SELECT printf('export-%02d',value),'2026','export-test','default',?,'{}','hybrid',0,1,1,'{}','[]',2 FROM json_each(?)",
			params: [query, JSON.stringify(Array.from({ length: count }, (_, index) => index))],
			result: "run",
		},
		{ operation: "test.export.seed", lane: "write", deadlineMs: 15000 },
	);
}
async function chunks(response: Response) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("missing_export_body");
	const parts: Uint8Array[] = [];
	for (;;) {
		const part = await reader.read();
		if (part.done) break;
		parts.push(part.value);
	}
	return parts;
}
function records(parts: readonly Uint8Array[]) {
	const decoder = new TextDecoder();
	return parts
		.map((part) => decoder.decode(part, { stream: true }))
		.join("")
		.split("\n")
		.filter(Boolean)
		.map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
}
test("telemetry export defaults to the base ten-thousand record cap", async () => {
	await seed(10001, "small export");
	const response = await app.request("/api/telemetry/memory-search/export");
	expect(response.status).toBe(200);
	const rows = records(await chunks(response));
	expect(rows).toHaveLength(10000);
	expect(new Set(rows.map((row) => row.id)).size).toBe(10000);
});
test("telemetry export joins records exactly like base without a trailing newline", async () => {
	expect(await (await app.request("/api/telemetry/memory-search/export")).text()).toBe("");
	await seed(2, "small export");
	const list = await app.request("/api/telemetry/memory-search?limit=2");
	const { items } = z.object({ items: z.array(z.record(z.string(), z.unknown())) }).parse(await list.json());
	expect(await (await app.request("/api/telemetry/memory-search/export?limit=2")).text()).toBe(
		items.map((item) => JSON.stringify(item)).join("\n"),
	);
});

test("owner export pages stay within four MiB across a byte-limited keyset", async () => {
	await seed(8, "a".repeat(1024 * 1024));
	const { dbOwnerSearchTelemetryExportPage } = await import("../db-owner-runtime");
	const scope: import("../read-scope").ReadScope = {
		reach: { kind: "own", agentId: "default" },
		compartments: "all",
		projects: null,
	};
	let cursor: import("../memory-search-telemetry").MemorySearchTelemetryCursor | undefined;
	const ids: string[] = [];
	let pages = 0;
	for (;;) {
		const page = await dbOwnerSearchTelemetryExportPage({ scope }, cursor);
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(page.oversized).toBe(false);
		ids.push(...page.rows.map((row) => row.id));
		pages++;
		const last = page.rows.at(-1);
		if (!page.hasMore) break;
		if (!last) throw new Error("missing_export_cursor");
		cursor = { createdAt: last.created_at, id: last.id };
	}
	expect(pages).toBeGreaterThan(1);
	expect(ids).toEqual(Array.from({ length: 8 }, (_, index) => `export-${String(index).padStart(2, "0")}`));
});

test("telemetry export streams byte-bounded pages without losing records", async () => {
	await seed(8, "a".repeat(1024 * 1024));
	const response = await app.request("/api/telemetry/memory-search/export");
	expect(response.status).toBe(200);
	const parts = await chunks(response);
	expect(parts.length).toBeGreaterThan(1);
	for (const part of parts) expect(part.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
	expect(records(parts).map((row) => row.id)).toEqual(
		Array.from({ length: 8 }, (_, index) => `export-${String(index).padStart(2, "0")}`),
	);
});
test("telemetry export emits a terminal error after owner failure following headers", async () => {
	await seed(8, "a".repeat(1024 * 1024));
	const response = await app.request("/api/telemetry/memory-search/export");
	expect(response.status).toBe(200);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("missing_export_body");
	const first = await reader.read();
	if (first.done) throw new Error("missing_export_record");
	await closeDbAccessor();
	const parts = [first.value];
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		parts.push(next.value);
	}
	expect(records(parts).at(-1)).toMatchObject({ kind: "error" });
});
test("telemetry export rejects a single oversized UTF-8 row with a terminal error", async () => {
	await seed(1, "é".repeat(3 * 1024 * 1024));
	const response = await app.request("/api/telemetry/memory-search/export");
	expect(response.status).toBe(200);
	expect(records(await chunks(response))).toEqual([expect.objectContaining({ kind: "error" })]);
});
