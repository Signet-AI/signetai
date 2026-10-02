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
