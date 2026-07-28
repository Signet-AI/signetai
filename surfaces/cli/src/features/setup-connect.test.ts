import { describe, expect, it, mock } from "bun:test";
import { runOAuthLogin, storeApiKey, storeOAuthCredentials } from "./setup-connect";
import type { ConnectHttp, ConnectUi } from "./setup-connect";

function mockHttp(overrides: Partial<ConnectHttp> = {}): ConnectHttp {
	return {
		postJson: mock(async () => ({ ok: true })),
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

describe("storeApiKey", () => {
	it("stores the key under the canonical secret name", async () => {
		const postJson = mock(async () => ({ ok: true }));
		const res = await storeApiKey({ postJson } as ConnectHttp, "openrouter", "sk-or-x");
		expect(res.ok).toBe(true);
		expect(postJson).toHaveBeenCalledWith("/api/secrets/SIGNET_KEY_OPENROUTER", { value: "sk-or-x" });
	});

	it("reports a store failure with the nested daemon error", async () => {
		const res = await storeApiKey(
			mockHttp({ postJson: mock(async () => ({ ok: false, data: { error: "vault locked" } })) }),
			"openrouter",
			"k",
		);
		expect(res).toEqual({ ok: false, error: "vault locked" });
	});
});

describe("storeOAuthCredentials", () => {
	it("JSON-encodes the credential under the SIGNET_OAUTH_* secret", async () => {
		const postJson = mock(async () => ({ ok: true }));
		const creds = { refresh: "r", access: "a", expires: 0 };
		const res = await storeOAuthCredentials({ postJson } as ConnectHttp, "anthropic", creds as never);
		expect(res.ok).toBe(true);
		const [path, body] = (postJson as ReturnType<typeof mock>).mock.calls[0];
		expect(path).toMatch(/^\/api\/secrets\/SIGNET_OAUTH_/);
		expect((body as { value: string }).value).toContain('"refresh":"r"');
	});
});

describe("runOAuthLogin", () => {
	// A fake pi-ai login() that drives the UI callbacks, then returns creds.
	const fakeLogin =
		(events: Array<(cb: Record<string, (...a: unknown[]) => unknown>) => void>) =>
		async (callbacks: Record<string, (...a: unknown[]) => unknown>) => {
			for (const e of events) e(callbacks);
			return { refresh: "r", access: "a", expires: 0 } as never;
		};

	it("opens the auth URL via the onAuth callback", async () => {
		const openUrl = mock(() => {});
		const login = fakeLogin([(cb) => cb.onAuth({ url: "https://claude.ai/oauth/authorize" })]);
		const creds = await runOAuthLogin(mockUi({ openUrl }), "anthropic", { login });
		expect(creds).toEqual({ refresh: "r", access: "a", expires: 0 });
		expect(openUrl).toHaveBeenCalledWith("https://claude.ai/oauth/authorize");
	});

	it("shows a device code for device-flow providers", async () => {
		const showDeviceCode = mock(() => {});
		const login = fakeLogin([
			(cb) => cb.onDeviceCode({ userCode: "ABCD-WXYZ", verificationUri: "https://github.com/login/device" }),
		]);
		await runOAuthLogin(mockUi({ showDeviceCode }), "github-copilot", { login });
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
		await runOAuthLogin(mockUi({ promptText: mock(async () => "the-code"), onProgress: progress }), "anthropic", {
			login,
		});
		expect(progress).toHaveBeenCalledWith("exchanging");
	});

	it("throws on login failure (the wizard surfaces the error)", async () => {
		const login = async () => {
			throw new Error("bad token");
		};
		await expect(runOAuthLogin(mockUi(), "anthropic", { login })).rejects.toThrow("bad token");
	});
});
