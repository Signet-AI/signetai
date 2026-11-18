import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { createWorkerAgentSession, stopPiAgentWorkers } from "./pi-agent-client";
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
