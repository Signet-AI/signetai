import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { txIngestEnvelope } from "./transactions";

let app: {
	request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};
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
			db.prepare("UPDATE memories SET version = ? WHERE id = ?").run(
				args.version,
				args.id,
			);
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

		const res = await app.request(
			"http://localhost/api/memory/mem-pinned?reason=cleanup",
			{ method: "DELETE" },
		);
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

		const executeWithoutConfirm = await app.request(
			"http://localhost/api/memory/forget",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mode: "execute",
					type: "fact",
					limit: 26,
					reason: "bulk cleanup",
				}),
			},
		);
		expect(executeWithoutConfirm.status).toBe(400);

		const executeWithConfirm = await app.request(
			"http://localhost/api/memory/forget",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mode: "execute",
					type: "fact",
					limit: 26,
					reason: "bulk cleanup",
					confirm_token: previewJson.confirmToken,
				}),
			},
		);
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
		expect(json.error).toContain(
			"if_version is not supported for batch forget",
		);
	});

	it("GET /api/memory/:id/history returns ordered mutation events", async () => {
		seedMemory({
			id: "mem-history",
			content: "History target",
			contentHash: "hash-history",
		});

		const patchRes = await app.request(
			"http://localhost/api/memory/mem-history",
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					tags: "edited",
					reason: "history test edit",
				}),
			},
		);
		expect(patchRes.status).toBe(200);

		const forgetRes = await app.request(
			"http://localhost/api/memory/mem-history?reason=history test delete",
			{ method: "DELETE" },
		);
		expect(forgetRes.status).toBe(200);

		const historyRes = await app.request(
			"http://localhost/api/memory/mem-history/history",
		);
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

		const forgetRes = await app.request(
			"http://localhost/api/memory/mem-recover?reason=cleanup",
			{ method: "DELETE" },
		);
		expect(forgetRes.status).toBe(200);

		const recoverRes = await app.request(
			"http://localhost/api/memory/mem-recover/recover",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason: "rollback delete" }),
			},
		);
		const recoverJson = (await recoverRes.json()) as { status?: string };
		expect(recoverRes.status).toBe(200);
		expect(recoverJson.status).toBe("recovered");

		const row = getDbAccessor().withReadDb((db) => {
			return db
				.prepare("SELECT is_deleted FROM memories WHERE id = ?")
				.get("mem-recover") as { is_deleted: number } | undefined;
		});
		expect(row?.is_deleted).toBe(0);
	});

	it("POST /api/memory/:id/recover rejects recover after retention window", async () => {
		seedMemory({
			id: "mem-recover-expired",
			content: "Expired recover target",
			contentHash: "hash-recover-expired",
		});

		const expiredDeletedAt = new Date(
			Date.now() - 31 * 24 * 60 * 60 * 1000,
		).toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`UPDATE memories
				 SET is_deleted = 1, deleted_at = ?, version = version + 1
				 WHERE id = ?`,
			).run(expiredDeletedAt, "mem-recover-expired");
		});

		const recoverRes = await app.request(
			"http://localhost/api/memory/mem-recover-expired/recover",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason: "too late" }),
			},
		);
		const recoverJson = (await recoverRes.json()) as { status?: string };

		expect(recoverRes.status).toBe(409);
		expect(recoverJson.status).toBe("retention_expired");
	});
});
