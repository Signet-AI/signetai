import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
let createRoot: typeof import("react-dom/client").createRoot;
import { installDashboardDomGlobals } from "@/test/dom-globals";
import { api } from "@/lib/api";
import { ConnectProviderDialog } from "./connect-dialog";
let restore = () => {};
let root: Root | undefined;
const originalPut = api.putSecret;
if (!process.env.SIGNET_KEYCHAIN_DIALOG_CHILD) {
	test("provider Keychain recovery browser fixture", () => {
		const result = spawnSync(process.execPath, ["test", import.meta.filename], {
			env: { ...process.env, SIGNET_KEYCHAIN_DIALOG_CHILD: "1" },
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
	}, 25_000);
} else {
	beforeAll(async () => {
		restore = installDashboardDomGlobals(new Window({ url: "http://localhost" }));
		({ createRoot } = await import("react-dom/client"));
	});
	afterAll(() => restore());
	afterEach(async () => {
		await act(async () => root?.unmount());
		root = undefined;
		api.putSecret = originalPut;
		document.body.replaceChildren();
	});
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
	async function mount() {
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<ConnectProviderDialog
					provider={{
						id: "zai",
						name: "ZAI",
						supportsOAuth: false,
						supportsApiKey: true,
						connected: false,
						isOAuth: false,
					}}
					modelCount={7}
					onClose={() => root?.unmount()}
					onSaved={() => {}}
					linkOAuthAccount={() => {}}
					linkApiKeyAccount={() => {}}
					unlinkAccount={() => {}}
				/>,
			);
			await flush();
		});
		const input = document.querySelector("#cp-key") as HTMLInputElement;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "fixture-zai-key");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
		});
	}
	async function click(text: string) {
		const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
		if (!button) throw new Error(`Missing button ${text}: ${document.body.textContent}`);
		await act(async () => {
			button.click();
			await flush();
		});
	}
	test("API-key dialog retains the key across denied consent and cancel without prompting automatically", async () => {
		const writes: { value: string; authorize: boolean }[] = [];
		api.putSecret = async (_name, value, _signal, authorize = false) => {
			writes.push({ value, authorize });
			return {
				ok: false,
				authorizationRequired: true,
				error: "Keychain access has not been granted. Your API key has not been saved.",
			};
		};
		await mount();
		await click("Connect");
		expect(writes).toEqual([{ value: "fixture-zai-key", authorize: false }]);
		expect(document.body.textContent).toContain("Always Allow");
		await click("Authorize and save key");
		expect(writes[1]).toEqual({ value: "fixture-zai-key", authorize: true });
		expect(document.body.textContent).toContain("Authorize and save key");
		await click("Cancel");
		const input = document.querySelector("#cp-key") as HTMLInputElement;
		expect(input.value).toBe("fixture-zai-key");
		expect(input.type).toBe("password");
		expect(writes.length).toBe(2);
	});
	test("closing during consent cancels the save request", async () => {
		let signal: AbortSignal | undefined;
		api.putSecret = async (_name, _value, nextSignal, authorize) => {
			if (!authorize) return { ok: false, authorizationRequired: true };
			signal = nextSignal;
			return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ ok: false }), { once: true }));
		};
		await mount();
		await click("Connect");
		await click("Authorize and save key");
		await act(async () => root?.unmount());
		root = undefined;
		expect(signal?.aborted).toBe(true);
	});
}
