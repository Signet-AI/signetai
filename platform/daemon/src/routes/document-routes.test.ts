import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { DbAccessor } from "../db-accessor";

const previousSignetPath = process.env.SIGNET_PATH;
let agentsDir: string;
let appFactory: typeof import("hono").Hono;
let registerMemoryRoutes: typeof import("./memory-routes").registerMemoryRoutes;
let initDbAccessor: typeof import("../db-accessor").initDbAccessor;
let closeDbAccessor: typeof import("../db-accessor").closeDbAccessor;
let getDbAccessor: typeof import("../db-accessor").getDbAccessor;
let createAuthMiddleware: typeof import("../auth").createAuthMiddleware;
let createToken: typeof import("../auth").createToken;
let loadMemoryConfig: typeof import("../memory-config").loadMemoryConfig;
let startDocumentWorker: typeof import("../pipeline/document-worker").startDocumentWorker;
let state: typeof import("./state.js");

function writeAuthConfig(mode: "local" | "team"): void {
	writeFileSync(
		join(agentsDir, "agent.yaml"),
		`auth:\n  mode: ${mode}\n  rateLimits:\n    forget:\n      windowMs: 60000\n      max: 30\n    modify:\n      windowMs: 60000\n      max: 60\n    batchForget:\n      windowMs: 60000\n      max: 5\n    admin:\n      windowMs: 60000\n      max: 10\n    recallLlm:\n      windowMs: 60000\n      max: 60\n`,
	);
}

function seedDocument(
	accessor: DbAccessor,
	input: {
		readonly documentId: string;
		readonly memoryId: string;
		readonly agentId: string;
		readonly project?: string;
	},
): void {
	const now = new Date().toISOString();
	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
			 VALUES (?, ?, 'isolated', NULL, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
		).run(input.agentId, input.agentId, now, now);
		db.prepare(
			`INSERT INTO documents
			 (id, source_type, content_type, content_hash, title, raw_content, status,
			  chunk_count, memory_count, agent_id, project, created_at, updated_at)
			 VALUES (?, 'text', 'text/plain', ?, ?, ?, 'completed', 1, 1, ?, ?, ?, ?)`,
		).run(
			input.documentId,
			`${input.documentId}-hash`,
			input.documentId,
			"document body",
			input.agentId,
			input.project ?? null,
			now,
			now,
		);
		db.prepare(
			`INSERT INTO memories
			 (id, type, content, importance, who, project, created_at, updated_at,
			  updated_by, agent_id, visibility, is_deleted)
			 VALUES (?, 'fact', ?, 0.5, 'document-worker', ?, ?, ?, 'test', ?, 'global', 0)`,
		).run(input.memoryId, `chunk for ${input.documentId}`, input.project ?? null, now, now, input.agentId);
		db.prepare(
			`INSERT INTO document_memories (document_id, memory_id, chunk_index)
			 VALUES (?, ?, 0)`,
		).run(input.documentId, input.memoryId);
	});
}

async function makeApp(mode: "local" | "team"): Promise<Hono> {
	writeAuthConfig(mode);
	state.reloadAuthState(agentsDir);
	const app = new appFactory();
	if (mode === "team") {
		if (!state.authSecret) throw new Error("expected auth secret in team mode");
		app.use("*", createAuthMiddleware(state.authConfig, state.authSecret));
	}
	registerMemoryRoutes(app, { fetchEmbedding: async () => null });
	return app;
}

function teamToken(scope: { agent?: string; project?: string } = {}): string {
	if (!state.authSecret) throw new Error("expected auth secret");
	return createToken(state.authSecret, { sub: "document-route-test", role: "operator", scope }, 60);
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for document worker");
}

async function processPendingDocuments(
	fetchEmbedding: (content: string) => Promise<number[] | null> = async () => null,
): Promise<void> {
	const cfg = loadMemoryConfig(agentsDir);
	const worker = startDocumentWorker({
		accessor: getDbAccessor(),
		embeddingCfg: cfg.embedding,
		fetchEmbedding,
		pipelineCfg: {
			...cfg.pipelineV2,
			documents: {
				...cfg.pipelineV2.documents,
				chunkOverlap: 0,
				chunkSize: 1_000,
				workerIntervalMs: 5,
			},
		},
	});
	try {
		await waitFor(() =>
			getDbAccessor().withReadDb((db) => {
				const pending = db
					.prepare(
						"SELECT COUNT(*) AS count FROM memory_jobs WHERE job_type = 'document_ingest' AND status != 'completed'",
					)
					.get() as { count: number };
				return pending.count === 0;
			}),
		);
	} finally {
		await worker.stop();
	}
}

beforeAll(async () => {
	agentsDir = mkdtempSync(join(tmpdir(), "signet-document-routes-"));
	mkdirSync(join(agentsDir, "memory"), { recursive: true });
	mkdirSync(join(agentsDir, ".daemon"), { recursive: true });
	writeFileSync(join(agentsDir, ".daemon", "auth-secret"), "test-secret-key-32-bytes-min!!!!");
	process.env.SIGNET_PATH = agentsDir;

	const hono = await import("hono");
	appFactory = hono.Hono;
	({ initDbAccessor, closeDbAccessor, getDbAccessor } = await import("../db-accessor"));
	({ registerMemoryRoutes } = await import("./memory-routes"));
	({ createAuthMiddleware, createToken } = await import("../auth"));
	({ loadMemoryConfig } = await import("../memory-config"));
	({ startDocumentWorker } = await import("../pipeline/document-worker"));
	state = await import("./state.js");
	initDbAccessor(join(agentsDir, "memory", "memories.db"));
});

beforeEach(() => {
	getDbAccessor().withWriteTx((db) => {
		db.prepare("DELETE FROM document_memories").run();
		db.prepare("DELETE FROM documents").run();
		db.prepare("DELETE FROM memory_jobs").run();
		db.prepare("DELETE FROM memory_history").run();
		db.prepare("DELETE FROM memories").run();
		db.prepare("DELETE FROM agents").run();
	});
});

afterAll(() => {
	closeDbAccessor();
	if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousSignetPath;
	rmSync(agentsDir, { recursive: true, force: true });
});

describe("document routes", () => {
	it("lists document chunks in local mode", async () => {
		seedDocument(getDbAccessor(), { documentId: "doc-local", memoryId: "mem-local", agentId: "default" });
		const app = await makeApp("local");

		const res = await app.request("/api/documents/doc-local/chunks");

		expect(res.status).toBe(200);
		const body = (await res.json()) as { count: number; chunks: Array<{ id: string; content: string }> };
		expect(body.count).toBe(1);
		expect(body.chunks[0]).toMatchObject({ id: "mem-local", content: "chunk for doc-local" });
	});

	it("soft-deletes document chunks in local mode", async () => {
		seedDocument(getDbAccessor(), { documentId: "doc-delete", memoryId: "mem-delete", agentId: "default" });
		const app = await makeApp("local");

		const res = await app.request("/api/documents/doc-delete?reason=cleanup", { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ deleted: true, memoriesRemoved: 1 });
		const row = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT is_deleted FROM memories WHERE id = 'mem-delete'").get() as { is_deleted: number },
		);
		expect(row.is_deleted).toBe(1);
	});

	it("does not deduplicate URL documents across scoped agents", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO documents
				 (id, source_url, source_type, content_type, content_hash, title, raw_content, status,
				  chunk_count, memory_count, agent_id, project, created_at, updated_at)
				 VALUES ('doc-url-other', 'https://example.test/doc', 'url', 'text/html', 'url-hash',
				  'other', NULL, 'queued', 0, 0, 'agent-b', '/repo/b', ?, ?)`,
			).run(now, now);
		});
		const app = await makeApp("team");
		const headers = {
			authorization: `Bearer ${teamToken({ agent: "agent-a", project: "/repo/a" })}`,
			"content-type": "application/json",
		};

		const res = await app.request("/api/documents", {
			method: "POST",
			headers,
			body: JSON.stringify({ source_type: "url", url: "https://example.test/doc", project: "/repo/a" }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; deduplicated?: boolean };
		expect(body.id).not.toBe("doc-url-other");
		expect(body.deduplicated).toBeUndefined();
	});

	it("deduplicates URL documents within the same scoped agent and project", async () => {
		const app = await makeApp("team");
		const headers = {
			authorization: `Bearer ${teamToken({ agent: "agent-a", project: "/repo/a" })}`,
			"content-type": "application/json",
		};
		const first = await app.request("/api/documents", {
			method: "POST",
			headers,
			body: JSON.stringify({ source_type: "url", url: "https://example.test/same", project: "/repo/a" }),
		});
		expect(first.status).toBe(201);
		const created = (await first.json()) as { id: string };

		const second = await app.request("/api/documents", {
			method: "POST",
			headers,
			body: JSON.stringify({ source_type: "url", url: "https://example.test/same", project: "/repo/a" }),
		});

		expect(second.status).toBe(200);
		expect(await second.json()).toMatchObject({ id: created.id, deduplicated: true });
	});

	it("lets scoped callers delete their own queued document before chunks exist", async () => {
		const app = await makeApp("team");
		const headers = {
			authorization: `Bearer ${teamToken({ agent: "agent-a", project: "/repo/a" })}`,
			"content-type": "application/json",
		};
		const create = await app.request("/api/documents", {
			method: "POST",
			headers,
			body: JSON.stringify({ source_type: "text", content: "queued doc", project: "/repo/a" }),
		});
		expect(create.status).toBe(201);
		const created = (await create.json()) as { id: string };

		const deleted = await app.request(`/api/documents/${created.id}?reason=cleanup`, {
			method: "DELETE",
			headers,
		});

		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toMatchObject({ deleted: true, memoriesRemoved: 0 });
		const row = getDbAccessor().withReadDb((db) => {
			return db
				.prepare(
					`SELECT d.status, j.status AS job_status,
					        (SELECT COUNT(*) FROM document_memories WHERE document_id = d.id) AS links
					 FROM documents d
					 LEFT JOIN memory_jobs j ON j.document_id = d.id AND j.job_type = 'document_ingest'
					 WHERE d.id = ?`,
				)
				.get(created.id) as { status: string; job_status: string; links: number };
		});
		expect(row).toMatchObject({ status: "deleted", job_status: "completed", links: 0 });
	});

	it("does not resurrect documents deleted while the worker is in flight", async () => {
		const app = await makeApp("team");
		const headers = { authorization: `Bearer ${teamToken({ agent: "agent-a", project: "/repo/a" })}` };
		const create = await app.request("/api/documents", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ source_type: "text", content: "delete me while embedding", project: "/repo/a" }),
		});
		expect(create.status).toBe(201);
		const created = (await create.json()) as { id: string };
		let deleted = false;

		await processPendingDocuments(async () => {
			if (!deleted) {
				deleted = true;
				const res = await app.request(`/api/documents/${created.id}?reason=worker-race`, {
					method: "DELETE",
					headers,
				});
				expect(res.status).toBe(200);
			}
			return null;
		});

		const row = getDbAccessor().withReadDb((db) => {
			return db
				.prepare(
					`SELECT d.status,
					        (SELECT COUNT(*) FROM document_memories WHERE document_id = d.id) AS links
					 FROM documents d
					 WHERE d.id = ?`,
				)
				.get(created.id) as { status: string; links: number };
		});
		expect(row).toMatchObject({ status: "deleted", links: 0 });
	});

	it("does not delete another agent's globally readable chunk", async () => {
		seedDocument(getDbAccessor(), {
			documentId: "doc-shared",
			memoryId: "mem-shared",
			agentId: "agent-b",
			project: "/repo/a",
		});
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
				 VALUES ('agent-a', 'agent-a', 'shared', NULL, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET read_policy = 'shared', updated_at = excluded.updated_at`,
			).run(now, now);
		});
		const app = await makeApp("team");
		const headers = { authorization: `Bearer ${teamToken({ agent: "agent-a", project: "/repo/a" })}` };

		const chunks = await app.request("/api/documents/doc-shared/chunks", { headers });
		expect(chunks.status).toBe(200);
		expect(await chunks.json()).toMatchObject({ count: 0, chunks: [] });

		const deleted = await app.request("/api/documents/doc-shared?reason=cleanup", { method: "DELETE", headers });

		expect(deleted.status).toBe(404);
		const row = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT is_deleted FROM memories WHERE id = 'mem-shared'").get() as { is_deleted: number },
		);
		expect(row.is_deleted).toBe(0);
	});

	it("links duplicate chunks within the same agent and project instead of failing ingest", async () => {
		const app = await makeApp("team");
		const headers = { authorization: `Bearer ${teamToken({ agent: "agent-a", project: "/repo/a" })}` };
		const documentIds: string[] = [];
		for (const title of ["first", "second"]) {
			const create = await app.request("/api/documents", {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({ source_type: "text", title, content: "same scoped content", project: "/repo/a" }),
			});
			expect(create.status).toBe(201);
			documentIds.push(((await create.json()) as { id: string }).id);
			await processPendingDocuments();
		}

		const row = getDbAccessor().withReadDb((db) => {
			return db
				.prepare(
					`SELECT
						(SELECT COUNT(*) FROM documents WHERE status = 'done') AS done_count,
						(SELECT COUNT(*) FROM memories WHERE content = 'same scoped content' AND is_deleted = 0) AS memory_count,
						(SELECT COUNT(*) FROM document_memories) AS link_count`,
				)
				.get() as { done_count: number; memory_count: number; link_count: number };
		});
		expect(row).toEqual({ done_count: 2, memory_count: 1, link_count: 2 });

		const deleted = await app.request(`/api/documents/${documentIds[0]}?reason=cleanup`, { method: "DELETE", headers });
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toMatchObject({ deleted: true, memoriesRemoved: 0 });
		const deletedChunks = await app.request(`/api/documents/${documentIds[0]}/chunks`, { headers });
		expect(deletedChunks.status).toBe(200);
		expect(await deletedChunks.json()).toMatchObject({ count: 0, chunks: [] });
		const chunks = await app.request(`/api/documents/${documentIds[1]}/chunks`, { headers });
		expect(chunks.status).toBe(200);
		expect(await chunks.json()).toMatchObject({ count: 1 });
	});

	it("scopes created document chunks and deletion to the authenticated agent and project", async () => {
		seedDocument(getDbAccessor(), {
			documentId: "doc-other",
			memoryId: "mem-other",
			agentId: "agent-b",
			project: "/repo/b",
		});
		const app = await makeApp("team");
		const headers = { authorization: `Bearer ${teamToken({ agent: "agent-a", project: "/repo/a" })}` };
		const create = await app.request("/api/documents", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({
				source_type: "text",
				content: "Scoped document content that becomes one chunk.",
				project: "/repo/a",
			}),
		});
		expect(create.status).toBe(201);
		const created = (await create.json()) as { id: string };
		await processPendingDocuments();
		const scopeRow = getDbAccessor().withReadDb((db) => {
			return db
				.prepare(
					`SELECT d.agent_id AS document_agent_id, d.project AS document_project,
					        m.agent_id AS memory_agent_id, m.project AS memory_project
					 FROM documents d
					 JOIN document_memories dm ON dm.document_id = d.id
					 JOIN memories m ON m.id = dm.memory_id
					 WHERE d.id = ?`,
				)
				.get(created.id) as {
				document_agent_id: string;
				document_project: string;
				memory_agent_id: string;
				memory_project: string;
			};
		});
		expect(scopeRow).toMatchObject({
			document_agent_id: "agent-a",
			document_project: "/repo/a",
			memory_agent_id: "agent-a",
			memory_project: "/repo/a",
		});

		const chunks = await app.request(`/api/documents/${created.id}/chunks`, { headers });
		expect(chunks.status).toBe(200);
		expect(await chunks.json()).toMatchObject({ count: 1 });

		const forbiddenChunks = await app.request("/api/documents/doc-other/chunks", { headers });
		expect(forbiddenChunks.status).toBe(200);
		expect(await forbiddenChunks.json()).toMatchObject({ count: 0 });

		const forbiddenDelete = await app.request("/api/documents/doc-other?reason=cleanup", {
			method: "DELETE",
			headers,
		});
		expect(forbiddenDelete.status).toBe(404);

		const allowedDelete = await app.request(`/api/documents/${created.id}?reason=cleanup`, {
			method: "DELETE",
			headers,
		});
		expect(allowedDelete.status).toBe(200);
		expect(await allowedDelete.json()).toMatchObject({ deleted: true, memoriesRemoved: 1 });
	});
});
