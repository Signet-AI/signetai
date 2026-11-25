import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import * as Type from "typebox";
import { createWorkerAgentSession, stopPiAgentWorkers } from "./pi-agent-client";
import { piAgentWorkerSettings } from "./pi-agent-protocol";
import type { PiAgentTool } from "./pi-agent-protocol";
import { resolvePiModel } from "./pi-provider";

const { piModel } = resolvePiModel({
	executor: "openai-compatible",
	model: "test-model",
	baseUrl: "http://127.0.0.1:1/v1",
});
const modelUpdate = { model: piModel, apiKey: "test-key", systemPrompt: "x", tools: [] };

const settleWithin = async (pending: Promise<unknown> | undefined, ms: number): Promise<"settled" | "pending"> => {
	if (!pending) return "settled";
	let settled = false;
	void pending.then(
		() => (settled = true),
		() => (settled = true),
	);
	await new Promise((resolve) => setTimeout(resolve, ms));
	return settled ? "settled" : "pending";
};

const outcome = async (pending: Promise<unknown> | undefined): Promise<string> => {
	if (!pending) return "resolved";
	try {
		await pending;
		return "resolved";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
};

afterEach(async () => {
	await stopPiAgentWorkers();
});

test("dispose resolves promptly after the worker has already exited", async () => {
	const session = await createWorkerAgentSession(
		{ model: piModel, apiKey: "test-key", systemPrompt: "x", tools: [] },
		[],
		undefined,
		{ workerPath: join(import.meta.dir, "pi-agent-fake-die.mjs") },
	);
	expect(await outcome(session.cancelTurn?.())).toMatch(/exited/);
	const start = Date.now();
	await session.dispose();
	expect(Date.now() - start).toBeLessThan(500);
}, 20_000);

test("cancel ignores stale and id-less aborted acks until its matching id arrives", async () => {
	const session = await createWorkerAgentSession(
		{ model: piModel, apiKey: "test-key", systemPrompt: "x", tools: [] },
		[],
		undefined,
		{ workerPath: join(import.meta.dir, "pi-agent-fake-acks.mjs") },
	);
	let delivered = () => {};
	const barrier = new Promise<void>((resolve) => {
		delivered = resolve;
	});
	session.subscribe((event) => {
		if (event.type === "agent_start") delivered();
	});
	const cancelling = session.cancelTurn?.();
	await barrier;
	expect(await settleWithin(cancelling, 50)).toBe("pending");
	await session.updateModel?.(modelUpdate);
	expect(await outcome(cancelling)).toBe("resolved");
	await session.dispose();
}, 20_000);

test("a second turn's cancel is not satisfied by the first turn's stale ack", async () => {
	const session = await createWorkerAgentSession(
		{ model: piModel, apiKey: "test-key", systemPrompt: "x", tools: [] },
		[],
		undefined,
		{ workerPath: join(import.meta.dir, "pi-agent-fake-stale.mjs") },
	);
	expect(await outcome(session.cancelTurn?.())).toBe("resolved");
	let delivered = () => {};
	const barrier = new Promise<void>((resolve) => {
		delivered = resolve;
	});
	session.subscribe((event) => {
		if (event.type === "agent_start") delivered();
	});
	const cancelling = session.cancelTurn?.();
	await barrier;
	expect(await settleWithin(cancelling, 50)).toBe("pending");
	await session.updateModel?.(modelUpdate);
	expect(await outcome(cancelling)).toBe("resolved");
	await session.dispose();
}, 20_000);

test("dispose does not accept a numbered cancel ack as its disposal ack", async () => {
	const session = await createWorkerAgentSession(
		{ model: piModel, apiKey: "test-key", systemPrompt: "x", tools: [] },
		[],
		undefined,
		{ workerPath: join(import.meta.dir, "pi-agent-fake-dispose-ack.mjs") },
	);
	const start = Date.now();
	await session.dispose();
	expect(Date.now() - start).toBeGreaterThanOrEqual(200);
}, 20_000);

test("a new turn's cancel does not join a previous turn's pending cancel", async () => {
	const session = await createWorkerAgentSession(
		{ model: piModel, apiKey: "test-key", systemPrompt: "x", tools: [] },
		[],
		undefined,
		{ workerPath: join(import.meta.dir, "pi-agent-fake-two-turns.mjs") },
	);
	const first = session.cancelTurn?.();
	await session.prompt?.("next turn");
	expect(await settleWithin(session.cancelTurn?.(), 2000)).toBe("settled");
	const firstOutcome = outcome(first);
	await session.dispose();
	expect(await firstOutcome).toMatch(/closed|exited/);
}, 20_000);

test("every concurrent cancel caller waits for in-flight host tool calls", async () => {
	let releaseTool = () => {};
	const toolGate = new Promise<void>((resolve) => {
		releaseTool = resolve;
	});
	let toolDone = false;
	const tools: PiAgentTool[] = [
		{
			name: "slow_tool",
			label: "Slow",
			description: "Slow tool",
			parameters: Type.Object({}),
			async execute() {
				await toolGate;
				toolDone = true;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		},
	];
	const session = await createWorkerAgentSession(
		{ model: piModel, apiKey: "test-key", systemPrompt: "x", tools },
		tools,
		undefined,
		{ workerPath: join(import.meta.dir, "pi-agent-fake-tool-cancel.mjs") },
	);
	const first = session.cancelTurn?.();
	const second = session.cancelTurn?.();
	try {
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await settleWithin(second, 50)).toBe("pending");
	} finally {
		releaseTool();
	}
	expect(await outcome(first)).toBe("resolved");
	expect(await outcome(second)).toBe("resolved");
	expect(toolDone).toBe(true);
	await session.dispose();
}, 20_000);

test("cancelTurn reports the closed worker instead of leaving an abandoned cancel", async () => {
	const session = await createWorkerAgentSession(
		{ model: piModel, apiKey: "test-key", systemPrompt: "x", tools: [] },
		[],
		undefined,
		{ workerPath: join(import.meta.dir, "pi-agent-fake-die.mjs") },
	);
	expect(await outcome(session.cancelTurn?.())).toMatch(/exited/);
	const start = Date.now();
	expect(await outcome(session.cancelTurn?.())).toMatch(/closed/);
	expect(await outcome(session.cancelTurn?.())).toMatch(/closed/);
	expect(Date.now() - start).toBeLessThan(3000);
	await session.dispose();
}, 20_000);

test("piAgentWorkerSettings carries cacheWarming, retry passthrough, and omits absent retry", () => {
	expect(piAgentWorkerSettings({ model: piModel, apiKey: "test-key", systemPrompt: "", tools: [] })).toEqual({
		cacheWarming: "streaming",
	});
	expect(
		piAgentWorkerSettings({
			model: piModel,
			apiKey: "test-key",
			systemPrompt: "",
			tools: [],
			retry: { maxRetries: 8, baseDelayMs: 2000, maxAgentDelayMs: 60_000 },
		}),
	).toEqual({
		retry: { enabled: true, maxRetries: 8, baseDelayMs: 2000, maxAgentDelayMs: 60_000 },
		cacheWarming: "streaming",
	});
});

test("a concurrent cancelTurn joins the pending cancel and rejects with it on worker death", async () => {
	const session = await createWorkerAgentSession(
		{ model: piModel, apiKey: "test-key", systemPrompt: "x", tools: [] },
		[],
		undefined,
		{ workerPath: join(import.meta.dir, "pi-agent-fake-silent-die.mjs") },
	);
	const first = session.cancelTurn?.();
	await new Promise((resolve) => setTimeout(resolve, 10));
	const second = session.cancelTurn?.();
	const start = Date.now();
	const results = await Promise.allSettled([first, second]);
	expect(Date.now() - start).toBeLessThan(2000);
	for (const result of results) {
		expect(result.status).toBe("rejected");
		if (result.status === "rejected") expect(String(result.reason)).toMatch(/exited/);
	}
	await session.dispose();
}, 20_000);
