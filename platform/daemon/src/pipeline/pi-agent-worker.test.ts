import { afterEach, expect, test } from "bun:test";
import { isMainThread } from "node:worker_threads";
import * as Type from "typebox";
import { createPiModelProvider } from "./pi-provider";
import { activePiAgentWorkers, piAgentWorkerLimit, stopPiAgentWorkers } from "./pi-agent-client";
import { configureLlmConcurrency, getLlmConcurrencyLimit } from "./provider";
import type { PiAgentTool } from "./pi-agent-protocol";

function completion(delta: unknown, finishReason: string | null = null): string {
	return `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

afterEach(async () => {
	await stopPiAgentWorkers();
});

test("allows a Pi agent worker per shared LLM permit plus the retained chat sessions", () => {
	const previous = getLlmConcurrencyLimit();
	try {
		configureLlmConcurrency(2);
		expect(piAgentWorkerLimit()).toBe(5);
		configureLlmConcurrency(8);
		expect(piAgentWorkerLimit()).toBe(11);
	} finally {
		configureLlmConcurrency(previous);
	}
});

test("the real Pi loop runs in a worker and invokes only supplied tools in the daemon", async () => {
	let requests = 0;
	let toolRanInDaemon = false;
	let announcedTools: unknown;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = await request.json();
			announcedTools = body.tools;
			requests++;
			const content =
				requests === 1
					? completion({
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call-1",
									type: "function",
									function: { name: "read_memory", arguments: '{"query":"project"}' },
								},
							],
						}) + completion({}, "tool_calls")
					: completion({ role: "assistant", content: "Your project is Signet [entity:signet]." }) +
						completion({}, "stop");
			return new Response(`${content}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	const tools: PiAgentTool[] = [
		{
			name: "read_memory",
			label: "Read memory",
			description: "Read scoped memory",
			parameters: Type.Object({ query: Type.String() }),
			async execute(_id, params) {
				toolRanInDaemon = isMainThread;
				expect(params).toEqual({ query: "project" });
				return { content: [{ type: "text", text: "Signet, entity:signet" }], details: {} };
			},
		},
	];
	try {
		const provider = createPiModelProvider({
			executor: "openai-compatible",
			model: "test-model",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		});
		const session = await provider.createAgentSession(tools, { systemPrompt: "You are a memory assistant." });
		expect(session.getExecutionThreadId?.()).toBeGreaterThan(0);
		expect(session.getSystemPrompt?.()).toContain("memory assistant");
		expect(session.getActiveToolNames()).toEqual(["read_memory"]);
		let answer = "";
		session.subscribe?.((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
				answer += event.assistantMessageEvent.delta;
		});
		await session.prompt("What is my project?");
		expect(answer).toContain("Signet");
		expect(toolRanInDaemon).toBe(true);
		expect(requests).toBe(2);
		expect(JSON.stringify(announcedTools)).not.toContain('"bash"');
		await session.dispose();
		expect(activePiAgentWorkers()).toBe(0);
	} finally {
		server.stop(true);
	}
}, 20000);

test("a session retry policy outlasts provider throttling that exhausts the default retries", async () => {
	let requests = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch() {
			requests++;
			if (requests <= 6) {
				return new Response(JSON.stringify({ code: "1302", message: "rate limited" }), {
					status: 429,
					headers: { "Content-Type": "application/json", "retry-after-ms": "1" },
				});
			}
			const content = completion({ role: "assistant", content: "Filed." }) + completion({}, "stop");
			return new Response(`${content}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	try {
		const provider = createPiModelProvider({
			executor: "openai-compatible",
			model: "test-model",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		});
		const session = await provider.createAgentSession([], {
			systemPrompt: "You are a maintenance agent.",
			retry: { maxRetries: 6, baseDelayMs: 1, maxAgentDelayMs: 5 },
		});
		try {
			await session.prompt("Run the pass.");
			expect(session.getFailureMessage()).toBeUndefined();
			expect(requests).toBe(7);
		} finally {
			await session.dispose();
		}
	} finally {
		server.stop(true);
	}
}, 30000);

test("codemode scripts reach codemode tools in the daemon but cannot call model-only tools", async () => {
	let requests = 0;
	let announced: string[] = [];
	let scriptResult = "";
	const lookups: unknown[] = [];
	let writes = 0;
	const script = [
		"const a = await tools.lookup({ query: 'alpha' });",
		"const b = await tools.lookup({ query: 'beta' });",
		"let blocked = 'no';",
		"try { await tools.write({ value: 'x' }); } catch { blocked = 'yes'; }",
		"text(a + '|' + b + '|blocked=' + blocked);",
	].join("\n");
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = (await request.json().catch(() => null)) as {
				tools?: Array<{ function: { name: string } }>;
				messages?: Array<{ role: string; content?: unknown }>;
			} | null;
			if (body === null) return new Response("", { status: 400 });
			requests++;
			if (requests === 1) {
				announced = (body.tools ?? []).map((tool) => tool.function.name);
			} else {
				const toolMessage = (body.messages ?? []).find((message) => message.role === "tool");
				scriptResult = JSON.stringify(toolMessage?.content ?? "");
			}
			const content =
				requests === 1
					? completion({
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call-1",
									type: "function",
									function: { name: "codemode", arguments: JSON.stringify({ code: script }) },
								},
							],
						}) + completion({}, "tool_calls")
					: completion({ role: "assistant", content: "Done." }) + completion({}, "stop");
			return new Response(`${content}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	const tools: PiAgentTool[] = [
		{
			name: "lookup",
			label: "Lookup",
			description: "Read-only lookup",
			parameters: Type.Object({ query: Type.String() }),
			exposure: "codemode",
			async execute(_id, params) {
				lookups.push(params);
				return { content: [{ type: "text", text: `found:${(params as { query: string }).query}` }], details: {} };
			},
		},
		{
			name: "write",
			label: "Write",
			description: "Audited write",
			parameters: Type.Object({ value: Type.String() }),
			exposure: "model-only",
			async execute() {
				writes++;
				return { content: [{ type: "text", text: "written" }], details: {} };
			},
		},
	];
	try {
		const provider = createPiModelProvider({
			executor: "openai-compatible",
			model: "test-model",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		});
		const session = await provider.createAgentSession(tools, { systemPrompt: "You are a maintenance agent." });
		try {
			await session.prompt("Look things up.");
			expect(announced).toContain("codemode");
			expect(announced).toContain("write");
			expect(announced).not.toContain("lookup");
			expect(lookups).toEqual([{ query: "alpha" }, { query: "beta" }]);
			expect(writes).toBe(0);
			expect(scriptResult).toContain("found:alpha|found:beta|blocked=yes");
		} finally {
			await session.dispose();
		}
	} finally {
		server.stop(true);
	}
}, 30000);

test("a codemode script may make many tool calls, with at most eight in flight", async () => {
	let requests = 0;
	let scriptResult = "";
	let calls = 0;
	let inFlight = 0;
	let maxInFlight = 0;
	const script = [
		"for (let i = 0; i < 100; i++) await tools.lookup({ query: 'q' + i });",
		"await Promise.all(Array.from({ length: 20 }, (_, i) => tools.lookup({ query: 'p' + i })));",
		"text('done');",
	].join("\n");
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = (await request.json().catch(() => null)) as {
				messages?: Array<{ role: string; content?: unknown }>;
			} | null;
			if (body === null) return new Response("", { status: 400 });
			requests++;
			if (requests > 1) {
				scriptResult = JSON.stringify(body.messages?.find((message) => message.role === "tool")?.content ?? "");
			}
			const content =
				requests === 1
					? completion({
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call-1",
									type: "function",
									function: { name: "codemode", arguments: JSON.stringify({ code: script }) },
								},
							],
						}) + completion({}, "tool_calls")
					: completion({ role: "assistant", content: "Done." }) + completion({}, "stop");
			return new Response(`${content}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	const tools: PiAgentTool[] = [
		{
			name: "lookup",
			label: "Lookup",
			description: "Read-only lookup",
			parameters: Type.Object({ query: Type.String() }),
			exposure: "codemode",
			async execute() {
				calls++;
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 2));
				inFlight--;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		},
	];
	try {
		const provider = createPiModelProvider({
			executor: "openai-compatible",
			model: "test-model",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		});
		const session = await provider.createAgentSession(tools, { systemPrompt: "You are a maintenance agent." });
		try {
			await session.prompt("Look everything up.");
			expect(scriptResult).toContain("done");
			expect(calls).toBe(120);
			expect(maxInFlight).toBeLessThanOrEqual(8);
			expect(maxInFlight).toBeGreaterThan(1);
		} finally {
			await session.dispose();
		}
	} finally {
		server.stop(true);
	}
}, 60000);

test("aborting a stalled model releases the actual worker and settles the prompt", async () => {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch() {
			return new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	try {
		const provider = createPiModelProvider({
			executor: "openai-compatible",
			model: "test-model",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		});
		const session = await provider.createAgentSession([]);
		const result = session.prompt("wait");
		const settled = result.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : "failed"),
		);
		await session.abort();
		expect(await settled).toContain("closed");
		expect(activePiAgentWorkers()).toBe(0);
	} finally {
		server.stop(true);
	}
}, 20000);

test("worker admission is bounded and shutdown closes idle sessions", async () => {
	const provider = createPiModelProvider({
		executor: "openai-compatible",
		model: "test-model",
		baseUrl: "http://127.0.0.1:1/v1",
	});
	for (let index = 0; index < piAgentWorkerLimit(); index++) await provider.createAgentSession([]);
	await expect(provider.createAgentSession([])).rejects.toThrow("capacity");
	await stopPiAgentWorkers();
	expect(activePiAgentWorkers()).toBe(0);
}, 20000);

test("chat leases preserve the real Pi session, native tool history, and refresh turn callbacks", async () => {
	const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
	const callbacks: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = await request.json();
			requests.push(body);
			const last = body.messages.at(-1);
			const content =
				last?.role === "user"
					? completion({
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: `read-${requests.length}`,
									type: "function",
									function: { name: "read_memory", arguments: "{}" },
								},
							],
						}) + completion({}, "tool_calls")
					: completion({ role: "assistant", content: "Remembered the evidence." }) + completion({}, "stop");
			return new Response(`${content}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	const turnTools = (turn: string): PiAgentTool[] => [
		{
			name: "read_memory",
			label: "Read",
			description: "Read memory",
			parameters: Type.Object({}),
			async execute() {
				callbacks.push(turn);
				return { content: [{ type: "text", text: `Evidence for ${turn}` }], details: {} };
			},
		},
	];
	try {
		const provider = createPiModelProvider({
			executor: "openai-compatible",
			model: "test-model",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		});
		const first = await provider.createAgentSession(turnTools("first"), {
			persistentSessionKey: "scope-a:conversation",
			systemPrompt: "Memory assistant.",
		});
		const id = first.getSessionId?.();
		const thread = first.getExecutionThreadId?.();
		await first.prompt("First question");
		await first.dispose();
		expect(activePiAgentWorkers()).toBe(1);
		const second = await provider.createAgentSession(turnTools("second"), {
			persistentSessionKey: "scope-a:conversation",
			continuationPrompt: "Second question",
			systemPrompt: "Memory assistant.",
		});
		expect(second.getSessionId?.()).toBe(id);
		expect(second.getExecutionThreadId?.()).toBe(thread);
		await expect(
			provider.createAgentSession(turnTools("concurrent"), {
				persistentSessionKey: "scope-a:conversation",
				systemPrompt: "Memory assistant.",
			}),
		).rejects.toThrow("active turn");
		await second.prompt("SHOULD_NOT_BE_REPLAYED");
		expect(callbacks).toEqual(["first", "second"]);
		expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Evidence for first");
		expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Second question");
		expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("SHOULD_NOT_BE_REPLAYED");
		expect(requests.at(-1)?.messages.filter((message) => message.role === "user")).toHaveLength(2);
		expect(second.getRequestUsages?.()).toHaveLength(2);
		await second.dispose();
		const switchedProvider = createPiModelProvider({
			executor: "openai-compatible",
			model: "other-model",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		});
		const switched = await switchedProvider.createAgentSession(turnTools("switched"), {
			persistentSessionKey: "scope-a:conversation",
			continuationPrompt: "Third question",
			systemPrompt: "Memory assistant.",
		});
		expect(switched.getSessionId?.()).toBe(id);
		expect(switched.getExecutionThreadId?.()).toBe(thread);
		expect(switched.getModelName?.()).toBe("other-model");
		await switched.prompt("SHOULD_NOT_BE_REPLAYED");
		expect(requests.at(-1)?.messages.filter((message) => message.role === "user")).toHaveLength(3);
		expect(callbacks).toEqual(["first", "second", "switched"]);
		await switched.dispose();
		const other = await provider.createAgentSession([], {
			persistentSessionKey: "scope-b:conversation",
			systemPrompt: "Memory assistant.",
		});
		expect(other.getSessionId?.()).not.toBe(id);
		await other.dispose();
	} finally {
		server.stop(true);
	}
}, 20000);

test("idle TTL expires an actual retained worker", async () => {
	const { leaseWorkerAgentSession } = await import("./pi-agent-client");
	const { resolvePiModel } = await import("./pi-provider");
	const { piModel } = resolvePiModel({
		executor: "openai-compatible",
		model: "test-model",
		baseUrl: "http://127.0.0.1:1/v1",
	});
	const session = await leaseWorkerAgentSession(
		"ttl-test",
		undefined,
		{ model: piModel, apiKey: "local-test", systemPrompt: "test", tools: [] },
		[],
		undefined,
		30,
	);
	await session.dispose();
	expect(activePiAgentWorkers()).toBe(1);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	expect(activePiAgentWorkers()).toBe(0);
}, 10000);

test("stopping a chat turn retains its worker for the next turn", async () => {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch() {
			return new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	try {
		const provider = createPiModelProvider({
			executor: "openai-compatible",
			model: "test-model",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		});
		const first = await provider.createAgentSession([], { persistentSessionKey: "cancel-test" });
		const id = first.getSessionId?.();
		const pending = first.prompt("Wait");
		await first.abort();
		await pending;
		await first.dispose();
		expect(activePiAgentWorkers()).toBe(1);
		const next = await provider.createAgentSession([], { persistentSessionKey: "cancel-test" });
		expect(next.getSessionId?.()).toBe(id);
		await next.dispose();
	} finally {
		server.stop(true);
	}
}, 10000);
