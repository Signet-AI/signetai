import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDbAccessor, initDbAccessor, closeDbAccessor } from "../db-accessor";
import { closeRegisteredDbOwnerMaintenance } from "../db-owner-maintenance";
const previousPath = process.env.SIGNET_PATH;
const directory = mkdtempSync(join(tmpdir(), "projection-reads-")),
	at = "2026-11-25T00:00:00.000Z";
beforeAll(() => {
	process.env.SIGNET_PATH = directory;
	mkdirSync(join(directory, "memory"));
	writeFileSync(join(directory, "agent.yaml"), "embedding:\n  provider: none\n");
	initDbAccessor(join(directory, "memory/memories.db"));
	getDbAccessor().withWriteTx((db) =>
		db.prepare("INSERT OR IGNORE INTO agents(id,name,created_at,updated_at) VALUES ('beta','Beta',?,?)").run(at, at),
	);
});
afterAll(async () => {
	await closeRegisteredDbOwnerMaintenance();
	await closeDbAccessor();
	if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousPath;
	rmSync(directory, { recursive: true, force: true });
});
test("B1 5000-point projection keeps maximum event-loop gap under 50ms", async () => {
	getDbAccessor().withWriteTx((db) => {
		const m = db.prepare(
			"INSERT INTO memories(id,agent_id,type,content,visibility,created_at,updated_at,updated_by) VALUES (?,'beta','fact','worker projection','global',?,?,'test')",
		);
		const e = db.prepare(
			"INSERT INTO embeddings(id,source_type,source_id,content_hash,chunk_text,vector,dimensions,created_at,agent_id) VALUES (?,'memory',?,?,'c',?,768,?,'beta')",
		);
		for (let i = 0; i < 5000; i++) {
			const id = `b1-${i}`;
			m.run(id, at, at);
			e.run(
				id,
				id,
				id,
				Buffer.from(Float32Array.from({ length: 768 }, (_, n) => Math.sin(i * 0.37 + n * 0.11)).buffer),
				at,
			);
		}
	});
	const { projectVisibleMemories } = await import("../umap-projection");
	const { resolveReadScope } = await import("../read-scope");
	const scope = await resolveReadScope(
		{ reach: { kind: "all" }, projects: null },
		{ local: false, userId: "bob", groupIds: [] },
	);
	let maximum = 0,
		last = performance.now();
	const timer = setInterval(() => {
		const now = performance.now();
		maximum = Math.max(maximum, now - last - 10);
		last = now;
	}, 10);
	try {
		const result = await projectVisibleMemories(scope, 2, { limit: 5000 });
		expect(result.count).toBe(5000);
	} finally {
		clearInterval(timer);
	}
	console.log("B1_MAX_EVENT_LOOP_GAP_MS", maximum);
	expect(maximum).toBeLessThan(50);
}, 120000);

test("B4 cached geometry never caches readable population totals", async () => {
	const { projectVisibleMemories } = await import("../umap-projection");
	const { resolveReadScope } = await import("../read-scope");
	const scope = await resolveReadScope(
		{ reach: { kind: "all" }, projects: null },
		{ local: false, userId: "bob", groupIds: [] },
	);
	const before = await projectVisibleMemories(scope, 2, { limit: 3 });
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			"INSERT INTO memories(id,agent_id,type,content,visibility,created_at,updated_at,updated_by) VALUES ('b4-old','beta','fact','old','global','2020-01-01',?,'test')",
		).run(at);
		db.prepare(
			"INSERT INTO embeddings(id,source_type,source_id,content_hash,chunk_text,vector,dimensions,created_at,agent_id) VALUES ('b4-old','memory','b4-old','b4-old','old',?,3,?,'beta')",
		).run(Buffer.from(new Float32Array([1, 2, 3]).buffer), at);
	});
	const after = await projectVisibleMemories(scope, 2, { limit: 3 });
	expect(after.result).toEqual(before.result);
	expect(after.total).toBe(before.total + 1);
});
