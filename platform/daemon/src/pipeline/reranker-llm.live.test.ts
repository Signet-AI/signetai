/**
 * Live Ollama smoke test for LLM recall summarization.
 *
 * Runs only when SIGNET_OLLAMA_TEST_MODEL is explicitly set.
 *
 * Example:
 * SIGNET_OLLAMA_TEST_MODEL=qwen3:4b bun test reranker-llm.live.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { LlmProvider } from "@signet/core";
import { summarizeRecallWithLlm } from "./reranker-llm";

const OLLAMA = "http://localhost:11434";
const MODEL = process.env.SIGNET_OLLAMA_TEST_MODEL;

async function ollamaHasModel(model: string): Promise<boolean> {
	try {
		const resp = await fetch(`${OLLAMA}/api/tags`);
		const data = (await resp.json()) as { models: Array<{ name: string }> };
		return data.models.some((row) => row.name === model);
	} catch {
		return false;
	}
}

function liveProvider(model: string): LlmProvider {
	return {
		name: "ollama-live-test",
		available: async () => ollamaHasModel(model),
		generate: async (prompt: string, opts?: { timeoutMs?: number; maxTokens?: number }) => {
			const ctl = new AbortController();
			const timeout = Math.max(1000, opts?.timeoutMs ?? 20000);
			const timer = setTimeout(() => ctl.abort(), timeout);
			try {
				const resp = await fetch(`${OLLAMA}/api/generate`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model,
						prompt,
						stream: false,
						options: {
							temperature: 0.1,
							num_predict: Math.max(64, opts?.maxTokens ?? 160),
						},
					}),
					signal: ctl.signal,
				});
				const data = (await resp.json()) as { response?: string; error?: string };
				if (typeof data.error === "string" && data.error.length > 0) {
					throw new Error(`ollama generate error: ${data.error}`);
				}
				return typeof data.response === "string" ? data.response : "";
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

describe("reranker LLM live smoke", () => {
	test("summarizeRecallWithLlm returns grounded text with real ollama model", async () => {
		if (!MODEL || MODEL.trim().length === 0) {
			console.log("SKIP: set SIGNET_OLLAMA_TEST_MODEL to run live reranker summary test");
			return;
		}
		const available = await ollamaHasModel(MODEL);
		if (!available) {
			console.log(`SKIP: ${MODEL} not available on Ollama`);
			return;
		}

		const summary = await summarizeRecallWithLlm(
			liveProvider(MODEL),
			"how should we deploy safely?",
			[
				{
					id: "m1",
					content: "Deploy with blue/green rollout and monitor error rate for five minutes.",
					score: 0.82,
				},
				{
					id: "m2",
					content: "Keep a rollback checklist ready and verify database migration compatibility first.",
					score: 0.78,
				},
				{
					id: "m3",
					content: "Announce maintenance window to users before cutover.",
					score: 0.61,
				},
			],
			90000,
		);

		expect(summary).not.toBeNull();
		const text = summary ?? "";
		expect(text.length).toBeGreaterThan(20);
		expect(text.length).toBeLessThanOrEqual(320);
		expect(/blue|green|rollback|maintenance/i.test(text)).toBe(true);
	}, 180000);
});
