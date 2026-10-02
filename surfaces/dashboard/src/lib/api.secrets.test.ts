import { afterEach, expect, test } from "bun:test";
import { api } from "./api";
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});
test("secret saves request system consent only when explicitly authorized", async () => {
	const bodies: unknown[] = [];
	globalThis.fetch = async (_url, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		return Response.json({ error: "Authorize Keychain access", authorizationRequired: true }, { status: 423 });
	};
	expect(await api.putSecret("SIGNET_KEY_ZAI", "fixture-key")).toMatchObject({
		ok: false,
		authorizationRequired: true,
	});
	await api.putSecret("SIGNET_KEY_ZAI", "fixture-key", undefined, true);
	expect(bodies).toEqual([{ value: "fixture-key" }, { value: "fixture-key", authorizeKeyring: true }]);
});
test("cancelling a secret save aborts its fetch signal", async () => {
	let observed: AbortSignal | undefined;
	globalThis.fetch = async (_url, init) => {
		observed = init?.signal ?? undefined;
		return new Promise((_resolve, reject) =>
			observed?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
		);
	};
	const controller = new AbortController();
	const request = api.putSecret("SIGNET_KEY_ZAI", "fixture-key", controller.signal, true);
	controller.abort();
	expect((await request).ok).toBe(false);
	expect(observed?.aborted).toBe(true);
});
