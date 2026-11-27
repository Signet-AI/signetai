import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Whoami } from "@/lib/session";

const whoami: Whoami = {
	organization: { name: "Acme", agentModel: "personal" },
	user: {
		id: "alice",
		username: "alice",
		displayName: "Alice",
		email: null,
		role: "member",
		compliance: false,
		groups: [{ id: "eng", name: "Engineering", role: "member" }],
	},
	agents: { defaultRead: "default", defaultWrite: "personal-alice" },
	credential: { id: "session-alice", kind: "session", expiresAt: null },
};
if (!process.env.SIGNET_MEMBER_ONBOARDING_TEST_CHILD) {
	test("member onboarding browser fixture", () => {
		const result = spawnSync(process.execPath, ["test", import.meta.filename], {
			env: { ...process.env, SIGNET_MEMBER_ONBOARDING_TEST_CHILD: "1" },
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
	}, 25_000);
} else {
	const dom = new Window({ url: "http://localhost/" });
	const originalFetch = globalThis.fetch;
	let createRoot: typeof import("react-dom/client").createRoot;
	let MemberOnboarding: typeof import("./member").MemberOnboarding;
	let OrganizationOnboardingGate: typeof import("./member").OrganizationOnboardingGate;
	let OnboardingEntry: typeof import("./entry").OnboardingEntry;
	const calls: string[] = [];
	let failAcknowledgement = true;
	let connectorUsed = false;
	let firstMemory = false;
	let completed = 0;
	const bodies: Array<{ path: string; body: unknown }> = [];
	beforeAll(async () => {
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		Reflect.set(globalThis, "Event", dom.Event);
		for (const key of Object.getOwnPropertyNames(dom))
			if (!(key in globalThis)) Reflect.set(globalThis, key, Reflect.get(dom, key));
		({ createRoot } = await import("react-dom/client"));
		({ MemberOnboarding, OrganizationOnboardingGate } = await import("./member"));
		({ OnboardingEntry } = await import("./entry"));
		globalThis.fetch = async (input, init) => {
			const path = String(input);
			calls.push(`${init?.method ?? "GET"} ${path}`);
			if (init?.body) bodies.push({ path, body: JSON.parse(String(init.body)) });
			if (path === "/api/auth/whoami") return Response.json({ mode: "local", effectiveAccess: true });
			if (path === "/api/classifications") return Response.json([]);
			if (path === "/api/auth/profile")
				return Response.json({ editableFields: ["displayName", "email"], user: whoami.user });
			if (path === "/api/memory/remember") return Response.json({ id: "about-alice" });
			if (path === "/api/auth/connector-keys")
				return Response.json({
					keys: [
						{
							id: "connector-alice",
							harness: "codex",
							last_used_at: connectorUsed ? new Date().toISOString() : null,
							revoked_at: null,
						},
					],
				});
			if (path.startsWith("/api/memories?")) {
				expect(path).toContain("agentId=personal-alice");
				expect(path).toContain("author=alice");
				return Response.json({
					memories: firstMemory
						? [{ id: "harness-first", content: "Remembered through my harness", created_at: new Date().toISOString() }]
						: [],
				});
			}
			if (path === "/api/auth/onboarding") {
				if (!init?.method || init.method === "GET")
					return Response.json({ version: "organization-visibility-v1", acknowledged: false, complete: false });
				if (JSON.parse(String(init?.body)).action === "complete")
					return Response.json({ version: "organization-visibility-v1", acknowledged: true, complete: true });
				expect(JSON.parse(String(init?.body))).toEqual({
					action: "acknowledge",
					version: "organization-visibility-v1",
				});
				return failAcknowledgement
					? Response.json({ error: "Cannot record acknowledgement" }, { status: 503 })
					: Response.json({ version: "organization-visibility-v1", acknowledged: true, complete: false });
			}
			if (path === "/api/agents")
				return Response.json({
					agents: [
						{ id: "personal-alice", name: "Alice", kind: "personal", ownerUserId: "alice", canActAs: true },
						{ id: "team-eng", name: "Engineering", kind: "team", ownerGroupId: "eng", canActAs: true },
						{ id: "team-hr", name: "HR", kind: "team", ownerGroupId: "hr", canActAs: false },
						{ id: "default", name: "Organization", kind: "organization", canActAs: true },
					],
				});
			throw new Error(`Unexpected request: ${path}`);
		};
	});
	beforeEach(() => {
		calls.length = 0;
		bodies.length = 0;
		connectorUsed = false;
		firstMemory = false;
		completed = 0;
		failAcknowledgement = true;
	});
	afterAll(() => {
		globalThis.fetch = originalFetch;
		dom.close();
	});
	test("three-way entry preserves the personal flow and keeps remote setup explicit", async () => {
		const element = document.createElement("div");
		document.body.append(element);
		const root = createRoot(element);
		const click = async (text: string) => {
			const button = [...element.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
			expect(button).toBeDefined();
			await act(async () => button?.click());
		};
		try {
			await act(async () => root.render(<OnboardingEntry personal={<p>Unchanged nine-step personal flow</p>} />));
			expect(element.textContent).toContain("Personal workspace");
			expect(element.textContent).toContain("Join an organization");
			expect(element.textContent).toContain("Host an organization instance");
			await click("Join an organization");
			expect(element.textContent).toContain("signet setup --join");
			expect(element.textContent).toContain("Your local workspace is never replaced");
			await click("Back");
			await click("Host an organization instance");
			expect(element.textContent).toContain("signet setup --host");
			expect(element.textContent).toContain("hybrid");
			await click("Back");
			await click("Personal workspace");
			expect(element.textContent).toBe("Unchanged nine-step personal flow");
			expect(calls).toEqual([]);
		} finally {
			await act(async () => root.unmount());
			element.remove();
		}
	});
	test("local mode bypasses organization onboarding without making a request", async () => {
		const element = document.createElement("div");
		document.body.append(element);
		const root = createRoot(element);
		try {
			await act(async () =>
				root.render(
					<OrganizationOnboardingGate whoami={null}>
						<p>Existing personal onboarding</p>
					</OrganizationOnboardingGate>,
				),
			);
			expect(element.textContent).toBe("Existing personal onboarding");
			expect(calls).toEqual([]);
			await act(async () =>
				root.render(
					<OrganizationOnboardingGate whoami={whoami}>
						<p>Dashboard must wait</p>
					</OrganizationOnboardingGate>,
				),
			);
			expect(element.textContent).toContain("What's shared");
			expect(element.textContent).not.toContain("Dashboard must wait");
		} finally {
			await act(async () => root.unmount());
			element.remove();
		}
	});
	test("member profile is per-user and connector plus first-memory confirmation refresh live", async () => {
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
					<MemberOnboarding
						whoami={whoami}
						status={{ version: "organization-visibility-v1", acknowledged: true, complete: false }}
						onComplete={() => {
							completed++;
						}}
					/>,
				),
			);
			await click("Continue");
			expect(element.textContent).toContain("About you");
			const preferences = element.querySelector("textarea");
			expect(preferences).not.toBeNull();
			await act(async () => {
				Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")?.set?.call(
					preferences,
					"I prefer TypeScript",
				);
				preferences?.dispatchEvent(new dom.Event("input", { bubbles: true }));
			});
			await click("Save and continue");
			expect(bodies).toContainEqual({
				path: "/api/memory/remember",
				body: { content: "I prefer TypeScript", agentId: "personal-alice", type: "fact" },
			});
			expect(element.textContent).toContain("Connect your harnesses");
			expect(element.textContent).toContain("signet login");
			expect(element.textContent).toContain("signet connect");
			expect(
				[...element.querySelectorAll("button")].find((button) => button.textContent === "Continue")?.disabled,
			).toBe(true);
			connectorUsed = true;
			await act(async () => {
				await Bun.sleep(2200);
			});
			expect(element.textContent).toContain("Connected");
			await click("Continue");
			expect(element.textContent).toContain("First memory");
			expect(element.textContent).toContain("Skip for now");
			expect(element.textContent).not.toContain("Remembered through my harness");
			firstMemory = true;
			await act(async () => {
				await Bun.sleep(2200);
			});
			expect(element.textContent).toContain("Remembered through my harness");
			await click("Continue");
			expect(element.textContent).toContain("Summary");
			expect(element.querySelector('section[aria-label="Copy personal memories"]')).not.toBeNull();
			await click("Open dashboard");
			expect(completed).toBe(1);
			expect(bodies).toContainEqual({ path: "/api/auth/onboarding", body: { action: "complete" } });
		} finally {
			await act(async () => root.unmount());
			element.remove();
		}
	});
	test("visibility acknowledgement cannot be skipped or accepted only in the browser", async () => {
		const element = document.createElement("div");
		document.body.append(element);
		const root = createRoot(element);
		const click = async (text: string) => {
			const button = [...element.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
			expect(button).toBeDefined();
			await act(async () => {
				button?.click();
			});
		};
		try {
			await act(async () => {
				root.render(
					<MemberOnboarding
						whoami={whoami}
						status={{ version: "organization-visibility-v1", acknowledged: false, complete: false }}
						onComplete={() => {}}
					/>,
				);
			});
			expect(element.textContent).toContain("What's shared");
			expect(element.textContent).toContain("The organization can read it unless it's hidden");
			expect(element.textContent).not.toContain("Skip");
			expect(calls).toEqual([]);
			const next = [...element.querySelectorAll("button")].find((item) => item.textContent?.includes("I understand"));
			expect(next?.disabled).toBe(true);
			const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]');
			expect(checkbox).not.toBeNull();
			await act(async () => {
				checkbox?.click();
			});
			await click("I understand — continue");
			expect(element.textContent).toContain("Cannot record acknowledgement");
			expect(element.textContent).toContain("What's shared");
			failAcknowledgement = false;
			await click("I understand — continue");
			expect(element.textContent).toContain("Your agents");
			expect(element.textContent).toContain("Engineering");
			expect(element.textContent).not.toContain("HR");
			expect(element.textContent).not.toContain("Connection");
			expect(element.textContent).not.toContain("Search");
		} finally {
			await act(async () => root.unmount());
			element.remove();
		}
	});
}
