import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Permission, TokenRole, TokenScope } from "../auth";

const previousSignetPath = process.env.SIGNET_PATH;
let agentsDir: string;
let appFactory: typeof import("hono").Hono;
let createAuthMiddleware: typeof import("../auth").createAuthMiddleware;
let createToken: typeof import("../auth").createToken;
let registerSessionRoutes: typeof import("./session-routes").registerSessionRoutes;
let registerHooksRoutes: typeof import("./hooks-routes").registerHooksRoutes;
let initDbAccessor: typeof import("../db-accessor").initDbAccessor;
let closeDbAccessor: typeof import("../db-accessor").closeDbAccessor;
let presence: typeof import("../cross-agent");
let tracker: typeof import("../session-tracker");
let state: typeof import("./state.js");

function writeAuthConfig(mode: "local" | "team"): void {
	writeFileSync(
		join(agentsDir, "agent.yaml"),
		`auth:\n  mode: ${mode}\n  rateLimits:\n    forget:\n      windowMs: 60000\n      max: 30\n    modify:\n      windowMs: 60000\n      max: 60\n    batchForget:\n      windowMs: 60000\n      max: 5\n    admin:\n      windowMs: 60000\n      max: 10\n    recallLlm:\n      windowMs: 60000\n      max: 60\n`,
	);
}

function teamApp(): Hono {
	if (!state.authSecret) throw new Error("expected auth secret in team mode");
	const app = new appFactory();
	app.use("*", createAuthMiddleware(state.authConfig, state.authSecret));
	registerSessionRoutes(app, {
		gitConfig: {
			enabled: false,
			autoCommit: false,
			autoSync: false,
			syncInterval: 300,
			remote: "origin",
			branch: "main",
		},
		stopGitSyncTimer: async () => {},
		startGitSyncTimer: () => {},
		getGitStatus: async () => ({}),
		gitPull: async () => ({}),
		gitPush: async () => ({}),
		gitSync: async () => ({}),
	});
	registerHooksRoutes(app);
	return app;
}

function bearer(
	role: TokenRole,
	options: { readonly scope?: TokenScope; readonly permissions?: readonly Permission[] } = {},
): Record<string, string> {
	if (!state.authSecret) throw new Error("expected auth secret");
	const token = createToken(
		state.authSecret,
		{
			sub: `session-control-${role}`,
			role,
			scope: options.scope ?? { agent: "agent-a" },
			...(options.permissions ? { permissions: options.permissions } : {}),
		},
		60,
	);
	return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

beforeAll(async () => {
	agentsDir = mkdtempSync(join(tmpdir(), "signet-session-control-"));
	mkdirSync(join(agentsDir, "memory"), { recursive: true });
	mkdirSync(join(agentsDir, ".daemon"), { recursive: true });
	writeFileSync(join(agentsDir, ".daemon", "auth-secret"), "test-secret-key-32-bytes-min!!!!");
	process.env.SIGNET_PATH = agentsDir;
	appFactory = (await import("hono")).Hono;
	({ createAuthMiddleware, createToken } = await import("../auth"));
	({ registerSessionRoutes } = await import("./session-routes"));
	({ registerHooksRoutes } = await import("./hooks-routes"));
	({ initDbAccessor, closeDbAccessor } = await import("../db-accessor"));
	presence = await import("../cross-agent");
	tracker = await import("../session-tracker");
	state = await import("./state.js");
	initDbAccessor(join(agentsDir, "memory", "memories.db"));
	writeAuthConfig("team");
	state.reloadAuthState(agentsDir);
});

beforeEach(() => {
	presence.clearAllPresence();
	tracker.unbypassSession("sess-a", "agent-a");
	tracker.releaseSession("sess-a", "agent-a");
	tracker.releaseSession("sess-b", "agent-b");
	presence.upsertAgentPresence({
		sessionKey: "sess-a",
		agentId: "agent-a",
		harness: "codex",
		project: "proj-a",
		runtimePath: "plugin",
		provider: "codex",
	});
});

afterAll(async () => {
	presence.clearAllPresence();
	tracker.unbypassSession("sess-a", "agent-a");
	writeAuthConfig("local");
	state.reloadAuthState(agentsDir);
	await closeDbAccessor();
	if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousSignetPath;
	rmSync(agentsDir, { recursive: true, force: true });
});

describe("session control permissions in team mode", () => {
	it("denies bypass and renew to read-only credentials", async () => {
		const bypass = await teamApp().request("http://localhost/api/sessions/sess-a/bypass?agent_id=agent-a", {
			method: "POST",
			headers: bearer("readonly"),
			body: JSON.stringify({ enabled: true }),
		});
		expect(bypass.status).toBe(403);
		expect(tracker.isSessionBypassed("sess-a", "agent-a")).toBe(false);

		const renew = await teamApp().request("http://localhost/api/sessions/sess-a/renew?agent_id=agent-a", {
			method: "POST",
			headers: bearer("readonly"),
		});
		expect(renew.status).toBe(403);
	});

	it("lets a write-capable credential manage its scoped session", async () => {
		const bypass = await teamApp().request("http://localhost/api/sessions/sess-a/bypass?agent_id=agent-a", {
			method: "POST",
			headers: bearer("agent"),
			body: JSON.stringify({ enabled: true }),
		});
		expect(bypass.status).toBe(200);
		expect(tracker.isSessionBypassed("sess-a", "agent-a")).toBe(true);

		const renew = await teamApp().request("http://localhost/api/sessions/sess-a/renew?agent_id=agent-a", {
			method: "POST",
			headers: bearer("agent"),
		});
		expect(renew.status).toBe(200);
	});

	it("lets a default connector key manage its scoped session", async () => {
		const connector = bearer("agent", { permissions: ["recall", "remember", "documents"] });
		const bypass = await teamApp().request("http://localhost/api/sessions/sess-a/bypass?agent_id=agent-a", {
			method: "POST",
			headers: connector,
			body: JSON.stringify({ enabled: true }),
		});
		expect(bypass.status).toBe(200);
		expect(tracker.isSessionBypassed("sess-a", "agent-a")).toBe(true);

		const renew = await teamApp().request("http://localhost/api/sessions/sess-a/renew?agent_id=agent-a", {
			method: "POST",
			headers: connector,
		});
		expect(renew.status).toBe(200);
	});

	it("denies session controls outside the credential's project", async () => {
		const otherProject = bearer("agent", { scope: { agent: "agent-a", project: "proj-b" } });
		const bypass = await teamApp().request("http://localhost/api/sessions/sess-a/bypass?agent_id=agent-a", {
			method: "POST",
			headers: otherProject,
			body: JSON.stringify({ enabled: true }),
		});
		expect(bypass.status).toBe(403);
		expect(tracker.isSessionBypassed("sess-a", "agent-a")).toBe(false);

		const renew = await teamApp().request("http://localhost/api/sessions/sess-a/renew?agent_id=agent-a", {
			method: "POST",
			headers: otherProject,
		});
		expect(renew.status).toBe(403);

		const sameProject = bearer("agent", { scope: { agent: "agent-a", project: "proj-a" } });
		const allowed = await teamApp().request("http://localhost/api/sessions/sess-a/renew?agent_id=agent-a", {
			method: "POST",
			headers: sameProject,
		});
		expect(allowed.status).toBe(200);
	});

	it("denies session lifecycle hooks to read-only credentials", async () => {
		expect(tracker.claimSession("sess-a", "plugin", "agent-a", "codex").ok).toBe(true);
		const readonly = bearer("readonly");
		const hooks = [
			["/api/hooks/session-end", { harness: "codex", sessionKey: "sess-a", agentId: "agent-a", runtimePath: "legacy" }],
			[
				"/api/hooks/session-start",
				{ harness: "codex", sessionKey: "sess-a", agentId: "agent-a", runtimePath: "legacy", claimOnly: true },
			],
			[
				"/api/hooks/user-prompt-submit",
				{ harness: "codex", sessionKey: "sess-a", agentId: "agent-a", runtimePath: "legacy", userPrompt: "hi" },
			],
			["/api/hooks/session-checkpoint-extract", { harness: "codex", sessionKey: "sess-a", runtimePath: "legacy" }],
			["/api/hooks/pre-compaction", { harness: "codex", sessionKey: "sess-a", runtimePath: "legacy" }],
			[
				"/api/hooks/compaction-complete",
				{ harness: "codex", sessionKey: "sess-a", runtimePath: "legacy", summary: "s" },
			],
		] as const;
		for (const [path, body] of hooks) {
			const res = await teamApp().request(`http://localhost${path}`, {
				method: "POST",
				headers: readonly,
				body: JSON.stringify(body),
			});
			expect({ path, status: res.status }).toEqual({ path, status: 403 });
		}
		expect(tracker.claimSession("sess-a", "plugin", "agent-a", "codex").ok).toBe(true);
	});

	it("does not let a hook claim another agent's session", async () => {
		expect(tracker.claimSession("sess-b", "plugin", "agent-b", "codex").ok).toBe(true);
		for (const [path, body] of [
			["/api/hooks/session-checkpoint-extract", { harness: "codex", sessionKey: "sess-b", agentId: "agent-b" }],
			["/api/hooks/pre-compaction", { harness: "codex", sessionKey: "sess-b", agentId: "agent-b" }],
			["/api/hooks/compaction-complete", { harness: "codex", sessionKey: "sess-b", agentId: "agent-b", summary: "s" }],
		] as const) {
			const res = await teamApp().request(`http://localhost${path}`, {
				method: "POST",
				headers: { ...bearer("agent"), "x-signet-runtime-path": "legacy" },
				body: JSON.stringify({ ...body, runtimePath: "legacy" }),
			});
			expect({ path, status: res.status }).toEqual({ path, status: 403 });
		}
		expect(tracker.claimSession("sess-b", "plugin", "agent-b", "codex").ok).toBe(true);
	});

	it("does not let a credential take over another agent's session", async () => {
		presence.upsertAgentPresence({
			sessionKey: "sess-b",
			agentId: "agent-b",
			harness: "codex",
			project: "proj-a",
			runtimePath: "plugin",
			provider: "codex",
		});
		expect(tracker.claimSession("sess-b", "plugin", "agent-b", "codex").ok).toBe(true);
		const agentA = bearer("agent");
		for (const [path, body] of [
			["/api/hooks/session-start", { claimOnly: true }],
			["/api/hooks/user-prompt-submit", { userPrompt: "hi" }],
			["/api/hooks/session-checkpoint-extract", {}],
			["/api/hooks/pre-compaction", {}],
			["/api/hooks/compaction-complete", { summary: "s" }],
			["/api/cross-agent/presence", { project: "proj-a" }],
		] as const) {
			const res = await teamApp().request(`http://localhost${path}`, {
				method: "POST",
				headers: agentA,
				body: JSON.stringify({
					harness: "codex",
					sessionKey: "sess-b",
					agentId: "agent-a",
					runtimePath: "legacy",
					...body,
				}),
			});
			expect({ path, status: res.status }).toEqual({ path, status: 403 });
		}
		expect(presence.getAgentPresenceForSession("sess-b")?.agentId).toBe("agent-b");
		expect(tracker.claimSession("sess-a", "legacy", "agent-a", "codex").ok).toBe(true);
	});

	it("does not let a credential move a session into its project", async () => {
		const otherProject = bearer("agent", { scope: { agent: "agent-a", project: "proj-b" } });
		const attempts = [
			["/api/hooks/session-start", { claimOnly: true, project: "proj-b" }],
			["/api/hooks/compaction-complete", { summary: "s", project: "proj-b" }],
			["/api/cross-agent/presence", { project: "proj-b" }],
		] as const;
		for (const [path, body] of attempts) {
			const res = await teamApp().request(`http://localhost${path}`, {
				method: "POST",
				headers: otherProject,
				body: JSON.stringify({
					harness: "codex",
					sessionKey: "sess-a",
					agentId: "agent-a",
					runtimePath: "legacy",
					...body,
				}),
			});
			expect({ path, status: res.status }).toEqual({ path, status: 403 });
		}
		expect(presence.getAgentPresenceForSession("sess-a")?.project).toBe("proj-a");
		const bypass = await teamApp().request("http://localhost/api/sessions/sess-a/bypass?agent_id=agent-a", {
			method: "POST",
			headers: otherProject,
			body: JSON.stringify({ enabled: true }),
		});
		expect(bypass.status).toBe(403);
		expect(tracker.claimSession("sess-a", "plugin", "agent-a", "codex").ok).toBe(true);
	});

	it("still reads the session list with a read-only credential", async () => {
		const list = await teamApp().request("http://localhost/api/sessions?agent_id=agent-a", {
			headers: bearer("readonly"),
		});
		expect(list.status).toBe(200);
	});
});
