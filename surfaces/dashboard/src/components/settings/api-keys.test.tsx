import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { installDashboardDomGlobals } from "@/test/dom-globals";

if (!process.env.SIGNET_API_KEYS_SECTION_CHILD) {
	test("API keys section browser fixture", () => {
		const result = spawnSync(process.execPath, ["test", import.meta.filename], {
			env: { ...process.env, SIGNET_API_KEYS_SECTION_CHILD: "1" },
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
	}, 25_000);
} else {
	let restore = () => {};
	let root: Root | undefined;
	const originalFetch = globalThis.fetch;
	const keys: Array<Record<string, unknown>> = [];
	const record = (id: string, name: string) => ({
		id,
		prefix: `p${id}`,
		name,
		role: "agent",
		agentId: null,
		connector: null,
		createdAt: "2026-10-01T00:00:00.000Z",
		lastUsedAt: null,
		revokedAt: null,
		expiresAt: null,
	});
	const json = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

	beforeAll(() => {
		restore = installDashboardDomGlobals(new Window({ url: "http://localhost/#settings/api-keys" }));
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		keys.push(record("k1", "alice-laptop"));
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = String(input);
			const method = init?.method ?? "GET";
			if (path === "/api/auth/api-keys" && method === "GET") return json(200, { apiKeys: [...keys] });
			if (path === "/api/auth/api-keys" && method === "POST") {
				const created = record("k2", "bob-desktop");
				keys.unshift(created);
				const body = JSON.stringify({ apiKey: { ...created, key: "sig_sk_bob_secret" } });
				return new Response(
					new ReadableStream({
						start(controller) {
							setTimeout(() => {
								controller.enqueue(new TextEncoder().encode(body));
								controller.close();
							}, 40);
						},
					}),
					{ status: 201, headers: { "Content-Type": "application/json" } },
				);
			}
			return json(404, { error: "not found" });
		}) as typeof fetch;
	});
	afterAll(async () => {
		await act(async () => root?.unmount());
		globalThis.fetch = originalFetch;
		restore();
	});

	const settle = async () => {
		for (let i = 0; i < 5; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
	};
	const rows = (name: string) =>
		[...document.querySelectorAll("li")].filter((li) => li.textContent?.includes(name)).length;
	const button = (label: string) =>
		[...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);

	test("a created key is listed once even when the list refreshes before the response body arrives", async () => {
		const { createRoot } = await import("react-dom/client");
		const { ApiKeysSection } = await import("./api-keys");
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => root?.render(<ApiKeysSection />));
		await settle();
		expect(rows("alice-laptop")).toBe(1);

		const name = document.querySelector<HTMLInputElement>("#api-key-name");
		if (!name) throw new Error("name field missing");
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
			setter?.call(name, "bob-desktop");
			name.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		await act(async () => button("Create key")?.click());
		await settle();

		expect(document.querySelector("code.select-all")?.textContent).toBe("sig_sk_bob_secret");
		expect(rows("bob-desktop")).toBe(1);
		expect(document.body.innerHTML.split("sig_sk_bob_secret").length - 1).toBe(1);
	});
}
