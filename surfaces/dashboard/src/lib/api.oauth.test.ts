import { afterEach, expect, test } from "bun:test";
import { startOAuthLogin } from "./api";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("OAuth EOF before a saved credential is an error, not a hanging sign-in", async () => {
	globalThis.fetch = async () =>
		new Response('data: {"type":"done"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
	const error = await new Promise<string>((resolve) => startOAuthLogin("fixture").onError(resolve));
	expect(error).toContain("before the connection was saved");
});

test("cancelling OAuth before fetch resolves suppresses late callbacks", async () => {
	let respond: (response: Response) => void = () => {};
	globalThis.fetch = () =>
		new Promise((resolve) => {
			respond = resolve;
		});
	const handle = startOAuthLogin("fixture");
	const events: unknown[] = [];
	handle.onEvent((event) => events.push(event));
	handle.onError((error) => events.push(error));
	handle.close();
	respond(new Response('data: {"type":"connected"}\n\n'));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(events).toEqual([]);
});
