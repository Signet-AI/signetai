import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { WorkspaceMigrationCard } from "@/components/workspace/workspace-migration";
import type { DesktopBridge, WorkspaceMigrationUiStatus } from "@/lib/desktop";
import { Window } from "happy-dom";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { installDashboardDomGlobals } from "@/test/dom-globals";

let domWindow: Window;
let restoreDomGlobals = () => {};
let startCalls = 0;
let rollbackCalls = 0;
let status: WorkspaceMigrationUiStatus;

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(placement: "notice" | "settings" = "notice"): Promise<{ container: HTMLElement; root: Root }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(<WorkspaceMigrationCard placement={placement} />);
		await flush();
	});
	return { container, root };
}

function setBridge(): void {
	const bridge: DesktopBridge = {
		openExternal: async () => {},
		getWorkspaceMigrationStatus: async () => status,
		startWorkspaceMigration: async () => {
			startCalls++;
			return { state: "completed" };
		},
		rollbackWorkspaceMigration: async () => {
			rollbackCalls++;
			return { state: "rolled-back" };
		},
	};
	Object.defineProperty(domWindow, "signetDesktop", { configurable: true, value: bridge });
}

beforeAll(() => {
	domWindow = new Window({ url: "http://localhost/" });
	restoreDomGlobals = installDashboardDomGlobals(domWindow);
});

beforeEach(() => {
	startCalls = 0;
	rollbackCalls = 0;
	status = { appVersion: "1.2.3", available: true, state: "available" };
	domWindow.localStorage.clear();
	setBridge();
});

afterAll(() => {
	restoreDomGlobals();
	domWindow.close();
});

test("explains why migration is blocked when another daemon owns the workspace", async () => {
	status = { appVersion: "1.2.3", available: false, state: "blocked", reason: "external-daemon" };
	setBridge();
	const mounted = await mount("settings");
	expect(mounted.container.textContent).toContain("started outside Signet Desktop");
	expect(mounted.container.textContent).toContain("No migration was started");
	expect(mounted.container.querySelector("button")).toBeNull();
	await act(async () => mounted.root.unmount());
	mounted.container.remove();
});

test("explains both environment variables that prevent a persistent desktop cutover", async () => {
	status = { appVersion: "1.2.3", available: false, state: "blocked", reason: "environment-workspace" };
	setBridge();
	const mounted = await mount("settings");
	expect(mounted.container.textContent).toContain("SIGNET_PATH");
	expect(mounted.container.textContent).toContain("SIGNET_WORKSPACE");
	expect(mounted.container.textContent).toContain("cannot persistently change");
	await act(async () => mounted.root.unmount());
	mounted.container.remove();
});

test("offers one-click rollback only for an interrupted migration with a safely owned destination", async () => {
	status = { ...status, state: "interrupted", rollbackAvailable: true };
	setBridge();
	const mounted = await mount("settings");
	const rollback = [...mounted.container.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("Roll back incomplete copy"),
	);
	expect(rollback).toBeDefined();
	await act(async () => {
		rollback?.click();
		await flush();
	});
	expect(rollbackCalls).toBe(1);
	expect(mounted.container.textContent).toContain("The incomplete V2 copy was removed");
	await act(async () => mounted.root.unmount());
	mounted.container.remove();
});

test("the update notice starts migration directly from one click", async () => {
	const mounted = await mount();
	expect(mounted.container.textContent).toContain("Hey, workspace V2 is available.");
	expect(mounted.container.textContent).toContain("Would you like to migrate?");
	const migrate = [...mounted.container.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("Migrate now"),
	);
	expect(migrate).toBeDefined();
	await act(async () => {
		migrate?.click();
		await flush();
	});
	expect(startCalls).toBe(1);
	expect(mounted.container.textContent).toContain("Migration finished");
	await act(async () => mounted.root.unmount());
	mounted.container.remove();
});

test("Later dismisses the update notice until the desktop app version changes", async () => {
	const first = await mount();
	const later = [...first.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Later"));
	await act(async () => {
		later?.click();
		await flush();
	});
	expect(first.container.querySelector('[aria-label="Workspace V2 available"]')).toBeNull();
	await act(async () => first.root.unmount());
	first.container.remove();

	const sameVersion = await mount();
	expect(sameVersion.container.querySelector('[aria-label="Workspace V2 available"]')).toBeNull();
	await act(async () => sameVersion.root.unmount());
	sameVersion.container.remove();

	status = { appVersion: "1.2.4", available: true, state: "available" };
	setBridge();
	const updatedVersion = await mount();
	expect(updatedVersion.container.querySelector('[aria-label="Workspace V2 available"]')).not.toBeNull();
	await act(async () => updatedVersion.root.unmount());
	updatedVersion.container.remove();
});

test("the notice is absent after migration is complete", async () => {
	status = { appVersion: "1.2.3", available: false, state: "completed" };
	setBridge();
	const mounted = await mount();
	expect(mounted.container.querySelector('[aria-label="Workspace V2 available"]')).toBeNull();
	await act(async () => mounted.root.unmount());
	mounted.container.remove();
});
