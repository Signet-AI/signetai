import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./api";

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: unknown }).window;

function setDesktopBridge(bridge: Record<string, unknown>): void {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { signetDesktop: { openExternal: async () => undefined, ...bridge } },
	});
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
	else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("desktop-native source pickers", () => {
	test("uses the Electron folder dialog before the daemon PowerShell fallback", async () => {
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			throw new Error("daemon picker should not run in Electron");
		}) as typeof fetch;
		setDesktopBridge({
			pickDirectory: async (options: { readonly title?: string }) => {
				expect(options.title).toBe("Choose your vault folder");
				return "C:\\Users\\marti\\Documents\\Vault";
			},
		});

		expect(await api.pickDirectory()).toEqual({ ok: true, path: "C:\\Users\\marti\\Documents\\Vault" });
		expect(fetchCalled).toBe(false);
	});

	test("uses the Electron multi-file dialog before the daemon PowerShell fallback", async () => {
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			throw new Error("daemon picker should not run in Electron");
		}) as typeof fetch;
		setDesktopBridge({
			pickFiles: async (options: { readonly title?: string }) => {
				expect(options.title).toBe("Choose files to import");
				return ["C:\\Users\\marti\\Documents\\notes.md"];
			},
		});

		expect(await api.pickFiles()).toEqual({ ok: true, paths: ["C:\\Users\\marti\\Documents\\notes.md"] });
		expect(fetchCalled).toBe(false);
	});
});
