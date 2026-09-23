import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { chunkBySentence } from "./routes/utils";
import { txIngestEnvelope } from "./transactions";

let app: Hono;
let agentsDir = "";
const dbFiles = ["memories.db", "memories.db-shm", "memories.db-wal"];
let originalSignetPath: string | undefined;

function resetDbFiles(): void {
	for (const file of dbFiles) {
		rmSync(join(agentsDir, "memory", file), { force: true });
	}
}

function seedMemory(args: {
	id: string;
	content: string;
	contentHash: string;
	pinned?: number;
	type?: string;
	version?: number;
}): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		txIngestEnvelope(db, {
			id: args.id,
			content: args.content,
			normalizedContent: args.content.toLowerCase(),
			contentHash: args.contentHash,
			who: "test",
			why: "test",
			project: "api-test",
			importance: 0.7,
			type: args.type ?? "fact",
			tags: "seed",
			pinned: args.pinned ?? 0,
			isDeleted: 0,
			extractionStatus: "none",
			embeddingModel: null,
			extractionModel: null,
			updatedBy: "test",
			sourceType: "api-test",
			sourceId: args.id,
			createdAt: now,
		});
		if (args.version && args.version > 1) {
			db.prepare("UPDATE memories SET version = ? WHERE id = ?").run(args.version, args.id);
		}
	});
}

function chunkGroupIdForDefaultScope(baseKey: string): string {
	const hash = createHash("sha256")
		.update("default")
		.update("\0")
		.update("global")
		.update("\0")
		.update("__NULL__")
		.update("\0")
		.update(baseKey)
		.digest("hex")
		.slice(0, 32);
	return `chunk-group:${hash}`;
}

describe("mutation API routes", () => {
	beforeAll(async () => {
		originalSignetPath = process.env.SIGNET_PATH;
		agentsDir = mkdtempSync(join(tmpdir(), "signet-daemon-mutation-api-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`embedding:
  provider: none
memory:
  pipelineV2:
    enabled: false
    shadowMode: false
    allowUpdateDelete: true
    hints:
      enabled: true
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

	it("POST /api/memory/remember accepts comma-separated tags", async () => {
		const res = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Memory with string tags",
				tags: "alpha, beta",
			}),
		});
		const json = (await res.json()) as { tags?: string | null };

		expect(res.status).toBe(200);
		expect(json.tags).toBe("alpha,beta");
	});

	it("POST /api/memory/remember accepts string-array tags", async () => {
		const res = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Memory with array tags",
				tags: ["alpha", "beta"],
			}),
		});
		const json = (await res.json()) as { tags?: string | null };

		expect(res.status).toBe(200);
		expect(json.tags).toBe("alpha,beta");
	});

	it("POST /api/memory/remember rejects invalid tag payloads", async () => {
		for (const tags of [42, ["alpha", 42]]) {
			const res = await app.request("http://localhost/api/memory/remember", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: "Memory with invalid tags",
					tags,
				}),
			});
			const json = (await res.json()) as { error?: string };

			expect(res.status).toBe(400);
			expect(json.error).toBe("tags must be a string, string array, or null");
		}
	});

	it("POST /api/memory/remember persists row-level provenance from metadata", async () => {
		const res = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Provenance-backed imported memory",
				who: "soulvessel.tests",
				sourceType: "hermes-memory",
				sourceId: "hermes-doc-provenance-test",
				metadata: {
					source_path: "/tmp/signet-provenance/MEMORY.md",
					runtime_path: "memories/MEMORY.md",
					idempotency_key: "hermes:provenance-test",
				},
			}),
		});
		const json = (await res.json()) as { id?: string; sourceId?: string };

		expect(res.status).toBe(200);
		expect(json.id).toBeString();

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT source_type, source_id, source_path, runtime_path, idempotency_key
						 FROM memories WHERE id = ?`,
					)
					.get(json.id) as
					| {
							source_type: string | null;
							source_id: string | null;
							source_path: string | null;
							runtime_path: string | null;
							idempotency_key: string | null;
					  }
					| undefined,
		);
		expect(row).toEqual({
			source_type: "hermes-memory",
			source_id: "hermes-doc-provenance-test",
			source_path: "/tmp/signet-provenance/MEMORY.md",
			runtime_path: "memories/MEMORY.md",
			idempotency_key: "hermes:provenance-test",
		});

		const retry = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Different retry content with the same stable import key",
				who: "soulvessel.tests",
				idempotencyKey: "hermes:provenance-test",
			}),
		});
		const retryJson = (await retry.json()) as { id?: string; deduped?: boolean };
		expect(retry.status).toBe(200);
		expect(retryJson).toMatchObject({ id: json.id, deduped: true });
	});

	it("POST /api/memory/remember scopes idempotency-key dedupe by agent and visibility", async () => {
		const first = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Default global provenance import",
				who: "soulvessel.tests",
				idempotencyKey: "shared-import-key",
			}),
		});
		const firstJson = (await first.json()) as { id?: string; deduped?: boolean };
		expect(first.status).toBe(200);
		expect(firstJson.id).toBeString();
		expect(firstJson.deduped).toBeUndefined();

		const otherAgent = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Default global provenance import",
				who: "soulvessel.tests",
				agentId: "agent-a",
				idempotencyKey: "shared-import-key",
			}),
		});
		const otherAgentJson = (await otherAgent.json()) as { id?: string; deduped?: boolean };
		expect(otherAgent.status).toBe(200);
		expect(otherAgentJson.id).toBeString();
		expect(otherAgentJson.id).not.toBe(firstJson.id);
		expect(otherAgentJson.deduped).toBeUndefined();

		const privateVisibility = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Default private provenance import",
				who: "soulvessel.tests",
				visibility: "private",
				idempotencyKey: "shared-import-key",
			}),
		});
		const privateJson = (await privateVisibility.json()) as { id?: string; deduped?: boolean };
		expect(privateVisibility.status).toBe(200);
		expect(privateJson.id).toBeString();
		expect(privateJson.id).not.toBe(firstJson.id);
		expect(privateJson.deduped).toBeUndefined();

		const retry = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Default global provenance import retry",
				who: "soulvessel.tests",
				idempotencyKey: "shared-import-key",
			}),
		});
		const retryJson = (await retry.json()) as { id?: string; deduped?: boolean };
		expect(retry.status).toBe(200);
		expect(retryJson).toMatchObject({ id: firstJson.id, deduped: true });

		const row = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT COUNT(*) AS count FROM memories WHERE idempotency_key = ?").get("shared-import-key") as
					| { count: number }
					| undefined,
		);
		expect(row?.count).toBe(3);
	});

	it("POST /api/memory/remember scopes source-id temporal dedupe by memory owner", async () => {
		const first = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Default source temporal provenance import",
				who: "soulvessel.tests",
				sourceType: "source-temporal-test",
				sourceId: "shared-source-temporal-key",
				occurredAt: "2026-05-13T18:00:00.000Z",
			}),
		});
		const firstJson = (await first.json()) as { id?: string; deduped?: boolean };
		expect(first.status).toBe(200);
		expect(firstJson.id).toBeString();
		expect(firstJson.deduped).toBeUndefined();

		const otherAgent = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Agent source temporal provenance import",
				who: "soulvessel.tests",
				agentId: "agent-a",
				sourceType: "source-temporal-test",
				sourceId: "shared-source-temporal-key",
				occurredAt: "2026-05-13T19:00:00.000Z",
			}),
		});
		const otherAgentJson = (await otherAgent.json()) as { id?: string; deduped?: boolean };
		expect(otherAgent.status).toBe(200);
		expect(otherAgentJson.id).toBeString();
		expect(otherAgentJson.id).not.toBe(firstJson.id);
		expect(otherAgentJson.deduped).toBeUndefined();

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT agent_id AS agentId, subject_id AS subjectId
						 FROM temporal_edges
						 WHERE subject_type = 'memory' AND facet = 'occurred'
						 ORDER BY agent_id`,
					)
					.all() as Array<{ agentId: string; subjectId: string }>,
		);
		expect(rows).toEqual([
			{ agentId: "agent-a", subjectId: otherAgentJson.id },
			{ agentId: "default", subjectId: firstJson.id },
		]);
	});

	it("POST /api/memory/remember matches normalized idempotency-key index scope", async () => {
		const first = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Legacy normalized idempotency row",
				who: "soulvessel.tests",
				idempotencyKey: "legacy-normalized-key",
			}),
		});
		const firstJson = (await first.json()) as { id?: string };
		expect(first.status).toBe(200);
		expect(firstJson.id).toBeString();

		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET agent_id = '', visibility = NULL WHERE id = ?").run(firstJson.id);
		});

		const retry = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Different retry content for normalized idempotency row",
				who: "soulvessel.tests",
				idempotencyKey: "legacy-normalized-key",
			}),
		});
		const retryJson = (await retry.json()) as { id?: string; deduped?: boolean };
		expect(retry.status).toBe(200);
		expect(retryJson).toMatchObject({ id: firstJson.id, deduped: true });
	});

	it("POST /api/memory/remember returns existing chunk ids on idempotent oversized retries", async () => {
		const content = Array.from(
			{ length: 90 },
			(_, index) => `Chunked provenance sentence ${index} carries enough words to split predictably.`,
		).join(" ");
		expect(content.length).toBeGreaterThan(800);

		const first = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content,
				who: "soulvessel.tests",
				idempotencyKey: "chunked-import-key",
			}),
		});
		const firstJson = (await first.json()) as {
			chunked?: boolean;
			chunk_count?: number;
			ids?: string[];
			group_id?: string;
		};
		expect(first.status).toBe(200);
		expect(firstJson.chunked).toBe(true);
		expect(firstJson.ids?.length).toBeGreaterThan(1);

		const retry = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content,
				who: "soulvessel.tests",
				idempotencyKey: "chunked-import-key",
			}),
		});
		const retryJson = (await retry.json()) as {
			chunked?: boolean;
			chunk_count?: number;
			deduped?: boolean;
			ids?: string[];
			group_id?: string;
		};
		expect(retry.status).toBe(200);
		expect(retryJson).toMatchObject({
			chunked: true,
			chunk_count: firstJson.chunk_count,
			deduped: true,
			group_id: firstJson.group_id,
			ids: firstJson.ids,
		});

		const row = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT COUNT(*) AS count FROM entities WHERE entity_type = 'chunk_group'").get() as
					| { count: number }
					| undefined,
		);
		// No chunk_group entity created — chunks are episodic evidence, not graph nodes.
		expect(row?.count).toBe(0);
	});

	it("POST /api/memory/remember rejects changed oversized content for an existing idempotency key", async () => {
		const content = Array.from(
			{ length: 90 },
			(_, index) => `Stable chunked import sentence ${index} carries enough words to split predictably.`,
		).join(" ");
		const changed = Array.from(
			{ length: 92 },
			(_, index) => `Changed chunked import sentence ${index} carries enough words to split predictably.`,
		).join(" ");
		expect(content.length).toBeGreaterThan(800);
		expect(changed.length).toBeGreaterThan(800);

		const first = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content,
				who: "soulvessel.tests",
				idempotencyKey: "chunked-import-conflict-key",
			}),
		});
		const firstJson = (await first.json()) as { ids?: string[] };
		expect(first.status).toBe(200);
		expect(firstJson.ids?.length).toBeGreaterThan(1);

		const conflict = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: changed,
				who: "soulvessel.tests",
				idempotencyKey: "chunked-import-conflict-key",
			}),
		});
		const conflictJson = (await conflict.json()) as { error?: string };
		expect(conflict.status).toBe(409);
		expect(conflictJson.error).toContain("different chunked content");

		const rows = getDbAccessor().withReadDb((db) => ({
			groups: (
				db.prepare("SELECT COUNT(*) AS count FROM entities WHERE entity_type = 'chunk_group'").get() as
					| { count: number }
					| undefined
			)?.count,
			chunks: (
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM memories WHERE idempotency_key LIKE 'chunked-import-conflict-key:chunk:%'",
					)
					.get() as { count: number } | undefined
			)?.count,
		}));
		expect(rows.groups).toBe(0);
		expect(rows.chunks).toBe(firstJson.ids?.length);
	});

	it("POST /api/memory/remember rejects mixed chunked and non-chunk idempotency-key reuse", async () => {
		const oversized = Array.from(
			{ length: 90 },
			(_, index) => `Mixed idempotency chunk sentence ${index} carries enough words to split predictably.`,
		).join(" ");
		expect(oversized.length).toBeGreaterThan(800);

		const small = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Small memory using a key before a chunked import.",
				who: "soulvessel.tests",
				idempotencyKey: "mixed-small-first-key",
			}),
		});
		expect(small.status).toBe(200);

		const chunkAfterSmall = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: oversized,
				who: "soulvessel.tests",
				idempotencyKey: "mixed-small-first-key",
			}),
		});
		const chunkAfterSmallJson = (await chunkAfterSmall.json()) as { error?: string };
		expect(chunkAfterSmall.status).toBe(409);
		expect(chunkAfterSmallJson.error).toContain("non-chunk content");

		const chunkFirst = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: oversized,
				who: "soulvessel.tests",
				idempotencyKey: "mixed-chunk-first-key",
			}),
		});
		expect(chunkFirst.status).toBe(200);

		const smallAfterChunk = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Small memory using a key after a chunked import.",
				who: "soulvessel.tests",
				idempotencyKey: "mixed-chunk-first-key",
			}),
		});
		const smallAfterChunkJson = (await smallAfterChunk.json()) as { error?: string };
		expect(smallAfterChunk.status).toBe(409);
		expect(smallAfterChunkJson.error).toContain("chunked content");
	});

	it("POST /api/memory/remember rejects chunked imports that would reuse unrelated content rows", async () => {
		const oversized = Array.from(
			{ length: 90 },
			(_, index) => `Existing chunk hash sentence ${index} carries enough words to split predictably.`,
		).join(" ");
		const firstChunk = chunkBySentence(oversized, 600)[0];
		expect(oversized.length).toBeGreaterThan(800);
		expect(firstChunk.length).toBeLessThan(800);

		const existing = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: firstChunk,
				who: "soulvessel.tests",
				idempotencyKey: "existing-normal-chunk-content-key",
			}),
		});
		expect(existing.status).toBe(200);

		const chunked = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: oversized,
				who: "soulvessel.tests",
				idempotencyKey: "chunked-existing-content-key",
			}),
		});
		const chunkedJson = (await chunked.json()) as { error?: string };
		expect(chunked.status).toBe(409);
		expect(chunkedJson.error).toContain("chunk content already exists");
	});

	it("POST /api/memory/remember resolves concurrent chunk hash collisions as conflicts", async () => {
		const oversized = Array.from(
			{ length: 90 },
			(_, index) => `Concurrent chunk hash sentence ${index} carries enough words to split predictably.`,
		).join(" ");
		expect(oversized.length).toBeGreaterThan(800);

		const keys = ["concurrent-chunk-content-key-a", "concurrent-chunk-content-key-b"] as const;
		const [first, second] = await Promise.all(
			keys.map((idempotencyKey) =>
				app.request("http://localhost/api/memory/remember", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						content: oversized,
						who: "soulvessel.tests",
						idempotencyKey,
					}),
				}),
			),
		);
		const statuses = [first.status, second.status].sort((a, b) => a - b);
		expect(statuses).toEqual([200, 409]);

		const conflict = first.status === 409 ? first : second;
		const conflictJson = (await conflict.json()) as { error?: string };
		expect(conflictJson.error).toContain("chunk content already exists");

		const losingKey = first.status === 409 ? keys[0] : keys[1];
		const losingGroupId = chunkGroupIdForDefaultScope(losingKey);
		const partial = getDbAccessor().withReadDb((db) => {
			const rows = db
				.prepare("SELECT id FROM memories WHERE idempotency_key LIKE ?")
				.all(`${losingKey}:chunk:%`) as Array<{
				id: string;
			}>;
			const group = db.prepare("SELECT id FROM entities WHERE id = ?").get(losingGroupId) as { id: string } | null;
			return { group, rows };
		});
		expect(partial.rows).toHaveLength(0);
		expect(partial.group).toBeNull();
	});

	it("GET /api/memory/:id returns row-level provenance for remembered rows", async () => {
		const res = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "HTTP-visible provenance memory",
				who: "soulvessel.tests",
				sourceType: "hermes-memory",
				sourceId: "hermes-doc-http-provenance-test",
				sourcePath: "/tmp/signet-provenance/HTTP.md",
				runtimePath: "memories/HTTP.md",
				idempotencyKey: "hermes:http-provenance-test",
			}),
		});
		const remembered = (await res.json()) as { id?: string };

		expect(res.status).toBe(200);
		expect(remembered.id).toBeString();

		const read = await app.request(`http://localhost/api/memory/${remembered.id}`);
		const json = (await read.json()) as {
			id?: string;
			source_id?: string | null;
			source_type?: string | null;
			source_path?: string | null;
			runtime_path?: string | null;
			idempotency_key?: string | null;
			sourcePath?: string | null;
			runtimePath?: string | null;
			idempotencyKey?: string | null;
		};

		expect(read.status).toBe(200);
		expect(json).toMatchObject({
			id: remembered.id,
			source_type: "hermes-memory",
			source_id: "hermes-doc-http-provenance-test",
			source_path: "/tmp/signet-provenance/HTTP.md",
			runtime_path: "memories/HTTP.md",
			idempotency_key: "hermes:http-provenance-test",
			sourcePath: "/tmp/signet-provenance/HTTP.md",
			runtimePath: "memories/HTTP.md",
			idempotencyKey: "hermes:http-provenance-test",
		});
	});

	it("GET /api/memory/:id applies agent scope before returning provenance", async () => {
		const res = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Private scoped provenance memory",
				agentId: "direct-read-agent-a",
				visibility: "private",
				who: "soulvessel.tests",
				sourceType: "hermes-memory",
				sourceId: "hermes-doc-private-provenance-test",
				sourcePath: "/tmp/signet-provenance/private.md",
				runtimePath: "memories/private.md",
				idempotencyKey: "hermes:private-provenance-test",
			}),
		});
		const remembered = (await res.json()) as { id?: string };

		expect(res.status).toBe(200);
		expect(remembered.id).toBeString();

		const crossAgent = await app.request(`http://localhost/api/memory/${remembered.id}?agentId=direct-read-agent-b`);
		const crossAgentJson = (await crossAgent.json()) as { error?: string; source_path?: string | null };
		expect(crossAgent.status).toBe(404);
		expect(crossAgentJson.error).toBe("not found");
		expect(crossAgentJson.source_path).toBeUndefined();

		const sameAgent = await app.request(`http://localhost/api/memory/${remembered.id}?agentId=direct-read-agent-a`);
		const sameAgentJson = (await sameAgent.json()) as {
			id?: string;
			source_path?: string | null;
			idempotency_key?: string | null;
		};
		expect(sameAgent.status).toBe(200);
		expect(sameAgentJson).toMatchObject({
			id: remembered.id,
			source_path: "/tmp/signet-provenance/private.md",
			idempotency_key: "hermes:private-provenance-test",
		});
	});

	it("POST /api/memory/remember retains structured payload as episodic evidence without graph writes (#946)", async () => {
		const res = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Nicholai uses Signet for benchmark memory.",
				agentId: "bench-agent",
				structured: {
					entities: [
						{
							source: "Nicholai",
							sourceType: "person",
							relationship: "uses",
							target: "Signet",
							targetType: "system",
							confidence: 0.95,
						},
					],
					aspects: [
						{
							entityName: "Nicholai",
							aspect: "tools",
							attributes: [{ content: "Nicholai uses Signet for benchmark memory.", confidence: 0.95 }],
						},
					],
					hints: ["What does Nicholai use for benchmark memory?"],
				},
			}),
		});
		const json = (await res.json()) as {
			id?: string;
			structured?: boolean;
			structured_applied?: boolean;
			entities_linked?: number;
			hints_written?: number;
		};

		expect(res.status).toBe(200);
		// Structured input is retained as evidence, not applied to the graph.
		expect(json.structured).toBe(true);
		expect(json.structured_applied).toBe(false);
		expect(json.entities_linked).toBe(0);
		expect(json.hints_written).toBe(1);

		// No entities, aspects, attributes, or mentions written.
		const graphCounts = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT
							(SELECT COUNT(*) FROM entities WHERE agent_id = ?) AS entities,
							(SELECT COUNT(*) FROM entity_aspects) AS aspects,
							(SELECT COUNT(*) FROM entity_attributes) AS attributes,
							(SELECT COUNT(*) FROM memory_entity_mentions WHERE memory_id = ?) AS mentions,
							(SELECT COUNT(*) FROM memory_jobs WHERE memory_id = ? AND job_type = 'extract') AS extract_jobs`,
					)
					.get("bench-agent", json.id, json.id) as {
					entities: number;
					aspects: number;
					attributes: number;
					mentions: number;
					extract_jobs: number;
				},
		);
		expect(graphCounts.entities).toBe(0);
		expect(graphCounts.aspects).toBe(0);
		expect(graphCounts.attributes).toBe(0);
		expect(graphCounts.mentions).toBe(0);
		expect(graphCounts.extract_jobs).toBe(0);

		// The evidence is immediately retrievable.
		const evidence = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT content, memory_kind, is_deleted FROM memories WHERE id = ?").get(json.id) as {
					content: string;
					memory_kind: string;
					is_deleted: number;
				},
		);
		expect(evidence.content).toBe("Nicholai uses Signet for benchmark memory.");
		expect(evidence.memory_kind).toBe("episodic");
		expect(evidence.is_deleted).toBe(0);

		const hint = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT hint FROM memory_hints WHERE agent_id = ? AND memory_id = ?").get("bench-agent", json.id) as
					| { hint: string }
					| undefined,
		);
		expect(hint?.hint).toBe("What does Nicholai use for benchmark memory?");
	});

	it("POST /api/memory/remember retains aspect-only structured payloads as evidence without creating entities (#946)", async () => {
		const res = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "The benchmark user has been using Spotify lately.",
				agentId: "bench-agent",
				structured: {
					aspects: [
						{
							entityName: "MemoryBench User ccb36322",
							entityType: "person",
							aspect: "music preferences",
							attributes: [
								{
									content: "MemoryBench User ccb36322 has been using Spotify lately.",
									confidence: 0.9,
									importance: 0.8,
								},
							],
						},
					],
				},
			}),
		});
		const json = (await res.json()) as {
			id?: string;
			structured?: boolean;
			structured_applied?: boolean;
			entities_linked?: number;
		};

		expect(res.status).toBe(200);
		expect(json.structured).toBe(true);
		expect(json.structured_applied).toBe(false);
		expect(json.entities_linked).toBe(0);

		// No entities, aspects, or attributes created from the structured payload.
		const entityCount = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT COUNT(*) as cnt FROM entities WHERE agent_id = ?").get("bench-agent") as { cnt: number },
		);
		expect(entityCount.cnt).toBe(0);

		// Evidence is immediately retrievable.
		const evidence = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT content, memory_kind FROM memories WHERE id = ?").get(json.id) as {
					content: string;
					memory_kind: string;
				},
		);
		expect(evidence.content).toBe("The benchmark user has been using Spotify lately.");
		expect(evidence.memory_kind).toBe("episodic");
	});

	it("POST /api/memory/remember does not supersede structured attributes — no graph writes (#946)", async () => {
		const basePayload = {
			agentId: "bench-agent",
			structured: {
				aspects: [
					{
						entityName: "MemoryBench User restaurants",
						entityType: "person",
						aspect: "dining history",
						attributes: [
							{
								claimKey: "korean_restaurants_tried_count",
								content: "MemoryBench User restaurants has tried three Korean restaurants.",
								confidence: 0.9,
								importance: 0.8,
							},
						],
					},
				],
			},
		};

		const oldRes = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...basePayload,
				content: "The benchmark user had tried three Korean restaurants.",
				createdAt: "2023-05-01T12:00:00.000Z",
			}),
		});
		expect(oldRes.status).toBe(200);

		const newRes = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...basePayload,
				content: "The benchmark user has now tried four Korean restaurants.",
				createdAt: "2023-06-01T12:00:00.000Z",
				structured: {
					aspects: [
						{
							entityName: "MemoryBench User restaurants",
							entityType: "person",
							aspect: "dining history",
							attributes: [
								{
									claimKey: "korean_restaurants_tried_count",
									content: "MemoryBench User restaurants has now tried four Korean restaurants.",
									confidence: 0.9,
									importance: 0.8,
								},
							],
						},
					],
				},
			}),
		});
		expect(newRes.status).toBe(200);

		// No entities or attributes created — no supersession from remember.
		const attributeCount = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) as cnt FROM entity_attributes").get() as { cnt: number },
		);
		expect(attributeCount.cnt).toBe(0);

		// Both memories are immediately retrievable as episodic evidence.
		const memories = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT content FROM memories WHERE agent_id = ? AND memory_kind = 'episodic' ORDER BY created_at")
					.all("bench-agent") as Array<{ content: string }>,
		);
		expect(memories.map((m) => m.content)).toEqual([
			"The benchmark user had tried three Korean restaurants.",
			"The benchmark user has now tried four Korean restaurants.",
		]);
	});

	it("POST /api/memory/remember retains multiple structured claims as separate evidence rows (#946)", async () => {
		for (const payload of [
			{
				content: "The benchmark user asked for a Parable of the Sower poem.",
				createdAt: "2023-05-01T12:00:00.000Z",
				claimKey: "asked_for_parable_of_the_sower_poem",
				attribute: "MemoryBench User events asked for a poem summarizing Octavia Butler's Parable of the Sower.",
			},
			{
				content: "The benchmark user asked for web-search privacy papers.",
				createdAt: "2023-05-02T12:00:00.000Z",
				claimKey: "asked_for_web_search_privacy_papers",
				attribute: "MemoryBench User events asked for research paper suggestions about web-search privacy.",
			},
		]) {
			const res = await app.request("http://localhost/api/memory/remember", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: payload.content,
					createdAt: payload.createdAt,
					agentId: "bench-agent",
					structured: {
						aspects: [
							{
								entityName: "MemoryBench User events",
								entityType: "person",
								aspect: "events",
								attributes: [
									{
										claimKey: payload.claimKey,
										content: payload.attribute,
										confidence: 0.9,
										importance: 0.7,
									},
								],
							},
						],
					},
				}),
			});
			expect(res.status).toBe(200);
		}

		// No entity_attributes written from remember.
		const attributeCount = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) as cnt FROM entity_attributes").get() as { cnt: number },
		);
		expect(attributeCount.cnt).toBe(0);

		// Both memories are retained as separate episodic evidence rows.
		const memories = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT content FROM memories WHERE agent_id = ? AND memory_kind = 'episodic' ORDER BY created_at")
					.all("bench-agent") as Array<{ content: string }>,
		);
		expect(memories.map((m) => m.content)).toEqual([
			"The benchmark user asked for a Parable of the Sower poem.",
			"The benchmark user asked for web-search privacy papers.",
		]);
	});

	it("POST /api/memory/remember rejects invalid source timestamps", async () => {
		const res = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Invalid timestamp memory.",
				createdAt: "not-a-date",
			}),
		});
		const json = (await res.json()) as { error?: string };

		expect(res.status).toBe(400);
		expect(json.error).toBe("createdAt must be a valid ISO timestamp");
	});

	it("POST /api/memory/remember does not inline-link entities but still writes hints and episodic evidence (#946)", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities (
					id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
				) VALUES (?, ?, ?, 'person', ?, 0, ?, ?)`,
			).run("ent-inline-nicholai", "Nicholai", "nicholai", "inline-agent", now, now);
		});

		const res = await app.request("http://localhost/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Nicholai keeps MemoryBench results out of committed benchmark artifacts.",
				agentId: "inline-agent",
				hints: ["What does Nicholai keep out of committed benchmark artifacts?"],
			}),
		});
		const json = (await res.json()) as { id?: string; entities_linked?: number; hints_written?: number };

		expect(res.status).toBe(200);
		// No inline entity linking — entities_linked is always 0.
		expect(json.entities_linked).toBe(0);
		expect(json.hints_written).toBe(1);

		// No new mentions written to the pre-existing entity.
		const mentionCount = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT COUNT(*) as cnt FROM memory_entity_mentions WHERE memory_id = ?").get(json.id) as {
					cnt: number;
				},
		);
		expect(mentionCount.cnt).toBe(0);

		const hint = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT hint FROM memory_hints WHERE memory_id = ? AND agent_id = ?").get(json.id, "inline-agent") as
					| { hint: string }
					| undefined,
		);
		expect(hint?.hint).toBe("What does Nicholai keep out of committed benchmark artifacts?");
	});

	it("PATCH /api/memory/:id requires reason", async () => {
		seedMemory({
			id: "mem-1",
			content: "Original memory",
			contentHash: "hash-mem-1",
		});

		const res = await app.request("http://localhost/api/memory/mem-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tags: "updated" }),
		});
		const json = (await res.json()) as { error?: string };

		expect(res.status).toBe(400);
		expect(json.error).toBe("reason is required");
	});

	it("PATCH /api/memory/:id rejects content/type edits on episodic evidence (#946)", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			txIngestEnvelope(db, {
				id: "mem-episodic",
				content: "Original episodic evidence",
				normalizedContent: "original episodic evidence",
				contentHash: "hash-episodic",
				who: "test",
				why: "test",
				project: "api-test",
				importance: 0.7,
				type: "fact",
				tags: "seed",
				pinned: 0,
				isDeleted: 0,
				extractionStatus: "none",
				embeddingModel: null,
				extractionModel: null,
				updatedBy: "test",
				memoryKind: "episodic",
				sourceType: "manual",
				sourceId: "mem-episodic",
				createdAt: now,
			});
		});

		// Content change rejected.
		const contentRes = await app.request("http://localhost/api/memory/mem-episodic", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "Tampered evidence",
				contentHash: "hash-tampered",
				reason: "attempt rewrite",
			}),
		});
		expect(contentRes.status).toBe(409);
		const contentJson = (await contentRes.json()) as { status?: string; error?: string };
		expect(contentJson.status).toBe("episodic_content_immutable");

		// Metadata change allowed.
		const metaRes = await app.request("http://localhost/api/memory/mem-episodic", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tags: "re-ranked", reason: "re-rank" }),
		});
		expect(metaRes.status).toBe(200);
		const metaJson = (await metaRes.json()) as { status?: string };
		expect(metaJson.status).toBe("updated");
	});

	it("PATCH /api/memory/:id keeps materialized semantic claims on the ontology path", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			txIngestEnvelope(db, {
				id: "semantic-claim-api",
				content: "Signet is a memory system.",
				normalizedContent: "signet is a memory system.",
				contentHash: "semantic-claim-api-hash",
				who: "dreaming",
				why: "test",
				project: null,
				importance: 0.9,
				type: "semantic",
				tags: "semantic,attribute",
				pinned: 0,
				isDeleted: 0,
				extractionStatus: "completed",
				embeddingModel: null,
				extractionModel: null,
				updatedBy: "dreaming",
				memoryKind: "derived",
				sourceType: "dreaming",
				sourceId: null,
				createdAt: now,
			});
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, memory_id, agent_id, kind, content, normalized_content, confidence, importance, status)
				 VALUES ('semantic-claim-api', 'semantic-claim-api', 'default', 'fact', ?, ?, 0.9, 0.9, 'active')`,
			).run("Signet is a memory system.", "signet is a memory system.");
		});

		const response = await app.request("http://localhost/api/memory/semantic-claim-api", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "Signet is a search engine.", reason: "attempt bypass" }),
		});
		expect(response.status).toBe(409);
		expect((await response.json()) as { status?: string }).toMatchObject({
			status: "semantic_projection_content_immutable",
		});
	});

	it("PATCH /api/memory/:id enforces if_version optimistic concurrency", async () => {
		seedMemory({
			id: "mem-2",
			content: "Original memory",
			contentHash: "hash-mem-2",
		});

		const res = await app.request("http://localhost/api/memory/mem-2", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				tags: "updated",
				reason: "manual edit",
				if_version: 2,
			}),
		});
		const json = (await res.json()) as {
			status?: string;
			currentVersion?: number;
		};

		expect(res.status).toBe(409);
		expect(json.status).toBe("version_conflict");
		expect(json.currentVersion).toBe(1);
	});

	it("DELETE /api/memory/:id blocks pinned delete without force", async () => {
		seedMemory({
			id: "mem-pinned",
			content: "Pinned memory",
			contentHash: "hash-mem-pinned",
			pinned: 1,
		});

		const res = await app.request("http://localhost/api/memory/mem-pinned?reason=cleanup", { method: "DELETE" });
		const json = (await res.json()) as { status?: string };

		expect(res.status).toBe(409);
		expect(json.status).toBe("pinned_requires_force");
	});

	it("GET /api/memories hides soft-deleted memories from dashboard lists", async () => {
		seedMemory({
			id: "mem-visible",
			content: "Visible dashboard memory",
			contentHash: "hash-mem-visible",
		});
		seedMemory({
			id: "mem-legacy-null",
			content: "Legacy active dashboard memory",
			contentHash: "hash-mem-legacy-null",
			pinned: 1,
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET is_deleted = NULL, importance = 0.95 WHERE id = ?").run("mem-legacy-null");
		});
		seedMemory({
			id: "mem-deleted",
			content: "Deleted dashboard memory should not leak",
			contentHash: "hash-mem-deleted",
		});

		const deleteRes = await app.request("http://localhost/api/memory/mem-deleted?reason=dashboard cleanup", {
			method: "DELETE",
		});
		expect(deleteRes.status).toBe(200);

		const res = await app.request("http://localhost/api/memories?limit=10");
		const json = (await res.json()) as {
			memories: Array<{ id: string; content: string }>;
			stats: { total: number; critical: number };
		};

		expect(res.status).toBe(200);
		expect(new Set(json.memories.map((memory) => memory.id))).toEqual(new Set(["mem-legacy-null", "mem-visible"]));
		expect(json.stats.total).toBe(2);
		expect(json.stats.critical).toBe(1);
	});

	it("POST /api/memory/modify returns per-item results (atomic per item)", async () => {
		seedMemory({
			id: "mem-a",
			content: "Memory A",
			contentHash: "hash-mem-a",
		});
		seedMemory({
			id: "mem-b",
			content: "Memory B",
			contentHash: "hash-mem-b",
		});

		const res = await app.request("http://localhost/api/memory/modify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				patches: [
					{
						id: "mem-a",
						tags: "edited",
						reason: "fix tags",
						if_version: 1,
					},
					{
						id: "mem-b",
						type: "decision",
						reason: "stale version",
						if_version: 2,
					},
				],
			}),
		});
		const json = (await res.json()) as {
			total: number;
			updated: number;
			results: Array<{ id: string; status: string }>;
		};

		expect(res.status).toBe(200);
		expect(json.total).toBe(2);
		expect(json.updated).toBe(1);
		expect(json.results[0]?.id).toBe("mem-a");
		expect(json.results[0]?.status).toBe("updated");
		expect(json.results[1]?.id).toBe("mem-b");
		expect(json.results[1]?.status).toBe("version_conflict");
	});

	it("POST /api/memory/forget preview+execute requires confirm_token over threshold", async () => {
		for (let i = 0; i < 26; i += 1) {
			const id = `mem-batch-${i}`;
			seedMemory({
				id,
				content: `Batch memory ${i}`,
				contentHash: `hash-batch-${i}`,
				type: "fact",
			});
		}

		const previewRes = await app.request("http://localhost/api/memory/forget", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mode: "preview",
				type: "fact",
				limit: 26,
			}),
		});
		const previewJson = (await previewRes.json()) as {
			mode: string;
			count: number;
			requiresConfirm: boolean;
			confirmToken: string;
		};

		expect(previewRes.status).toBe(200);
		expect(previewJson.mode).toBe("preview");
		expect(previewJson.count).toBe(26);
		expect(previewJson.requiresConfirm).toBe(true);
		expect(previewJson.confirmToken.length).toBeGreaterThan(0);

		const executeWithoutConfirm = await app.request("http://localhost/api/memory/forget", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mode: "execute",
				type: "fact",
				limit: 26,
				reason: "bulk cleanup",
			}),
		});
		expect(executeWithoutConfirm.status).toBe(400);

		const executeWithConfirm = await app.request("http://localhost/api/memory/forget", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mode: "execute",
				type: "fact",
				limit: 26,
				reason: "bulk cleanup",
				confirm_token: previewJson.confirmToken,
			}),
		});
		const executeJson = (await executeWithConfirm.json()) as {
			mode: string;
			requested: number;
			deleted: number;
		};

		expect(executeWithConfirm.status).toBe(200);
		expect(executeJson.mode).toBe("execute");
		expect(executeJson.requested).toBe(26);
		expect(executeJson.deleted).toBe(26);
	});

	it("POST /api/memory/forget rejects if_version for batch operations", async () => {
		seedMemory({
			id: "mem-forget-ifv",
			content: "Batch forget candidate",
			contentHash: "hash-forget-ifv",
		});

		const res = await app.request("http://localhost/api/memory/forget", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mode: "execute",
				ids: ["mem-forget-ifv"],
				reason: "cleanup",
				if_version: 1,
			}),
		});
		const json = (await res.json()) as { error?: string };

		expect(res.status).toBe(400);
		expect(json.error).toContain("if_version is not supported for batch forget");
	});

	it("GET /api/memory/:id/history returns ordered mutation events", async () => {
		seedMemory({
			id: "mem-history",
			content: "History target",
			contentHash: "hash-history",
		});

		const patchRes = await app.request("http://localhost/api/memory/mem-history", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				tags: "edited",
				reason: "history test edit",
			}),
		});
		expect(patchRes.status).toBe(200);

		const forgetRes = await app.request("http://localhost/api/memory/mem-history?reason=history test delete", {
			method: "DELETE",
		});
		expect(forgetRes.status).toBe(200);

		const historyRes = await app.request("http://localhost/api/memory/mem-history/history");
		const historyJson = (await historyRes.json()) as {
			memoryId: string;
			count: number;
			history: Array<{ event: string; reason: string | null }>;
		};

		expect(historyRes.status).toBe(200);
		expect(historyJson.memoryId).toBe("mem-history");
		expect(historyJson.count).toBe(2);
		expect(historyJson.history[0]?.event).toBe("updated");
		expect(historyJson.history[0]?.reason).toBe("history test edit");
		expect(historyJson.history[1]?.event).toBe("deleted");
		expect(historyJson.history[1]?.reason).toBe("history test delete");
	});

	it("POST /api/memory/:id/recover restores a recently deleted memory", async () => {
		seedMemory({
			id: "mem-recover",
			content: "Recover target",
			contentHash: "hash-recover",
		});

		const forgetRes = await app.request("http://localhost/api/memory/mem-recover?reason=cleanup", { method: "DELETE" });
		expect(forgetRes.status).toBe(200);

		const recoverRes = await app.request("http://localhost/api/memory/mem-recover/recover", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "rollback delete" }),
		});
		const recoverJson = (await recoverRes.json()) as { status?: string };
		expect(recoverRes.status).toBe(200);
		expect(recoverJson.status).toBe("recovered");

		const row = getDbAccessor().withReadDb((db) => {
			return db.prepare("SELECT is_deleted FROM memories WHERE id = ?").get("mem-recover") as
				| { is_deleted: number }
				| undefined;
		});
		expect(row?.is_deleted).toBe(0);
	});

	it("POST /api/memory/:id/recover rejects recover after retention window", async () => {
		seedMemory({
			id: "mem-recover-expired",
			content: "Expired recover target",
			contentHash: "hash-recover-expired",
		});

		const expiredDeletedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`UPDATE memories
				 SET is_deleted = 1, deleted_at = ?, version = version + 1
				 WHERE id = ?`,
			).run(expiredDeletedAt, "mem-recover-expired");
		});

		const recoverRes = await app.request("http://localhost/api/memory/mem-recover-expired/recover", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "too late" }),
		});
		const recoverJson = (await recoverRes.json()) as { status?: string };

		expect(recoverRes.status).toBe(409);
		expect(recoverJson.status).toBe("retention_expired");
	});
});
