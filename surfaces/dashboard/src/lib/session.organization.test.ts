import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installDashboardDomGlobals } from "@/test/dom-globals";

if (!process.env.SIGNET_ORG_SESSION_CHILD) {
	test("organization cookie session fixture", () => {
		const result = spawnSync(process.execPath, ["test", import.meta.filename], {
			env: { ...process.env, SIGNET_ORG_SESSION_CHILD: "1" },
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
	}, 25_000);
} else {
	let restore = () => {};
	let session: typeof import("./session");
	const originalFetch = globalThis.fetch;
	const calls: { path: string; init?: RequestInit }[] = [];
	let authenticated = true;
	const expiresAt = new Date(Date.now() + 600_000).toISOString();
	beforeAll(async () => {
		restore = installDashboardDomGlobals(new Window({ url: "https://org.example/" }));
		document.cookie = "__Host-signet_csrf=csrf-secret; Secure; Path=/";
		localStorage.setItem("signet-token", "obsolete-secret");
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = String(input);
			calls.push({ path, init });
			if (path === "/api/auth/logout") authenticated = false;
			if (path === "/api/auth/login") authenticated = true;
			return Response.json(
				path === "/api/auth/whoami"
					? {
							mode: "team",
							authenticated,
							effectiveAccess: authenticated ? "authenticated" : "none",
							organization: { name: "Acme", agentModel: "personal" },
							user: authenticated
								? {
										id: "usr_alice",
										username: "alice",
										displayName: "Alice",
										email: "alice@example.org",
										role: "member",
										compliance: false,
										groups: [],
									}
								: null,
							credential: authenticated
								? { id: "ses_browser", kind: "session", expiresAt, deviceId: null, harness: null }
								: null,
							agents: { defaultRead: "default", defaultWrite: "alice" },
							permissions: ["recall"],
							providers: [{ id: "password" }],
						}
					: { expiresAt, csrf: "csrf-secret" },
			);
		}) as typeof fetch;
		session = await import("./session");
	});
	afterAll(() => {
		globalThis.fetch = originalFetch;
		restore();
	});
	test("reads organization identity instead of legacy token claims", async () => {
		await session.startSession();
		const state = session.currentSession();
		expect(state.kind).toBe("signed-in");
		if (state.kind !== "signed-in") return;
		expect(state.identity).toEqual({
			sub: "usr_alice",
			name: "Alice",
			role: "member",
			expiresAt: Date.parse(expiresAt),
		});
		expect(session.can(state, "admin")).toBe(false);
	});
	test("uses cookies, removes obsolete storage and sends CSRF", () => {
		expect(localStorage.getItem("signet-token")).toBeNull();
		expect(new Headers(session.authHeaders()).get("Authorization")).toBeNull();
		expect(new Headers(session.authHeaders()).get("x-signet-csrf")).toBe("csrf-secret");
		expect(calls.find((call) => call.path === "/api/auth/whoami")?.init?.credentials).toBe("same-origin");
	});
	test("logs out everywhere on the daemon then returns to sign-in", async () => {
		await session.signOut(true);
		const call = calls.find((entry) => entry.path === "/api/auth/logout");
		expect(JSON.parse(String(call?.init?.body))).toEqual({ all: true });
		expect(new Headers(call?.init?.headers).get("x-signet-csrf")).toBe("csrf-secret");
		expect(session.currentSession().kind).toBe("signed-out");
	});
	test("password login adopts the cookie without a returned bearer", async () => {
		expect(await session.signInWithPassword("alice", "password")).toEqual({ ok: true });
		expect(localStorage.getItem("signet-token")).toBeNull();
	});
	test("content reads follow agent context without rewriting mutations", async () => {
		const { getJSONResult } = await import("./api");
		const { selectAgent } = await import("./agent-context");
		const { scopedQueryKey } = await import("./query-cache");
		const before = scopedQueryKey("memories");
		selectAgent("eng-agent");
		expect(scopedQueryKey("memories")).not.toBe(before);
		await getJSONResult("/api/dream/status?agent_id=default");
		expect(calls.at(-1)?.path).toBe("/api/dream/status?agentId=eng-agent");
		await getJSONResult("/api/agents");
		expect(calls.at(-1)?.path).toBe("/api/agents");
		await getJSONResult("/api/memory/remember", { method: "POST", body: JSON.stringify({ agentId: "named-target" }) });
		expect(calls.at(-1)?.init?.body).toBe(JSON.stringify({ agentId: "named-target" }));
	});

	test("organization permission checks fail closed when identity is unavailable", () => {
		expect(session.can({ kind: "checking" }, "admin")).toBe(false);
		expect(session.can({ kind: "unreachable", error: "offline" }, "admin")).toBe(false);
	});
}
