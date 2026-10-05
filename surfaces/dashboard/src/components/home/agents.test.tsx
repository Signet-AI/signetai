import { beforeEach as beforeDashboardFixture } from "bun:test";
import { dashboardQueryCache } from "@/lib/query-cache";
beforeDashboardFixture(() => dashboardQueryCache.clear(false, false));

import { afterAll, beforeAll, test, expect } from "bun:test";
import { Window } from "happy-dom";
import { installDashboardDomGlobals } from "@/test/dom-globals";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { api, type Agent } from "@/lib/api";
import { HomeAgentsPanel } from "./agents";

const getAgents = api.getAgents;
const getIdentity = api.getIdentity;
let restoreDomGlobals = () => {};

beforeAll(() => {
	restoreDomGlobals = installDashboardDomGlobals(new Window());
	api.getIdentity = async () => null;
});
afterAll(() => {
	restoreDomGlobals();
	api.getAgents = getAgents;
	api.getIdentity = getIdentity;
});

test("Manage opens and focuses an editable agent, not every disclosure", async () => {
	api.getAgents = async () => ({
		data: {
			agents: [
				{ id: "default-id", name: "default", read_policy: "shared" },
				{ id: "editor-id", name: "editor", read_policy: "isolated" },
			] as Agent[],
		},
		error: undefined,
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(<HomeAgentsPanel />);
		});
		const manage = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Manage"));
		expect(manage).toBeDefined();
		await act(async () => {
			manage?.click();
		});
		const rows = container.querySelectorAll("details");
		expect(rows[0].open).toBe(false);
		expect(rows[1].open).toBe(true);
		expect(document.activeElement).toBe(container.querySelector('select[aria-label="Memory policy for editor"]'));
		expect(container.textContent).toContain("Review change");
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});

test("daemon-managed-only roster does not advertise an unavailable Manage action", async () => {
	api.getAgents = async () => ({
		data: { agents: [{ id: "default-id", name: "default", read_policy: "shared" }] as Agent[] },
		error: undefined,
	});
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(<HomeAgentsPanel />);
		});
		expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Manage"))).toBe(
			false,
		);
		expect(container.querySelector("button:disabled")).toBeNull();
	} finally {
		await act(async () => root.unmount());
	}
});
