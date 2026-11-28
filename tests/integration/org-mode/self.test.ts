import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createToken } from "../../../platform/daemon/src/auth/tokens";
import { OrgDaemon } from "./daemon";
import { captureThread } from "./fixture";
import { percentile, summarize } from "../../../evals/org-load/run";
import { deriveClaim } from "./graph";
import { request, success, record, text } from "./http";
import { assertUnchanged, normalize, normalizeMcp, snapshot } from "./noninterference";

test("isolated team daemon boots, restarts with durable agents, and reaps its DB owner", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const secret = await readFile(join(daemon.workspace, "runtime/auth-secret"));
		const admin = { bearer: createToken(secret, { sub: "org-harness", role: "admin", scope: {} }, 600) };
		const registeredWorker = async () => {
			await daemon.waitForDreamingRegistration();
			const status = success(await request(daemon.origin, "/api/dream/status", admin), "Dreaming after registration");
			expect(record(status.worker).running).toBe(true);
		};
		await registeredWorker();
		for (const name of ["alice-base", "carol-base"])
			success(
				await request(daemon.origin, "/api/agents", admin, "POST", { name }),
				"POST /api/agents baseline fixture",
			);
		const alice = {
			bearer: createToken(secret, { sub: "alice-base", role: "agent", scope: { agent: "alice-base" } }, 600),
		};
		const carol = {
			bearer: createToken(secret, { sub: "carol-base", role: "agent", scope: { agent: "carol-base" } }, 600),
		};
		const read = async () =>
			snapshot(
				daemon.origin,
				[{ name: "lists", path: "/api/memories?agent_id=alice-base", positive: "content" }],
				alice,
			);
		const before = await read();
		const hidden = success(
			await request(daemon.origin, "/api/memory/remember", carol, "POST", {
				content: "quokka hidden control",
				agentId: "carol-base",
				visibility: "private",
				type: "fact",
			}),
			"POST /api/memory/remember hidden baseline",
		);
		expect(JSON.stringify(hidden)).toContain("id");
		assertUnchanged(before, await read(), "base agent isolation");
		const own = await request(daemon.origin, "/api/memories?agent_id=carol-base", carol);
		expect(own.status).toBe(200);
		expect(JSON.stringify(own.body)).toContain("quokka hidden control");
		success(
			await request(daemon.origin, "/api/memory/remember", alice, "POST", {
				content: "quokka visible mutation",
				agentId: "alice-base",
				type: "fact",
			}),
			"POST /api/memory/remember visible baseline",
		);
		const evidence = success(
			await request(daemon.origin, "/api/memory/remember", alice, "POST", {
				content: "Atlas baseline graph quokka is durable.",
				agentId: "alice-base",
				type: "fact",
			}),
			"POST /api/memory/remember graph source",
		);
		const sourceId = typeof evidence.id === "string" ? evidence.id : text(record(evidence.memory).id);
		const claim = await deriveClaim(
			{ daemon, admin },
			"alice-base",
			sourceId,
			"Atlas baseline graph quokka is durable.",
			"Baseline graph quokka",
		);
		const derived = await request(daemon.origin, `/api/memory/${claim.memoryId}?agent_id=alice-base`, alice);
		expect(derived.status).toBe(200);
		expect(JSON.stringify(derived.body)).toContain("Atlas baseline graph quokka is durable.");
		const foreignQuote = "Atlas baseline foreign citation quokka belongs to Alice.";
		const foreignEvidence = success(
			await request(daemon.origin, "/api/memory/remember", alice, "POST", {
				content: foreignQuote,
				agentId: "alice-base",
				type: "fact",
			}),
			"Create independently owned foreign-citation evidence",
		);
		const foreignId =
			typeof foreignEvidence.id === "string" ? foreignEvidence.id : text(record(foreignEvidence.memory).id);
		const foreignBefore = success(
			await request(daemon.origin, "/api/knowledge/entities?agent_id=carol-base", admin),
			"Foreign target graph is readable",
		);
		const foreignInput = {
			agentId: "carol-base",
			input: {
				agentId: "carol-base",
				operations: [
					{
						operation: "create_entity",
						payload: { name: "forbidden-cross-agent-base", type: "project" },
						evidence: [{ source_ref: `memory:${foreignId}`, quote: foreignQuote }],
					},
				],
			},
		};
		const foreign = await request(daemon.origin, "/api/dream/tools/apply_ontology_ops", admin, "POST", foreignInput);
		expect(foreign.status).toBe(400);
		success(
			await request(daemon.origin, `/api/memory/${foreignId}?agent_id=alice-base`, alice, "DELETE", {
				reason: "Verify absent-identical foreign-citation refusal",
			}),
			"Source owner deletes its foreign citation control",
		);
		expect((await request(daemon.origin, `/api/memory/${foreignId}?agent_id=alice-base`, alice)).status).toBe(404);
		const absent = await request(daemon.origin, "/api/dream/tools/apply_ontology_ops", admin, "POST", foreignInput);
		expect(absent.status).toBe(400);
		expect(foreign.body).toEqual(absent.body);
		assertUnchanged(
			foreignBefore,
			success(
				await request(daemon.origin, "/api/knowledge/entities?agent_id=carol-base", admin),
				"Rejected citation target graph remains readable",
			),
			"native foreign citation leaves no graph rows",
		);
		const changed = await read();
		expect(() => assertUnchanged(before, changed, "real visible mutation")).toThrow();
		const hooks = [
			{
				name: "session-start injection",
				path: "/api/hooks/session-start",
				method: "POST" as const,
				body: { harness: "codex", sessionKey: "__PROBE__", agentId: "alice-base", project: "atlas" },
				positive: "content" as const,
			},
			{
				name: "prompt-submit injection",
				path: "/api/hooks/user-prompt-submit",
				method: "POST" as const,
				body: {
					harness: "codex",
					sessionKey: "__PROBE__",
					agentId: "alice-base",
					project: "atlas",
					userMessage: "quokka baseline",
				},
				positive: "content" as const,
			},
		];
		const firstHook = await snapshot(daemon.origin, hooks, alice);
		assertUnchanged(firstHook, await snapshot(daemon.origin, hooks, alice), "fresh equivalent hook contexts");
		await captureThread(
			daemon,
			{ agentId: "carol-base", connector: carol, session: carol },
			"base-fixture-transcript",
			"quokka baseline transcript was captured through hooks.",
		);
		const previousPid = daemon.child?.pid;
		await daemon.restart();
		await registeredWorker();
		expect(daemon.lastStoppedPids.length).toBeGreaterThanOrEqual(2);
		expect(daemon.child?.pid).not.toBe(previousPid);
		assertUnchanged(changed, await read(), "restart preserves evidence");
		const health = record((await request(daemon.origin, "/health")).body);
		expect(text(health.agentsDir)).toBe(daemon.workspace);
	} finally {
		await daemon.dispose();
	}
}, 120_000);

test("normalization preserves security-significant metadata and strips only probe volatility", () => {
	const response = {
		id: "mem-1",
		scores: [0.9, 0.4],
		count: 2,
		hasMore: true,
		cursor: "next",
		createdAt: "2026-01-01",
		requestId: "request-a",
		durationMs: 1,
	};
	const mcp = (payload: object) => ({ result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
	assertUnchanged(
		normalizeMcp(mcp(response)),
		normalizeMcp(mcp({ ...response, requestId: "request-b", durationMs: 900 })),
		"embedded MCP request volatility",
	);
	expect(() =>
		assertUnchanged(
			normalizeMcp(mcp(response)),
			normalizeMcp(mcp({ ...response, count: 3 })),
			"embedded MCP count mutation",
		),
	).toThrow();
	const stable = normalize(response);
	assertUnchanged(stable, normalize({ ...response, requestId: "request-b", durationMs: 900 }), "request volatility");
	for (const change of [
		{ count: 3 },
		{ hasMore: false },
		{ cursor: "other" },
		{ scores: [0.4, 0.9] },
		{ id: "mem-2" },
		{ createdAt: "2026-01-02" },
	]) {
		expect(() => assertUnchanged(stable, normalize({ ...response, ...change }), "metadata mutation")).toThrow();
	}
});

test("load report uses nearest-rank percentiles and retains failed requests", () => {
	const report = summarize([
		{ ms: 100, status: 503, error: "http_503" },
		{ ms: 1, status: 200, error: null },
		{ ms: 5, status: 200, error: null },
		{ ms: 10, status: 0, error: "TimeoutError" },
	]);
	expect(report).toEqual({
		requests: 4,
		errors: 2,
		errorCounts: { http_503: 1, TimeoutError: 1 },
		p50Ms: 5,
		p95Ms: 100,
		p99Ms: 100,
	});
	expect(percentile([], 0.5)).toBeNull();
});
