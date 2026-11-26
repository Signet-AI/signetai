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

	test("organization sign-in names the organization and offers configured SSO", async () => {
		const { createRoot } = await import("react-dom/client");
		const { SignInScreen } = await import("./sign-in");
		await act(async () => root?.unmount());
		const container = document.createElement("div");
		document.body.replaceChildren(container);
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<SignInScreen
					session={{
						kind: "signed-out",
						mode: "team",
						organizationName: "Acme",
						providers: [
							{ id: "oidc", type: "oidc", enabled: true, label: "Company SSO", startPath: "/api/auth/sso/start" },
						],
						reason: null,
						expired: false,
						renewal: false,
						permissions: [],
					}}
				/>,
			),
		);
		expect(container.textContent).toContain("Acme");
		expect(container.querySelector('a[href="/api/auth/sso/start"]')?.textContent).toBe("Company SSO");
	});

	test("expiry warnings require an authenticated organization session within five minutes", async () => {
		const { sessionExpiryWarning } = await import("./sign-in");
		const now = Date.now();
		const session = {
			kind: "signed-in",
			mode: "team",
			identity: { sub: "usr_alice", name: "Alice", role: "member", expiresAt: now + 60_000 },
			permissions: ["recall"],
			expiresSoon: true,
			whoami: {
				organization: { name: "Acme", agentModel: "personal" },
				user: {
					id: "usr_alice",
					username: "alice",
					displayName: "Alice",
					email: null,
					role: "member",
					compliance: false,
					groups: [],
				},
				agents: { defaultRead: "default", defaultWrite: "alice" },
				credential: { kind: "session", id: "ses_browser", expiresAt: new Date(now + 60_000).toISOString() },
			},
		} as const;
		expect(sessionExpiryWarning(session, "/", now)).toBe(now + 60_000);
		for (const path of ["/auth/login", "/auth/device", "/auth/invite", "/auth/setup", "/auth/claim"])
			expect(sessionExpiryWarning(session, path, now)).toBeNull();
		expect(sessionExpiryWarning({ ...session, whoami: undefined }, "/", now)).toBeNull();
		expect(sessionExpiryWarning({ ...session, mode: "local" }, "/", now)).toBeNull();
		expect(sessionExpiryWarning(session, "/", now + 60_000)).toBeNull();
		expect(sessionExpiryWarning(session, "/", now - 300_000)).toBeNull();
		expect(sessionExpiryWarning({ kind: "open", mode: "local", permissions: null }, "/", now)).toBeNull();
	});

	test("unmounting a session warning removes the toast before sign-in renders", async () => {
		const { createRoot } = await import("react-dom/client");
		const { SessionExpiryToast } = await import("./sign-in");
		const { Toaster } = await import("@/components/ui/sonner");
		const expiry = Date.now() + 60_000;
		const session = {
			kind: "signed-in",
			mode: "team",
			identity: { sub: "usr_alice", name: "Alice", role: "member", expiresAt: expiry },
			permissions: ["recall"],
			expiresSoon: true,
			whoami: {
				organization: { name: "Acme", agentModel: "personal" },
				user: {
					id: "usr_alice",
					username: "alice",
					displayName: "Alice",
					email: null,
					role: "member",
					compliance: false,
					groups: [],
				},
				agents: { defaultRead: "default", defaultWrite: "alice" },
				credential: { kind: "session", id: "ses_browser", expiresAt: new Date(expiry).toISOString() },
			},
		} as const;
		await act(async () => root?.unmount());
		const container = document.createElement("div");
		document.body.replaceChildren(container);
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<>
					<Toaster />
					<SessionExpiryToast session={session} />
				</>,
			),
		);
		await wait(50);
		expect(document.body.textContent).toContain("Your session ends at");
		await act(async () =>
			root?.render(
				<>
					<Toaster />
				</>,
			),
		);
		await wait(50);
		await wait(500);
		expect(document.body.textContent).not.toContain("Your session ends at");
	});

	test("identity menu uses sans text, grouped menu items, and destructive everywhere logout", async () => {
		const { createRoot } = await import("react-dom/client");
		const { SessionChip } = await import("./sign-in");
		const expiry = Date.now() + 600_000;
		const session = {
			kind: "signed-in",
			mode: "team",
			identity: { sub: "usr_alice", name: "Alice", role: "member", expiresAt: expiry },
			permissions: ["recall"],
			expiresSoon: false,
			whoami: {
				organization: { name: "Acme", agentModel: "personal" },
				user: {
					id: "usr_alice",
					username: "alice",
					displayName: "Alice",
					email: null,
					role: "member",
					compliance: false,
					groups: [],
				},
				agents: { defaultRead: "default", defaultWrite: "alice" },
				credential: { kind: "session", id: "ses_browser", expiresAt: new Date(expiry).toISOString() },
			},
		} as const;
		await act(async () => root?.unmount());
		const container = document.createElement("div");
		document.body.replaceChildren(container);
		root = createRoot(container);
		await act(async () => root?.render(<SessionChip session={session} />));
		const trigger = container.querySelector("button");
		expect(trigger?.className).not.toContain("font-mono");
		await act(async () =>
			trigger?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
		);
		await wait(50);
		expect(Array.from(document.querySelectorAll('[role="menuitem"]'), (item) => item.textContent)).toEqual([
			"My account",
			"Devices and connectors",
			"Sign out of this browser",
			"Sign out everywhere",
		]);
		expect(document.querySelectorAll('[role="separator"]').length).toBe(2);
		expect(document.querySelector('[data-variant="destructive"]')?.textContent).toBe("Sign out everywhere");
	});

	const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
	const submit = () => document.querySelector<HTMLButtonElement>("button[type=submit]");
	const alertText = () => document.querySelector("[role=alert]")?.textContent ?? null;

	test("a rate-limited sign-in counts down, then clears and re-enables", async () => {
		await act(async () => root?.unmount());
		document.body.replaceChildren();
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
