import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { syncVecInsert, vectorToBlob } from "./db-helpers";

const DIMENSIONS = 768;
function vec(signal: number[]): number[] {
	const out = new Array<number>(DIMENSIONS).fill(0);
	for (let i = 0; i < signal.length; i++) out[i] = signal[i];
	return out;
}

let app: Hono;
let agentsDir = "";
const dbFiles = ["memories.db", "memories.db-shm", "memories.db-wal"];
let originalSignetPath: string | undefined;

function resetDbFiles(): void {
	for (const file of dbFiles) {
		rmSync(join(agentsDir, "memory", file), { force: true });
	}
}

interface SeedOpts {
	readonly id: string;
	readonly content: string;
	readonly embeddingId: string;
	readonly signal: number[];
	readonly isDeleted?: number;
	readonly supersededBy?: string | null;
	readonly staleAt?: string | null;
	readonly sourceType?: string;
	readonly type?: string;
}

function seedMemory(opts: SeedOpts): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories (
				id, content, type, source_type, source_id, is_deleted,
				superseded_by, stale_at, agent_id, visibility,
				created_at, updated_at, updated_by
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'default', 'global', ?, ?, 'test')`,
		).run(
			opts.id,
			opts.content,
			opts.type ?? "fact",
			opts.sourceType ?? "manual",
			opts.id,
			opts.isDeleted ?? 0,
			opts.supersededBy ?? null,
			opts.staleAt ?? null,
			now,
			now,
		);
		db.prepare(
			`INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
			 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)`,
		).run(
			opts.embeddingId,
			`hash-${opts.embeddingId}`,
			vectorToBlob(opts.signal),
			DIMENSIONS,
			opts.id,
			`chunk for ${opts.id}`,
			now,
		);
		syncVecInsert(db, opts.embeddingId, opts.signal);
	});
}

describe("GET /memory/similar lifecycle filtering", () => {
	beforeAll(async () => {
		originalSignetPath = process.env.SIGNET_PATH;
		agentsDir = mkdtempSync(join(tmpdir(), "signet-similar-lifecycle-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`embedding:
  provider: none
memory:
  pipelineV2:
    enabled: false
    shadowMode: false
`,
		);
		process.env.SIGNET_PATH = agentsDir;

		const daemon = await import("./daemon");
		app = daemon.app;
	});

	beforeEach(() => {
		closeDbAccessor();
		resetDbFiles();
		initDbAccessor(join(agentsDir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
	});

	afterAll(() => {
		closeDbAccessor();
		if (originalSignetPath === undefined) {
			process.env.SIGNET_PATH = undefined;
		} else {
			process.env.SIGNET_PATH = originalSignetPath;
		}
		rmSync(agentsDir, { recursive: true, force: true });
	});

	it("does not surface deleted, superseded, stale, or aggregate-recall candidates", async () => {
		const baseSignal = [1, 0, 0];
		seedMemory({ id: "current", content: "current fact", embeddingId: "emb-current", signal: vec(baseSignal) });
		seedMemory({
			id: "deleted",
			content: "deleted fact",
			embeddingId: "emb-deleted",
			signal: vec(baseSignal),
			isDeleted: 1,
		});
		seedMemory({
			id: "superseded",
			content: "superseded fact",
			embeddingId: "emb-superseded",
			signal: vec(baseSignal),
			supersededBy: "current",
		});
		seedMemory({
			id: "stale",
			content: "stale fact",
			embeddingId: "emb-stale",
			signal: vec(baseSignal),
			staleAt: "2025-01-01T00:00:00.000Z",
		});
		seedMemory({
			id: "aggregate",
			content: "aggregate-recall answer",
			embeddingId: "emb-aggregate",
			signal: vec(baseSignal),
			sourceType: "aggregate-recall",
		});

		const res = await app.request("http://localhost/memory/similar?id=current&k=10");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { results: Array<{ id: string }> };
		const ids = body.results.map((r) => r.id);

		expect(ids).toHaveLength(0);
		expect(ids).not.toContain("deleted");
		expect(ids).not.toContain("superseded");
		expect(ids).not.toContain("stale");
		expect(ids).not.toContain("aggregate");
	});

	it("returns 404 when the source id is deleted (its embedding must not seed the search)", async () => {
		const baseSignal = [1, 0, 0];
		seedMemory({
			id: "deleted-source",
			content: "deleted source fact",
			embeddingId: "emb-deleted-source",
			signal: vec(baseSignal),
			isDeleted: 1,
		});
		seedMemory({ id: "live", content: "live fact", embeddingId: "emb-live", signal: vec(baseSignal) });

		const res = await app.request("http://localhost/memory/similar?id=deleted-source&k=10");
		expect(res.status).toBe(404);
	});

	it("returns 404 when the source id is an aggregate-recall projection (derived rows must not seed the search)", async () => {
		const baseSignal = [1, 0, 0];
		seedMemory({
			id: "aggregate-source",
			content: "aggregate-recall answer",
			embeddingId: "emb-aggregate-source",
			signal: vec(baseSignal),
			sourceType: "aggregate-recall",
		});
		seedMemory({ id: "live-2", content: "live fact", embeddingId: "emb-live-2", signal: vec(baseSignal) });

		const res = await app.request("http://localhost/memory/similar?id=aggregate-source&k=10");
		expect(res.status).toBe(404);
	});

	it("returns 404 when the source id is superseded", async () => {
		const baseSignal = [1, 0, 0];
		seedMemory({
			id: "old",
			content: "old fact",
			embeddingId: "emb-old",
			signal: vec(baseSignal),
			supersededBy: "new",
		});
		seedMemory({ id: "new", content: "new fact", embeddingId: "emb-new", signal: vec(baseSignal) });

		const res = await app.request("http://localhost/memory/similar?id=old&k=10");
		expect(res.status).toBe(404);
	});

	it("surfaces a valid current candidate alongside a suppressed stale one", async () => {
		seedMemory({ id: "anchor", content: "anchor", embeddingId: "emb-anchor", signal: vec([1, 0, 0]) });
		seedMemory({
			id: "stale-cand",
			content: "stale candidate",
			embeddingId: "emb-stale-cand",
			signal: vec([1, 0, 0]),
			staleAt: "2025-01-01T00:00:00.000Z",
		});
		seedMemory({ id: "fresh-cand", content: "fresh candidate", embeddingId: "emb-fresh-cand", signal: vec([1, 0, 1]) });

		const res = await app.request("http://localhost/memory/similar?id=anchor&k=10");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { results: Array<{ id: string }> };
		const ids = body.results.map((r) => r.id);

		expect(ids).toContain("fresh-cand");
		expect(ids).not.toContain("stale-cand");
	});
});
