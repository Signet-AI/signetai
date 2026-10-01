import { afterAll, beforeAll, expect, test } from "bun:test";
import { WorkspaceSettingsSection } from "@/components/workspace/workspace-settings-section";
import { Window } from "happy-dom";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { installDashboardDomGlobals } from "@/test/dom-globals";

let domWindow: Window;
let restoreDomGlobals = () => {};
const originalFetch = globalThis.fetch;

beforeAll(() => {
	domWindow = new Window({ url: "http://localhost/" });
	restoreDomGlobals = installDashboardDomGlobals(domWindow);
	Object.defineProperty(domWindow, "signetDesktop", { configurable: true, value: undefined });
	globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	restoreDomGlobals();
	domWindow.close();
});

test("storage, imports, and recovery remain visible without desktop-only migration actions", async () => {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	await act(async () => {
		root.render(<WorkspaceSettingsSection />);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	expect(container.querySelector('[aria-label="Data & files settings"]')).not.toBeNull();
	expect(container.querySelector('[aria-label="Storage update details"]')).toBeNull();
	expect(container.textContent).toContain("Storage location");
	expect(container.querySelector('[aria-label="Protection recovery"]')).not.toBeNull();
	expect(container.textContent).toContain("File imports");

	await act(async () => root.unmount());
	container.remove();
});
