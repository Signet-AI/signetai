import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { TokenRole } from "../auth";

const previousSignetPath = process.env.SIGNET_PATH;
let agentsDir: string;
let appFactory: typeof import("hono").Hono;
let createAuthMiddleware: typeof import("../auth").createAuthMiddleware;
let createToken: typeof import("../auth").createToken;
let registerSessionRoutes: typeof import("./session-routes").registerSessionRoutes;
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
	return app;
}

function bearer(role: TokenRole): Record<string, string> {
	if (!state.authSecret) throw new Error("expected auth secret");
	const token = createToken(
		state.authSecret,
		{ sub: `session-control-${role}`, role, scope: { agent: "agent-a" } },
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

	it("lets a credential with modify permission manage its scoped session", async () => {
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

	it("still reads the session list with a read-only credential", async () => {
		const list = await teamApp().request("http://localhost/api/sessions?agent_id=agent-a", {
			headers: bearer("readonly"),
		});
		expect(list.status).toBe(200);
	});
});
