import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
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

describe("mutation API routes", () => {
	beforeAll(async () => {
		originalSignetPath = process.env.SIGNET_PATH;
		agentsDir = mkdtempSync(join(tmpdir(), "signet-daemon-mutation-api-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`memory:
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

	it("POST /api/memory/remember persists structured graph data under the requested agent", async () => {
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
			entities_linked?: number;
			hints_written?: number;
		};

		expect(res.status).toBe(200);
		expect(json.structured).toBe(true);
		expect(json.entities_linked).toBeGreaterThan(0);
		expect(json.hints_written).toBe(1);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT ea.content
						 FROM entities e
						 JOIN entity_aspects asp ON asp.entity_id = e.id
						 JOIN entity_attributes ea ON ea.aspect_id = asp.id
						 WHERE e.agent_id = ? AND e.canonical_name = ?`,
					)
					.get("bench-agent", "nicholai") as { content: string } | undefined,
		);
		expect(row?.content).toBe("Nicholai uses Signet for benchmark memory.");

		const hint = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT hint FROM memory_hints WHERE agent_id = ? AND memory_id = ?").get("bench-agent", json.id) as
					| { hint: string }
					| undefined,
		);
		expect(hint?.hint).toBe("What does Nicholai use for benchmark memory?");
	});

	it("POST /api/memory/remember creates entities from aspect-only structured payloads", async () => {
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
		const json = (await res.json()) as { id?: string; structured?: boolean; entities_linked?: number };

		expect(res.status).toBe(200);
		expect(json.structured).toBe(true);
		expect(json.entities_linked).toBeGreaterThan(0);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT e.entity_type, asp.name AS aspect, ea.content
						 FROM entities e
						 JOIN entity_aspects asp ON asp.entity_id = e.id
						 JOIN entity_attributes ea ON ea.aspect_id = asp.id
						 WHERE e.agent_id = ? AND e.canonical_name = ?`,
					)
					.get("bench-agent", "memorybench user ccb36322") as
					| { entity_type: string; aspect: string; content: string }
					| undefined,
		);

		expect(row).toEqual({
			entity_type: "person",
			aspect: "music preferences",
			content: "MemoryBench User ccb36322 has been using Spotify lately.",
		});
	});

	it("POST /api/memory/remember uses source timestamps to supersede stale structured attributes", async () => {
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

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT ea.content, ea.status, replacement.content AS replacement
						 FROM entities e
						 JOIN entity_aspects asp ON asp.entity_id = e.id
						 JOIN entity_attributes ea ON ea.aspect_id = asp.id
						 LEFT JOIN entity_attributes replacement ON replacement.id = ea.superseded_by
						 WHERE e.agent_id = ? AND e.canonical_name = ?
						 ORDER BY ea.created_at`,
					)
					.all("bench-agent", "memorybench user restaurants") as Array<{
					content: string;
					status: string;
					replacement: string | null;
				}>,
		);

		expect(rows).toEqual([
			{
				content: "MemoryBench User restaurants has tried three Korean restaurants.",
				status: "superseded",
				replacement: "MemoryBench User restaurants has now tried four Korean restaurants.",
			},
			{
				content: "MemoryBench User restaurants has now tried four Korean restaurants.",
				status: "active",
				replacement: null,
			},
		]);
	});

	it("POST /api/memory/remember does not supersede unrelated claims on the same aspect", async () => {
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

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT ea.claim_key, ea.status
						 FROM entities e
						 JOIN entity_aspects asp ON asp.entity_id = e.id
						 JOIN entity_attributes ea ON ea.aspect_id = asp.id
						 WHERE e.agent_id = ? AND e.canonical_name = ?
						 ORDER BY ea.claim_key`,
					)
					.all("bench-agent", "memorybench user events") as Array<{ claim_key: string; status: string }>,
		);

		expect(rows).toEqual([
			{ claim_key: "asked_for_parable_of_the_sower_poem", status: "active" },
			{ claim_key: "asked_for_web_search_privacy_papers", status: "active" },
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

	it("POST /api/memory/remember scopes inline entity linking and client hints to the requested agent", async () => {
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
		expect(json.entities_linked).toBeGreaterThan(0);
		expect(json.hints_written).toBe(1);

		const entity = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT id FROM entities WHERE canonical_name = ? AND agent_id = ?")
					.get("nicholai", "inline-agent") as { id: string } | undefined,
		);
		expect(entity).toBeDefined();

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
