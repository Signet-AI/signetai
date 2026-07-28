import { describe, expect, it, mock } from "bun:test";
import { connectApiKey, connectOAuth, fetchModels } from "./setup-connect";
import type { ConnectHttp, ConnectUi } from "./setup-connect";

function mockHttp(overrides: Partial<ConnectHttp> = {}): ConnectHttp {
	return {
		postJson: mock(async () => ({ ok: true })),
		getJson: mock(async () => ({ ok: true })),
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
	// A fake pi-ai login() that drives the UI callbacks, then returns creds.
	const fakeLogin =
		(events: Array<(cb: Record<string, (...a: unknown[]) => unknown>) => void>) =>
		async (callbacks: Record<string, (...a: unknown[]) => unknown>) => {
			for (const e of events) e(callbacks);
			return { refresh: "r", access: "a", expires: 0 } as never;
		};

	it("opens the auth URL via the onAuth callback and stores the credential", async () => {
		const openUrl = mock(() => {});
		const stored: Array<{ name: string; value: string }> = [];
		const http = mockHttp({
			postJson: mock(async (path: string, body: unknown) => {
				if (path.startsWith("/api/secrets/")) stored.push({ name: path, value: (body as { value: string }).value });
				return { ok: true };
			}) as ConnectHttp["postJson"],
		});
		const login = fakeLogin([(cb) => cb.onAuth({ url: "https://claude.ai/oauth/authorize" })]);
		const res = await connectOAuth(http, mockUi({ openUrl }), "anthropic", { login });
		expect(res).toEqual({ ok: true, method: "oauth" });
		expect(openUrl).toHaveBeenCalledWith("https://claude.ai/oauth/authorize");
		// Stored under the canonical SIGNET_OAUTH_<hex> secret, JSON-encoded.
		expect(stored[0]?.name).toMatch(/^\/api\/secrets\/SIGNET_OAUTH_/);
		expect(stored[0]?.value).toContain('"refresh":"r"');
	});

	it("shows a device code for device-flow providers", async () => {
		const showDeviceCode = mock(() => {});
		const login = fakeLogin([
			(cb) => cb.onDeviceCode({ userCode: "ABCD-WXYZ", verificationUri: "https://github.com/login/device" }),
		]);
		await connectOAuth(mockHttp(), mockUi({ showDeviceCode }), "github-copilot", { login });
		expect(showDeviceCode).toHaveBeenCalledWith("ABCD-WXYZ", "https://github.com/login/device");
	});

	it("answers a prompt via the UI and forwards progress", async () => {
		const progress = mock(() => {});
		const login = fakeLogin([
			(cb) => cb.onProgress("exchanging"),
			async (cb) => {
				const v = await cb.onPrompt({ message: "Paste code" });
				expect(v).toBe("the-code");
			},
		]);
		await connectOAuth(
			mockHttp(),
			mockUi({ promptText: mock(async () => "the-code"), onProgress: progress }),
			"anthropic",
			{
				login,
			},
		);
		expect(progress).toHaveBeenCalledWith("exchanging");
	});

	it("surfaces a login failure", async () => {
		const login = async () => {
			throw new Error("bad token");
		};
		const res = await connectOAuth(mockHttp(), mockUi(), "anthropic", { login });
		expect(res).toEqual({ ok: false, error: "bad token" });
	});

	it("reports a store failure", async () => {
		const login = fakeLogin([]);
		const res = await connectOAuth(
			mockHttp({ postJson: mock(async () => ({ ok: false, error: "vault locked" })) }),
			mockUi(),
			"anthropic",
			{ login },
		);
		expect(res).toEqual({ ok: false, error: "vault locked" });
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
