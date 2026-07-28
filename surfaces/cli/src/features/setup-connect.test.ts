import { describe, expect, it, mock } from "bun:test";
import { connectApiKey, connectOAuth, fetchModels } from "./setup-connect";
import type { ConnectHttp, ConnectUi } from "./setup-connect";

function mockHttp(overrides: Partial<ConnectHttp> = {}): ConnectHttp {
	return {
		postJson: mock(async () => ({ ok: true })),
		getJson: mock(async () => ({ ok: true })),
		postStream: mock(
			async () =>
				new ReadableStream({
					start(c) {
						c.close();
					},
				}),
		),
		...overrides,
	};
}

function mockUi(overrides: Partial<ConnectUi> = {}): ConnectUi {
	return {
		openUrl: mock(() => {}),
		showDeviceCode: mock(() => {}),
		promptText: mock(async () => ""),
		promptSelect: mock(async () => ""),
		...overrides,
	};
}

/** Build a SSE stream from framed events (matches the daemon's emit format). */
function sseStream(events: Array<{ type: string; data: Record<string, unknown> }>): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const frames = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(frames));
			controller.close();
		},
	});
}

describe("connectApiKey", () => {
	it("stores the key under the canonical secret name", async () => {
		const postJson = mock(async () => ({ ok: true }));
		const res = await connectApiKey({ postJson } as ConnectHttp, "openrouter", "sk-or-x");
		expect(res).toEqual({ ok: true, method: "api" });
		expect(postJson).toHaveBeenCalledWith("/api/secrets/SIGNET_KEY_OPENROUTER", { value: "sk-or-x" });
	});

	it("reports failure", async () => {
		const res = await connectApiKey(
			mockHttp({ postJson: mock(async () => ({ ok: false, error: "nope" })) }),
			"openrouter",
			"k",
		);
		expect(res.ok).toBe(false);
	});
});

describe("connectOAuth", () => {
	it("opens the auth URL and completes on connected", async () => {
		const openUrl = mock(() => {});
		const http = mockHttp({
			postStream: mock(async () =>
				sseStream([
					{ type: "session", data: { sessionId: "s1", providerId: "anthropic" } },
					{ type: "auth", data: { url: "https://claude.ai/oauth/authorize?..." } },
					{ type: "connected", data: { providerId: "anthropic" } },
					{ type: "done", data: {} },
				]),
			),
		});
		const res = await connectOAuth(http, mockUi({ openUrl }), "anthropic");
		expect(res).toEqual({ ok: true, method: "oauth" });
		expect(openUrl).toHaveBeenCalledWith("https://claude.ai/oauth/authorize?...");
	});

	it("shows a device code for device-flow providers", async () => {
		const showDeviceCode = mock(() => {});
		const http = mockHttp({
			postStream: mock(async () =>
				sseStream([
					{ type: "device_code", data: { userCode: "ABCD-WXYZ", verificationUri: "https://github.com/login/device" } },
					{ type: "connected", data: { providerId: "github-copilot" } },
				]),
			),
		});
		const res = await connectOAuth(http, mockUi({ showDeviceCode }), "github-copilot");
		expect(res.ok).toBe(true);
		expect(showDeviceCode).toHaveBeenCalledWith("ABCD-WXYZ", "https://github.com/login/device");
	});

	it("answers a prompt by POSTing to /complete with the sessionId", async () => {
		const completeCalls: Array<Record<string, unknown>> = [];
		const http = mockHttp({
			postStream: mock(async () =>
				sseStream([
					{ type: "session", data: { sessionId: "s9" } },
					{ type: "prompt", data: { responseId: "r1", message: "Paste code", allowEmpty: false } },
					{ type: "connected", data: {} },
				]),
			),
			postJson: mock(async (_path: string, body: unknown) => {
				completeCalls.push(body as Record<string, unknown>);
				return { ok: true };
			}) as ConnectHttp["postJson"],
		});
		await connectOAuth(http, mockUi({ promptText: mock(async () => "the-code") }), "anthropic");
		expect(completeCalls).toContainEqual({ sessionId: "s9", responseId: "r1", value: "the-code" });
	});

	it("answers a select prompt", async () => {
		const completeCalls: Array<Record<string, unknown>> = [];
		const http = mockHttp({
			postStream: mock(async () =>
				sseStream([
					{
						type: "select",
						data: {
							responseId: "r2",
							message: "pick",
							options: [
								{ id: "a", label: "A" },
								{ id: "b", label: "B" },
							],
						},
					},
					{ type: "connected", data: {} },
				]),
			),
			postJson: mock(async (_p: string, body: unknown) => {
				completeCalls.push(body as Record<string, unknown>);
				return { ok: true };
			}) as ConnectHttp["postJson"],
		});
		await connectOAuth(http, mockUi({ promptSelect: mock(async () => "b") }), "x");
		expect(completeCalls).toContainEqual({ sessionId: undefined, responseId: "r2", value: "b" });
	});

	it("surfaces a daemon error", async () => {
		const http = mockHttp({
			postStream: mock(async () => sseStream([{ type: "error", data: { error: "bad token" } }])),
		});
		const res = await connectOAuth(http, mockUi(), "anthropic");
		expect(res).toEqual({ ok: false, error: "bad token" });
	});
});

describe("fetchModels", () => {
	it("returns the model list for a family", async () => {
		const http = mockHttp({
			getJson: mock(async () => ({ ok: true, data: { models: { openrouter: [{ id: "m1", name: "M1" }] } } })),
		});
		expect(await fetchModels(http, "openrouter")).toEqual([{ id: "m1", name: "M1" }]);
	});

	it("returns [] when the family is absent", async () => {
		const http = mockHttp({ getJson: mock(async () => ({ ok: true, data: { models: {} } })) });
		expect(await fetchModels(http, "nope")).toEqual([]);
	});
});
