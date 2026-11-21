import { afterEach, describe, expect, it } from "bun:test";
import { discoverLocalContextWindow, resetLocalContextWindowCache } from "./local-context-window";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler): {
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	urls: string[];
} {
	const urls: string[] = [];
	return {
		urls,
		fetch: async (url, init) => {
			urls.push(`${init?.method ?? "GET"} ${url}`);
			return handler(url, init);
		},
	};
}

afterEach(() => resetLocalContextWindowCache());

describe("discoverLocalContextWindow", () => {
	it("reads vLLM's max_model_len for the configured model", async () => {
		const server = fakeFetch(() =>
			Response.json({
				data: [
					{ id: "other", max_model_len: 4096 },
					{ id: "qwen3.8-27b", max_model_len: 262144 },
				],
			}),
		);
		const window = await discoverLocalContextWindow(
			"openai-compatible",
			"http://127.0.0.1:8000/v1",
			"qwen3.8-27b",
			undefined,
			server.fetch,
		);
		expect(window).toBe(262144);
		expect(server.urls).toEqual(["GET http://127.0.0.1:8000/v1/models"]);
	});

	it("asks llama.cpp /props for the serving n_ctx first", async () => {
		const server = fakeFetch((url) =>
			url.endsWith("/props")
				? Response.json({ default_generation_settings: { n_ctx: 131072 } })
				: Response.json({ data: [{ id: "qwen.gguf", meta: { n_ctx_train: 262144 } }] }),
		);
		const window = await discoverLocalContextWindow(
			"llama-cpp",
			"http://127.0.0.1:8080",
			"qwen.gguf",
			undefined,
			server.fetch,
		);
		expect(window).toBe(131072);
		expect(server.urls).toEqual(["GET http://127.0.0.1:8080/props"]);
	});

	it("never reports a model's training length as its serving window", async () => {
		const server = fakeFetch((url) =>
			url.endsWith("/props")
				? Response.json({ default_generation_settings: { n_ctx: 32768 } })
				: Response.json({ data: [{ id: "qwen.gguf", meta: { n_ctx_train: 262144 } }] }),
		);
		const window = await discoverLocalContextWindow(
			"openai-compatible",
			"http://127.0.0.1:8080/v1",
			"qwen.gguf",
			undefined,
			server.fetch,
		);
		expect(window).toBe(32768);
	});

	it("reads the num_ctx Ollama serves, not the model's maximum", async () => {
		const server = fakeFetch((url) =>
			url.endsWith("/api/show")
				? Response.json({
						parameters: 'num_ctx                        65536\nstop                           "<|im_end|>"',
						model_info: { "qwen35.context_length": 262144 },
					})
				: new Response("no", { status: 404 }),
		);
		expect(
			await discoverLocalContextWindow("ollama", "http://127.0.0.1:11434/v1", "qwen3.8:27b", undefined, server.fetch),
		).toBe(65536);
		expect(server.urls[0]).toBe("POST http://127.0.0.1:11434/api/show");
	});

	it("reports no Ollama window when num_ctx is not set, since Ollama then serves its own default", async () => {
		const server = fakeFetch((url) =>
			url.endsWith("/api/show")
				? Response.json({ model_info: { "qwen35.context_length": 262144 } })
				: new Response("no", { status: 404 }),
		);
		expect(
			await discoverLocalContextWindow("ollama", "http://127.0.0.1:11434/v1", "qwen3.8:27b", undefined, server.fetch),
		).toBeUndefined();
	});

	it("caches a discovered window and retries an unreachable server only after the backoff", async () => {
		let up = false;
		let clock = 1_000;
		const server = fakeFetch(() => {
			if (!up) throw new Error("connection refused");
			return Response.json({ data: [{ id: "m", max_model_len: 65536 }] });
		});
		const discover = () =>
			discoverLocalContextWindow(
				"openai-compatible",
				"http://127.0.0.1:9/v1",
				"m",
				undefined,
				server.fetch,
				() => clock,
			);

		expect(await discover()).toBeUndefined();
		up = true;
		expect(await discover()).toBeUndefined();
		clock += 61_000;
		expect(await discover()).toBe(65536);
		clock += 10 * 61_000;
		expect(await discover()).toBe(65536);
		expect(server.urls.filter((url) => url.endsWith("/v1/models"))).toHaveLength(2);
	});

	it("does nothing without an endpoint", async () => {
		const server = fakeFetch(() => Response.json({}));
		expect(
			await discoverLocalContextWindow("openai-compatible", undefined, "m", undefined, server.fetch),
		).toBeUndefined();
		expect(server.urls).toEqual([]);
	});
});

describe("isPiCompactionStart", () => {
	it("recognizes Pi's auto-compaction start event only", async () => {
		const { isPiCompactionStart } = await import("../../dreaming/passes/dreaming");
		expect(isPiCompactionStart({ type: "compaction_start", reason: "threshold" })).toBe(true);
		expect(isPiCompactionStart({ type: "turn_start" })).toBe(false);
		expect(isPiCompactionStart(null)).toBe(false);
	});
});
