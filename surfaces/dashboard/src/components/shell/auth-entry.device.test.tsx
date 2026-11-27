import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { installDashboardDomGlobals } from "@/test/dom-globals";
import { DeviceApprovalPage } from "./auth-entry";

test("L4 device approval labels client and device name as self-declared", async () => {
	const window = new Window({ url: "http://localhost:3860/auth/device?user_code=ABCD-EFGH" });
	const restore = installDashboardDomGlobals(window);
	const savedFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async () =>
			Response.json({
				client: "desktop",
				deviceName: "Signet Desktop",
				platform: "linux",
				createdAt: "2026-11-26T12:00:00Z",
			}),
		{ preconnect: savedFetch.preconnect },
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => {
			root.render(createElement(DeviceApprovalPage));
		});
		await act(async () => {
			host.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(host.textContent).toContain("Requested by a device calling itself");
		expect(host.textContent).toContain("Signet Desktop");
		expect(host.textContent).toContain("self-declared");
		expect(host.textContent).toContain("desktop");
	} finally {
		await act(async () => root.unmount());
		host.remove();
		globalThis.fetch = savedFetch;
		restore();
	}
});
