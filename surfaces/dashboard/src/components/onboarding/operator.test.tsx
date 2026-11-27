import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";

if (!process.env.SIGNET_OPERATOR_UI_CHILD) {
	test("operator wizard browser fixture", () => {
		const child = spawnSync(process.execPath, ["test", import.meta.filename], {
			env: { ...process.env, SIGNET_OPERATOR_UI_CHILD: "1" },
			encoding: "utf8",
			timeout: 20000,
		});
		expect(child.status, child.stdout + child.stderr).toBe(0);
	}, 25000);
} else {
	const dom = new Window({ url: "http://localhost/" });
	const originalFetch = globalThis.fetch;
	let createRoot: typeof import("react-dom/client").createRoot;
	let OperatorWizard: typeof import("./operator").OperatorWizard;
	const settings = {
		inference: { provider: "none" as const, model: "", endpoint: null, credentialRef: null, allowRemote: false },
		embedding: { provider: "none" as const, model: "", dimensions: 768, endpoint: null, credentialRef: null },
		instructions: "Company conventions",
		sourcesDefaults: { agentId: "default", classificationId: null },
		complete: false,
	};
	let completed = false;
	const writes: unknown[] = [];
	beforeAll(async () => {
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		for (const key of Object.getOwnPropertyNames(dom))
			if (!(key in globalThis)) Reflect.set(globalThis, key, Reflect.get(dom, key));
		({ createRoot } = await import("react-dom/client"));
		({ OperatorWizard } = await import("./operator"));
		globalThis.fetch = async (input, init) => {
			const path = String(input);
			if (path === "/api/auth/whoami") return Response.json({ mode: "local", effectiveAccess: true });
			if (path === "/api/org/operator/settings") {
				if (init?.method === "PATCH") writes.push(JSON.parse(String(init.body)));
				return Response.json({
					...settings,
					complete: writes.some(
						(value) => value !== null && typeof value === "object" && Reflect.get(value, "section") === "complete",
					),
				});
			}
			if (path === "/api/org/settings") return Response.json({ name: "Acme", passwordLogin: true, oidc: null });
			if (path === "/api/org/groups") return Response.json({ groups: [] });
			if (path === "/api/classifications") return Response.json([]);
			if (path === "/api/sources") return Response.json({ sources: [] });
			if (path === "/api/secrets") return Response.json({ secrets: [] });
			if (path === "/api/agents")
				return Response.json({ agents: [{ id: "default", name: "Organization", canActAs: true }] });
			throw new Error(`Unexpected request ${path}`);
		};
	});
	afterAll(() => {
		globalThis.fetch = originalFetch;
		dom.close();
	});
	test("operator sequence saves constrained settings and omits server harness and sample-memory steps", async () => {
		const element = document.createElement("div");
		document.body.append(element);
		const root = createRoot(element);
		const click = async (text: string) => {
			const button = [...element.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
			expect(button, text).toBeDefined();
			await act(async () => button?.click());
		};
		try {
			await act(async () =>
				root.render(
					<OperatorWizard
						settings={settings}
						organizationName="Acme"
						onComplete={() => {
							completed = true;
						}}
					/>,
				),
			);
			for (const title of [
				"Organization",
				"Connection",
				"Search",
				"Organization instructions",
				"Teams and classifications",
				"Sources",
				"Invite people",
				"Summary",
			]) {
				expect(element.querySelector("h1")?.textContent).toBe(title);
				expect(element.textContent).not.toContain("First memory");
				expect(element.querySelector('section[aria-label="Harnesses"]')).toBeNull();
				await click(title === "Summary" ? "Finish instance setup" : "Save and continue");
			}
			expect(writes).toContainEqual({ section: "instructions", value: "Company conventions" });
			expect(writes).toContainEqual({ section: "complete", value: true });
			expect(completed).toBe(true);
		} finally {
			await act(async () => root.unmount());
			element.remove();
		}
	});
}
