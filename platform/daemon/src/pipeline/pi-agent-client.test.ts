import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { createWorkerAgentSession, stopPiAgentWorkers } from "./pi-agent-client";
import { piAgentWorkerSettings } from "./pi-agent-protocol";
import { resolvePiModel } from "./pi-provider";

const { piModel } = resolvePiModel({
	executor: "openai-compatible",
	model: "test-model",
	baseUrl: "http://127.0.0.1:1/v1",
});

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
	await expect(session.cancelTurn?.()).rejects.toThrow(/exited/);
	const start = Date.now();
	await session.dispose();
	expect(Date.now() - start).toBeLessThan(500);
}, 20_000);

test("cancel ignores stale and id-less aborted acks and waits for the matching id", async () => {
	const session = await createWorkerAgentSession(
		{ model: piModel, apiKey: "test-key", systemPrompt: "x", tools: [] },
		[],
		undefined,
		{ workerPath: join(import.meta.dir, "pi-agent-fake-acks.mjs") },
	);
	const start = Date.now();
	await session.cancelTurn?.();
	expect(Date.now() - start).toBeGreaterThanOrEqual(250);
	await session.dispose();
}, 20_000);

test("a second turn's cancel is not satisfied by the first turn's ack", async () => {
	const session = await createWorkerAgentSession(
		{ model: piModel, apiKey: "test-key", systemPrompt: "x", tools: [] },
		[],
		undefined,
		{ workerPath: join(import.meta.dir, "pi-agent-fake-stale.mjs") },
	);
	await session.cancelTurn?.();
	const start = Date.now();
	await session.cancelTurn?.();
	expect(Date.now() - start).toBeGreaterThanOrEqual(350);
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
