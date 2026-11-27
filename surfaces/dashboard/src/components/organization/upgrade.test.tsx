import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { UpgradeInventory, UpgradeJob } from "@/lib/organization-upgrade";

if (!process.env.SIGNET_UPGRADE_UI_TEST_CHILD) {
	test("organization upgrade browser fixture", () => {
		const child = spawnSync(process.execPath, ["test", import.meta.filename], {
			env: { ...process.env, SIGNET_UPGRADE_UI_TEST_CHILD: "1", TZ: "UTC" },
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(child.status, child.stdout + child.stderr).toBe(0);
	}, 25_000);
} else {
	const dom = new Window({ url: "http://localhost/" });
	const originalFetch = globalThis.fetch;
	let createRoot: typeof import("react-dom/client").createRoot;
	let UpgradeWizard: typeof import("./upgrade").UpgradeWizard;
	let dates: typeof import("@/lib/organization-upgrade");
	const requests: Array<{ path: string; method: string; body: unknown }> = [];
	const inventory: UpgradeInventory = {
		agents: [{ id: "old-agent", name: "Existing agent" }],
		keys: [{ id: "key-old", name: "Existing connector", prefix: "123456", agentId: "old-agent" }],
		users: [{ id: "alice", name: "Alice" }],
		groups: [{ id: "eng", name: "Engineering" }],
		legacyKeyDeadline: "2030-01-01T00:00:00.000Z",
		jobs: [],
	};
	const job: UpgradeJob = {
		id: "job-upgrade",
		revision: "revision-1",
		status: "pending",
		phase: "draft",
		preview: {
			agents: [
				{
					agentId: "old-agent",
					name: "Existing agent",
					kind: "organization",
					ownerUserId: null,
					ownerGroupId: null,
					fallback: true,
				},
			],
			keys: [
				{
					id: "key-old",
					name: "Existing connector",
					prefix: "123456",
					agentId: "old-agent",
					action: "keep-unassigned",
					userId: null,
				},
			],
			legacyKeyDeadline: "2030-01-01T00:00:00.000Z",
			organizationAgentId: "default",
			evidencePolicy: "preserve-agent-ids-and-evidence",
			retainedStorePolicy:
				"Keep imported stores without rewriting evidence. Only explicitly targeted administrator writes are allowed.",
		},
		appliedPlan: null,
		completedSteps: 0,
		totalSteps: 2,
		error: null,
	};
	beforeAll(async () => {
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		Reflect.set(globalThis, "Event", dom.Event);
		for (const key of Object.getOwnPropertyNames(dom))
			if (!(key in globalThis)) Reflect.set(globalThis, key, Reflect.get(dom, key));
		({ createRoot } = await import("react-dom/client"));
		({ UpgradeWizard } = await import("./upgrade"));
		dates = await import("@/lib/organization-upgrade");
		globalThis.fetch = async (input, init) => {
			const path = String(input);
			const method = init?.method ?? "GET";
			const body = init?.body ? JSON.parse(String(init.body)) : null;
			requests.push({ path, method, body });
			if (path === "/api/auth/whoami") return Response.json({ mode: "local", effectiveAccess: true });
			if (path === "/api/org/upgrade/preview") return Response.json(job);
			if (path === "/api/org/upgrade/job-upgrade" && method === "PUT")
				return Response.json({ ...job, revision: "revision-2" });
			if (path === "/api/org/upgrade/job-upgrade/confirm")
				return Response.json({ ...job, revision: "revision-2", status: "running", phase: "applying" });
			if (path === "/api/org/upgrade/job-upgrade")
				return Response.json({
					...job,
					revision: "revision-2",
					status: "complete",
					phase: "complete",
					completedSteps: 2,
					appliedPlan: job.preview,
				});
			throw new Error(`Unexpected request ${method} ${path}`);
		};
	});
	afterAll(() => {
		globalThis.fetch = originalFetch;
		dom.close();
	});
	test("upgrade deadline conversion rejects invalid values and preserves explicit UTC", () => {
		expect(dates.upgradeDeadlineInput("2030-01-01T00:00:00.000Z")).toBe("2030-01-01T00:00");
		expect(dates.upgradeDeadline("2030-01-01T00:00")).toBe("2030-01-01T00:00:00.000Z");
		expect(dates.upgradeDeadline("not a date")).toBeNull();
	});
	test("imported organization stores advertise explicit administrator writes rather than every-user act-as", async () => {
		const { AgentsContent } = await import("./agents");
		const element = document.createElement("div");
		document.body.append(element);
		const root = createRoot(element);
		try {
			await act(async () =>
				root.render(
					<AgentsContent
						agents={[
							{
								id: "retained",
								name: "Original (imported)",
								kind: "organization",
								ownerUserId: null,
								ownerGroupId: null,
								archivedAt: null,
								canActAs: false,
							},
						]}
						groups={[]}
						users={[]}
						refresh={() => {}}
					/>,
				),
			);
			expect(element.textContent).toContain("Original (imported)");
			expect(element.textContent).toContain("Organization");
			expect(element.textContent).toContain("Administrator · explicit target only");
			expect(element.textContent).not.toContain("Every active user");
		} finally {
			await act(async () => root.unmount());
			element.remove();
		}
	});
	test("upgrade edits are reversible and confirmation submits only the reviewed server revision", async () => {
		const element = document.createElement("div");
		document.body.append(element);
		const root = createRoot(element);
		const click = async (text: string) => {
			const button = [...element.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
			expect(button, text).toBeDefined();
			await act(async () => button?.click());
		};
		try {
			await act(async () => root.render(<UpgradeWizard inventory={inventory} onClose={() => {}} />));
			expect(element.textContent).toContain("Map existing agents");
			await click("Continue");
			expect(element.textContent).toContain("Unowned API keys");
			await click("Continue");
			expect(element.textContent).toContain("Legacy key deadline");
			expect(requests.filter((request) => request.method !== "GET")).toHaveLength(0);
			await click("Review dry run");
			expect(element.textContent).toContain("Review upgrade");
			expect(element.textContent).toContain("Only explicitly targeted administrator writes are allowed.");
			expect(element.textContent).toContain("Unmapped");
			expect(requests).toContainEqual({
				path: "/api/org/upgrade/preview",
				method: "POST",
				body: { mappings: [], keys: [], legacyKeyDeadline: "2030-01-01T00:00:00.000Z" },
			});
			await click("Back to edit");
			await click("Continue");
			await click("Continue");
			await click("Review dry run");
			expect(
				requests.some((request) => request.path === "/api/org/upgrade/job-upgrade" && request.method === "PUT"),
			).toBe(true);
			expect(
				[...element.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Confirm upgrade")
					?.disabled,
			).toBe(true);
			const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]');
			await act(async () => checkbox?.click());
			await click("Confirm upgrade");
			expect(requests).toContainEqual({
				path: "/api/org/upgrade/job-upgrade/confirm",
				method: "POST",
				body: { revision: "revision-2" },
			});
			await act(async () => {
				await Bun.sleep(600);
			});
			expect(element.textContent).toContain("Upgrade complete");
		} finally {
			await act(async () => root.unmount());
			element.remove();
		}
	});
}
