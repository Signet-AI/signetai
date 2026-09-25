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

test("workspace imports, migration, and recovery live under Workspace settings", async () => {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	await act(async () => {
		root.render(<WorkspaceSettingsSection />);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	expect(container.querySelector('[aria-label="Workspace settings"]')).not.toBeNull();
	expect(container.querySelector('[aria-label="Workspace V2 migration"]')).not.toBeNull();
	expect(container.querySelector('[aria-label="Protection recovery"]')).not.toBeNull();
	expect(container.textContent).toContain("Durable imports");

	await act(async () => root.unmount());
	container.remove();
});
