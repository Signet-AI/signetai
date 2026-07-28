/**
 * Live smoke test for createPiModelProvider against an OpenAI-compatible local
 * server (LM Studio / Ollama). Runs only when SIGNET_PI_LIVE_MODEL is set.
 *
 * Example:
 *   SIGNET_PI_LIVE_MODEL=qwen3.5-0.8b-sft-fable5 \
 *   SIGNET_PI_LIVE_BASE=http://localhost:1234/v1 \
 *   bun test platform/daemon/src/pipeline/pi-provider.live.test.ts
 */
import { describe, expect, test } from "bun:test";
import { createPiModelProvider } from "./pi-provider";

const MODEL = process.env.SIGNET_PI_LIVE_MODEL;
const BASE = process.env.SIGNET_PI_LIVE_BASE ?? "http://localhost:1234/v1";
const SKIP = !MODEL;

describe.skipIf(SKIP)("createPiModelProvider (live)", () => {
	const provider = createPiModelProvider({
		executor: "openai-compatible",
		model: MODEL!,
		baseUrl: BASE,
		defaultTimeoutMs: 60_000,
	});

	test("generate returns a coherent answer", async () => {
		const text = await provider.generate("What is 7 plus 5? Reply with just the number.");
		expect(text.trim()).toMatch(/^\d+/);
		expect(text.trim()).toContain("12");
	});

	test("generateWithUsage reports input/output tokens and duration", async () => {
		const res = await provider.generateWithUsage!("What is 3 times 3? Just the number.");
		expect(res.usage).not.toBeNull();
		expect(res.usage!.inputTokens!).toBeGreaterThan(0);
		expect(res.usage!.outputTokens!).toBeGreaterThan(0);
		expect(res.usage!.totalDurationMs).not.toBeNull();
	});

	test("streamWithUsage emits deltas and a done event with usage", async () => {
		const stream = await provider.streamWithUsage!("Count from 1 to 5, comma separated.");
		let streamed = "";
		let doneUsage = null;
		for await (const ev of stream.stream) {
			if (ev.type === "text-delta") streamed += ev.text;
			if (ev.type === "done") doneUsage = ev.usage;
		}
		expect(streamed.trim().length).toBeGreaterThan(0);
		expect(doneUsage?.outputTokens).not.toBeNull();
	});

	test("abort signal propagates and throws", async () => {
		const ctrl = new AbortController();
		const stream = await provider.streamWithUsage!("Write a 500-word essay about oceans. Be very verbose.", {
			signal: ctrl.signal,
		});
		setTimeout(() => ctrl.abort(), 300);
		let threw = false;
		let doneSeen = false;
		try {
			for await (const ev of stream.stream) {
				if (ev.type === "done") doneSeen = true;
			}
		} catch {
			threw = true;
		}
		stream.cancel();
		expect(threw).toBe(true);
		expect(doneSeen).toBe(false);
	});

	test("timeoutMs aborts a long generation", async () => {
		let threw = false;
		try {
			await provider.generate("Write a 1000-word story. Be extremely verbose and detailed.", {
				timeoutMs: 150,
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});
