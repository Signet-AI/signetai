import { expect, test, spyOn } from "bun:test";
import { streamAssistantChat } from "./api";

test("chat transport sends only canonical model selection fields", async () => {
	const conversationId = crypto.randomUUID();
	const selection = {
		targetRef: "backend/default",
		model: "gpt-6-luna",
		name: "GPT-6 Luna",
		provider: "openai-codex",
		account: "Connected account",
	};
	const mocked = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response('data: {"type":"done","model":"gpt-6-luna"}\n\n', {
			headers: { "Content-Type": "text/event-stream" },
		}),
	);
	try {
		await streamAssistantChat(
			[{ role: "user", content: "Hello" }],
			() => {},
			new AbortController().signal,
			conversationId,
			undefined,
			selection,
		);
		const body = mocked.mock.calls[0]?.[1]?.body;
		if (typeof body !== "string") throw new Error("Expected JSON chat request");
		expect(JSON.parse(body).conversationId).toBe(conversationId);
		expect(JSON.parse(body).modelSelection).toEqual({ targetRef: "backend/default", model: "gpt-6-luna" });
	} finally {
		mocked.mockRestore();
	}
});

test("board event stream is not aborted by the GET deadline", async () => {
	const { streamBoardEvents } = await import("./api");
	let signal: AbortSignal | null | undefined;
	const mocked = spyOn(globalThis, "fetch").mockImplementation((async (_i: RequestInfo | URL, init?: RequestInit) => {
		signal = init?.signal;
		return new Response('data: {"type":"board"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
	}) as typeof fetch);
	try {
		const controller = new AbortController();
		await streamBoardEvents(() => {}, controller.signal);
		expect(signal).toBe(controller.signal);
	} finally {
		mocked.mockRestore();
	}
});
