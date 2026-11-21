import { afterEach, describe, expect, it, mock } from "bun:test";
import { INTERNAL_FETCH_TIMEOUT_MS, fetchInternal } from "./internal-fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("fetchInternal", () => {
	it("preserves the request while applying the shared timeout", async () => {
		let receivedInit: RequestInit | undefined;
		globalThis.fetch = mock((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			receivedInit = init;
			return Promise.resolve(Response.json({ ok: true }));
		}) as typeof fetch;

		const response = await fetchInternal("http://127.0.0.1:3850/api/memory/remember", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: '{"content":"pending"}',
		});

		expect(response.status).toBe(200);
		expect(receivedInit?.method).toBe("POST");
		expect(receivedInit?.headers).toEqual({ "Content-Type": "application/json" });
		expect(receivedInit?.body).toBe('{"content":"pending"}');
		expect(receivedInit?.signal).toBeInstanceOf(AbortSignal);
		expect(receivedInit?.signal?.aborted).toBe(false);
	});

	it("rejects a stalled operation instead of reporting success", async () => {
		globalThis.fetch = mock((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("The operation timed out", "TimeoutError")),
					{ once: true },
				);
			});
		}) as typeof fetch;

		await expect(fetchInternal("http://127.0.0.1:3850/api/memory/remember", {}, 5)).rejects.toMatchObject({
			name: "TimeoutError",
		});
	});

	it("honors caller cancellation as well as the timeout", async () => {
		const controller = new AbortController();
		globalThis.fetch = mock((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("The operation was aborted", "AbortError")),
					{ once: true },
				);
			});
		}) as typeof fetch;

		const request = fetchInternal("http://127.0.0.1:3850/api/memory/remember", { signal: controller.signal }, 1_000);
		controller.abort();

		await expect(request).rejects.toMatchObject({ name: "AbortError" });
	});

	it("uses the shared production timeout by default", () => {
		expect(INTERNAL_FETCH_TIMEOUT_MS).toBe(10_000);
	});
});
