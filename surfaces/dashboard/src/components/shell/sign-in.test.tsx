import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { installDashboardDomGlobals } from "@/test/dom-globals";

if (!process.env.SIGNET_SIGN_IN_FORM_CHILD) {
	test("sign-in form browser fixture", () => {
		const result = spawnSync(process.execPath, ["test", import.meta.filename], {
			env: { ...process.env, SIGNET_SIGN_IN_FORM_CHILD: "1" },
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
	}, 25_000);
} else {
	let restore = () => {};
	let root: Root | undefined;
	const originalFetch = globalThis.fetch;

	beforeAll(() => {
		restore = installDashboardDomGlobals(new Window({ url: "http://localhost/" }));
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "rate limit exceeded" }), {
				status: 429,
				headers: { "Content-Type": "application/json", "Retry-After": "1" },
			})) as typeof fetch;
	});
	afterAll(async () => {
		await act(async () => root?.unmount());
		globalThis.fetch = originalFetch;
		restore();
	});

	const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
	const submit = () => document.querySelector<HTMLButtonElement>("button[type=submit]");
	const alertText = () => document.querySelector("[role=alert]")?.textContent ?? null;

	test("a rate-limited sign-in counts down, then clears and re-enables", async () => {
		const { createRoot } = await import("react-dom/client");
		const { SignInScreen } = await import("./sign-in");
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<SignInScreen
					session={{
						kind: "signed-out",
						mode: "team",
						providers: [{ id: "password", type: "password", enabled: true, username: "owner" }],
						reason: null,
						expired: false,
						renewal: false,
						permissions: null,
					}}
				/>,
			),
		);
		const password = document.querySelector<HTMLInputElement>("#signet-sign-in-password");
		if (!password) throw new Error("password field missing");
		await act(async () => {
			Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(password, "nope");
			password.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		await act(async () => submit()?.click());
		await wait(50);

		expect(alertText()).toBe("Too many attempts. Try again in 1s.");
		expect(submit()?.disabled).toBe(true);

		await wait(1_300);
		expect(alertText()).toBeNull();
		expect(submit()?.disabled).toBe(false);
	});
}
