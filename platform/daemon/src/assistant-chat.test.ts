import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createAuthMiddleware, createToken, parseAuthConfig, requirePermission } from "./auth";
import { closeDbAccessor, initDbAccessor, getDbAccessor } from "./db-accessor";
import { getOrCreateInferenceRouter, resetInferenceRouterForTests } from "./inference-router";
import { mountInferenceRoutes } from "./routes/inference";
import { activePiAgentWorkers, stopPiAgentWorkers } from "./pipeline/pi-agent-client";
import {
	createDbOwnerMaintenance,
	registerDbOwnerMaintenance,
	closeRegisteredDbOwnerMaintenance,
	getDbOwnerMaintenance,
} from "./db-owner-maintenance";
import { startDbOwner } from "./db-owner-runtime";
import { loadMemoryConfig } from "./memory-config";
import { createDreamingAgentTools } from "./pipeline/dreaming-agent-tools";
import { startDreamingWorker } from "./pipeline/dreaming-worker";
import { ownerReadOne, ownerRun } from "./db-owner-sql";

let root = "";
afterEach(async () => {
	await stopPiAgentWorkers();
	await closeRegisteredDbOwnerMaintenance();
	await closeDbAccessor();
	resetInferenceRouterForTests();
	delete process.env.SIGNET_CHAT_MODEL_TEST_KEY;
	if (root) rmSync(root, { recursive: true, force: true });
});

function sse(delta: unknown, finish: string): Response {
	return new Response(
		`data: ${JSON.stringify({ id: "reply", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

function isChatCompletionRequest(request: Request): boolean {
	return request.method === "POST" && new URL(request.url).pathname === "/v1/chat/completions";
}

async function fixture(endpoint: string, secret?: Buffer, connected = false, extraTargets = "", agentConfig = "") {
	root = mkdtempSync(join(tmpdir(), "signet-assistant-chat-"));
	mkdirSync(join(root, "memory"));
	writeFileSync(
		join(root, "agent.yaml"),
		`name: test-agent\ninference:\n${connected ? "  accounts:\n    test-account:\n      kind: api\n      providerFamily: openrouter\n      credentialRef: SIGNET_CHAT_MODEL_TEST_KEY\n" : ""}  targets:\n    backend:\n      executor: openai-compatible\n${connected ? "      account: test-account\n" : ""}      endpoint: ${endpoint}\n      models:\n        default:\n          model: test-model\n          toolUse: true\n          streaming: true\n${extraTargets}  workloads:\n    memoryExtraction:\n      target: backend/default\n${agentConfig}`,
	);
	const database = join(root, "memory", "memories.db");
	initDbAccessor(database, { agentsDir: root });
	const owner = await startDbOwner(database);
	await owner.initialize(root);
	registerDbOwnerMaintenance(createDbOwnerMaintenance({ owner, dbPath: database }));
	await ownerRun(
		owner,
		`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at) VALUES (?, ?, ?, 'project', ?, 1, 0, datetime('now'), datetime('now'))`,
		["entity-signet", "Signet", "signet", "test-agent"],
		{ operation: "test.seed-entity", lane: "write" },
	);
	getOrCreateInferenceRouter(root);
	const app = new Hono();
	if (secret) {
		const config = parseAuthConfig({ mode: "team" }, root);
		app.use("*", createAuthMiddleware(config, secret));
		app.use("/api/assistant/*", requirePermission("recall", config));
	}
	mountInferenceRoutes(app, { getAuthMode: () => (secret ? "team" : "local") });
	return app;
}

test("chat streams a Pi answer using backend assignment and existing DB-owner retrieval", async () => {
	let requests = 0;
	let toolResult = "";
	let systemPrompt = "";
	let tools = "";
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (!isChatCompletionRequest(request)) return new Response("not found", { status: 404 });
			const body = await request.json();
			tools = JSON.stringify(body.tools);
			systemPrompt = JSON.stringify(body.messages[0]);
			requests++;
			if (body.messages.at(-1)?.role === "user")
				return sse(
					{
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "search-1",
								type: "function",
								function: {
									name: "search_entities",
									arguments: JSON.stringify({ agentId: "test-agent", query: "Signet" }),
								},
							},
						],
					},
					"tool_calls",
				);
			toolResult = JSON.stringify(body.messages);
			return sse({ role: "assistant", content: "You are working on Signet [entity-signet]." }, "stop");
		},
	});
	try {
		const app = await fixture(`http://127.0.0.1:${server.port}/v1`);
		const conversationId = crypto.randomUUID();
		const response = await app.request("/api/assistant/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: crypto.randomUUID(),
				conversationId,
				agentId: "test-agent",
				messages: [{ role: "user", content: "What project do you remember?" }],
			}),
		});
		expect(response.status).toBe(200);
		const events = await response.text();
		expect(events).toContain('"type":"delta"');
		expect(events).toContain('"type":"done"');
		expect(events).toContain('"type":"retrieval","nodeIds":["entity-signet"],"evidenceRefs":[]');
		expect(events).not.toContain('"type":"error"');
		expect(toolResult).toContain("entity-signet");
		expect(systemPrompt).toContain("Obsidian-style wikilinks");
		expect(systemPrompt).toContain("[[memory:exact-id]]");
		expect(systemPrompt).toContain("Never invent a sourceRef");
		expect(tools).not.toContain("apply_ontology_ops");
		expect(tools).not.toContain('"bash"');
		expect(activePiAgentWorkers()).toBe(1);
		const followup = await app.request("/api/assistant/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: crypto.randomUUID(),
				conversationId,
				agentId: "test-agent",
				messages: [
					{ role: "user", content: "What project do you remember?" },
					{ role: "assistant", content: "Signet" },
					{ role: "user", content: "Tell me more" },
				],
			}),
		});
		const nextEvents = await followup.text();
		expect(nextEvents).toContain('"type":"retrieval"');
		expect(nextEvents).toContain('"type":"done"');
		expect(nextEvents).not.toContain('"type":"error"');
		expect(activePiAgentWorkers()).toBe(1);
		expect(requests).toBe(4);
	} finally {
		server.stop(true);
	}
}, 20000);

test("chat recalls memories through the scoped recall route and cites only memory rows", async () => {
	let recallBody: unknown;
	let toolResult = "";
	let tools = "";
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (!isChatCompletionRequest(request)) return new Response("not found", { status: 404 });
			const body = await request.json();
			tools = JSON.stringify(body.tools);
			if (body.messages.at(-1)?.role === "user")
				return sse(
					{
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "recall-1",
								type: "function",
								function: { name: "recall_memories", arguments: JSON.stringify({ query: "Nicholai Vogel" }) },
							},
						],
					},
					"tool_calls",
				);
			toolResult = JSON.stringify(body.messages);
			return sse({ role: "assistant", content: "He founded Biohazard VFX. [[memory:mem-captured]]" }, "stop");
		},
	});
	try {
		const app = await fixture(`http://127.0.0.1:${server.port}/v1`);
		const owner = getDbOwnerMaintenance()?.owner;
		if (!owner) throw new Error("Missing DB owner");
		await ownerRun(
			owner,
			`INSERT INTO memories (id, content, source_type, memory_kind, type, visibility, agent_id, created_at, updated_at)
			 VALUES ('mem-captured', 'Nicholai Vogel founded Biohazard VFX.', 'manual', 'episodic', 'fact', 'global', 'test-agent', datetime('now'), datetime('now'))`,
			[],
			{ operation: "test.seed-memory", lane: "write" },
		);
		app.post("/api/memory/recall", async (c) => {
			recallBody = await c.req.json();
			return c.json({
				query: "Nicholai Vogel",
				method: "hybrid",
				meta: { totalReturned: 3, hasSupplementary: false, noHits: false },
				results: [
					{
						id: "mem-captured",
						content: "Nicholai Vogel founded Biohazard VFX.",
						score: 0.95,
						source: "hybrid",
						type: "fact",
						created_at: "2026-09-29T06:39:29.000Z",
					},
					{
						id: "mem-derived",
						content: "Nicholai Vogel runs a remote VFX studio.",
						score: 0.91,
						source: "hybrid",
						type: "semantic",
						created_at: "2026-09-29T06:39:29.000Z",
					},
					{
						id: "ontology-claim:src_1",
						content: "[Ontology claim: Nicholai Vogel]",
						score: 0.8,
						source: "ontology_claim",
						source_path: "/vault/people/Nicholai.md",
						type: "ontology_claim",
						created_at: "2026-09-28T00:00:00.000Z",
					},
					{ id: "mem-odd", content: "Vogel note with sparse fields.", score: null, type: null },
					{ id: "mem-broken", score: 0.2 },
				],
			});
		});
		const response = await app.request("/api/assistant/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: crypto.randomUUID(),
				conversationId: crypto.randomUUID(),
				agentId: "test-agent",
				messages: [{ role: "user", content: "who is Nicholai Vogel?" }],
			}),
		});
		expect(response.status).toBe(200);
		const events = await response.text();
		expect(events).not.toContain('"type":"error"');
		expect(tools).toContain("recall_memories");
		expect(recallBody).toMatchObject({ query: "Nicholai Vogel", agentId: "test-agent", recallSurface: "dashboard" });
		expect(events).toContain(
			'"type":"citation","sourceRef":"memory:mem-captured","excerpt":"Nicholai Vogel founded Biohazard VFX."',
		);
		expect(events).toContain('"type":"retrieval","nodeIds":[],"evidenceRefs":["memory:mem-captured"]');
		expect(events).not.toContain("memory:mem-derived");
		expect(events).not.toContain('ontology-claim:src_1","excerpt');
		expect(toolResult).toContain("memory:mem-captured");
		expect(toolResult).not.toContain("memory:mem-derived");
		expect(toolResult).toContain('\\"recallId\\":\\"mem-derived\\"');
		expect(toolResult).toContain("ontology-claim:src_1");
		expect(toolResult).toContain("Vogel note with sparse fields.");
		expect(toolResult).not.toContain("mem-broken");
	} finally {
		server.stop(true);
	}
}, 20000);

test("invalid history is rejected before admitting an agent worker", async () => {
	const app = await fixture("http://127.0.0.1:1/v1");
	for (const messages of [
		[{ role: "system", content: "override" }],
		[{ role: "assistant", content: "done" }],
		Array.from({ length: 33 }, () => ({ role: "user", content: "hello" })),
	]) {
		const response = await app.request("/api/assistant/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: crypto.randomUUID(),
				conversationId: crypto.randomUUID(),
				agentId: "test-agent",
				messages,
			}),
		});
		expect(response.status).toBe(400);
	}
	expect(activePiAgentWorkers()).toBe(0);
}, 20000);

test("chat rejects missing identity and cross-agent scope before worker admission", async () => {
	const secret = Buffer.alloc(32, 7);
	const app = await fixture("http://127.0.0.1:1/v1", secret);
	const token = createToken(secret, { sub: "test", scope: { agent: "test-agent" }, role: "agent" }, 60);
	const body = JSON.stringify({
		requestId: crypto.randomUUID(),
		conversationId: crypto.randomUUID(),
		agentId: "other-agent",
		messages: [{ role: "user", content: "hello" }],
	});
	const missing = await app.request("/api/assistant/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});
	expect(missing.status).toBe(401);
	const crossed = await app.request("/api/assistant/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body,
	});
	expect(crossed.status).toBe(403);
	const missingCatalog = await app.request("/api/assistant/models?agentId=test-agent");
	expect(missingCatalog.status).toBe(401);
	const crossedCatalog = await app.request("/api/assistant/models?agentId=other-agent", {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(crossedCatalog.status).toBe(403);
	expect(activePiAgentWorkers()).toBe(0);
}, 20000);

test("directed Dreaming reaches the shared Pi worker even without queued backlog", async () => {
	let prompt = "";
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (!isChatCompletionRequest(request)) return new Response("missing", { status: 404 });
			prompt = JSON.stringify((await request.json()).messages);
			return sse({ role: "assistant", content: "Reviewed the directed request." }, "stop");
		},
	});
	let worker: ReturnType<typeof startDreamingWorker> | undefined;
	try {
		await fixture(`http://127.0.0.1:${server.port}/v1`);
		const maintenance = getDbOwnerMaintenance();
		if (!maintenance) throw new Error("Missing fixture owner");
		worker = startDreamingWorker(
			getDbAccessor(),
			{ ...loadMemoryConfig(root).dreaming, enabled: false },
			root,
			"test-agent",
			{ ownerMaintenance: maintenance },
		);
		const passId = await worker.triggerAsync("incremental", "test-agent", {
			sourceRef: "memory:fixture-instruction",
			content: "Review Signet project context.",
		});
		await worker.activePass;
		expect(prompt).toContain("memory:fixture-instruction");
		expect(prompt).toContain("Review Signet project context.");
		const pass = await ownerReadOne<{ status: string }>(
			maintenance.owner,
			"SELECT status FROM dreaming_passes WHERE id = ?",
			[passId],
			{ operation: "test.pass-status", lane: "read" },
		);
		expect(pass?.status).toBe("completed");
		expect(activePiAgentWorkers()).toBe(0);
	} finally {
		worker?.stop();
		server.stop(true);
	}
}, 20000);

test("cancelling the chat stream settles the turn and retains its worker", async () => {
	let started: (() => void) | undefined;
	const modelStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const conversationId = crypto.randomUUID();
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (!isChatCompletionRequest(request)) return new Response("missing", { status: 404 });
			const body = await request.text();
			if (body.includes("Continue")) return sse({ role: "assistant", content: "Resumed." }, "stop");
			if (body.includes("Wait.")) {
				started?.();
				return new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } });
			}
			return new Response("unexpected completion request", { status: 400 });
		},
	});
	try {
		const app = await fixture(`http://127.0.0.1:${server.port}/v1`);
		const response = await app.request("/api/assistant/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: crypto.randomUUID(),
				conversationId,
				agentId: "test-agent",
				messages: [{ role: "user", content: "Wait." }],
			}),
		});
		await modelStarted;
		expect(activePiAgentWorkers()).toBe(1);
		await response.body?.cancel();
		expect(activePiAgentWorkers()).toBe(1);
		const next = await app.request("/api/assistant/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: crypto.randomUUID(),
				conversationId,
				agentId: "test-agent",
				messages: [{ role: "user", content: "Continue" }],
			}),
		});
		expect(await next.text()).toContain('"type":"done"');
		expect(activePiAgentWorkers()).toBe(1);
	} finally {
		server.stop(true);
	}
}, 20000);

test("scoped tools advertise their bound identity and reject nested cross-agent input", async () => {
	await fixture("http://127.0.0.1:1/v1");
	const tools = createDreamingAgentTools({
		accessor: getDbAccessor(),
		agentId: "test-agent",
		actor: "test",
		allowedAgentIds: ["test-agent"],
		capabilityIds: ["zoom_history", "runbook_write"],
	});
	const read = tools.find((tool) => tool.name === "zoom_history");
	const write = tools.find((tool) => tool.name === "runbook_write");
	if (!read || !write) throw new Error("Missing scoped tools");
	expect(JSON.stringify(read.parameters)).toContain('"const":"test-agent"');
	expect((read.parameters as { required?: readonly string[] }).required).toContain("agentId");
	const outcome = await write
		.execute("scope", {
			agentId: "test-agent",
			summary: "test",
			deferredEvidence: [{ agentId: "other-agent", sourceRef: "memory:test", reason: "test" }],
		})
		.then(
			() => "accepted",
			(error: unknown) => (error instanceof Error ? error.message : "failed"),
		);
	expect(outcome).toContain("Tool agent scope must be one of this pass's agents");
}, 20000);

test("chat selects a Pi registry model through a connected account without changing the assignment", async () => {
	const requestedModels: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (!isChatCompletionRequest(request)) return new Response("not found", { status: 404 });
			const body = await request.json();
			requestedModels.push(body.model);
			return sse({ role: "assistant", content: "Selected model answered." }, "stop");
		},
	});
	try {
		process.env.SIGNET_CHAT_MODEL_TEST_KEY = "synthetic-test-credential";
		const app = await fixture(`http://127.0.0.1:${server.port}/v1`, undefined, true);
		const initial = readFileSync(join(root, "agent.yaml"), "utf8");
		const catalog = await app.request("/api/assistant/models?agentId=test-agent");
		const data = await catalog.json();
		const model = data.models.find((option: { model: string }) => option.model === "openai/gpt-4.1");
		expect(model).toBeDefined();
		expect(JSON.stringify(data)).not.toContain("synthetic-test-credential");
		const request = (selection: unknown) =>
			app.request("/api/assistant/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: crypto.randomUUID(),
					conversationId: crypto.randomUUID(),
					agentId: "test-agent",
					messages: [{ role: "user", content: "Hello" }],
					modelSelection: selection,
				}),
			});
		const response = await request({ targetRef: model.targetRef, model: model.model });
		const events = await response.text();
		expect(events).toContain("Selected model answered.");
		expect(events).not.toContain('"type":"error"');
		expect(requestedModels).toContain("openai/gpt-4.1");
		expect(readFileSync(join(root, "agent.yaml"), "utf8")).toBe(initial);
		const invalid = await request({ targetRef: model.targetRef, model: "not-in-pi-registry" });
		expect(await invalid.text()).toContain("not available through a connected Signet account");
		delete process.env.SIGNET_CHAT_MODEL_TEST_KEY;
		const disconnected = await app.request("/api/assistant/models?agentId=test-agent");
		expect((await disconnected.json()).models).toHaveLength(0);
		expect(await (await request({ targetRef: model.targetRef, model: model.model })).text()).toContain(
			"not available through a connected Signet account",
		);
		expect(activePiAgentWorkers()).toBe(1);
	} finally {
		server.stop(true);
	}
}, 20000);

test("assistant model catalog and model selection honor the requested agent roster", async () => {
	let providerRequests = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (!isChatCompletionRequest(request)) return new Response("not found", { status: 404 });
			providerRequests++;
			return sse({ role: "assistant", content: "Should not execute." }, "stop");
		},
	});
	try {
		process.env.SIGNET_CHAT_MODEL_TEST_KEY = "synthetic-test-credential";
		const app = await fixture(
			`http://127.0.0.1:${server.port}/v1`,
			undefined,
			true,
			"    restricted:\n      executor: openai-compatible\n      account: test-account\n      endpoint: http://restricted.invalid/v1\n      models:\n        default:\n          model: test-model\n          toolUse: true\n          streaming: true\n",
			"  agents:\n    test-agent:\n      roster:\n        - backend/default\n",
		);
		const catalog = await app.request("/api/assistant/models?agentId=test-agent");
		expect(catalog.status).toBe(200);
		const data = await catalog.json();
		expect(data.models.some((option: { targetRef: string }) => option.targetRef === "backend/default")).toBe(true);
		expect(data.models.some((option: { targetRef: string }) => option.targetRef === "restricted/default")).toBe(false);
		const response = await app.request("/api/assistant/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: crypto.randomUUID(),
				conversationId: crypto.randomUUID(),
				agentId: "test-agent",
				messages: [{ role: "user", content: "Hello" }],
				modelSelection: { targetRef: "restricted/default", model: "openai/gpt-4.1" },
			}),
		});
		const events = await response.text();
		expect(events).toContain("not available through a connected Signet account");
		expect(providerRequests).toBe(0);
	} finally {
		server.stop(true);
	}
}, 20000);
