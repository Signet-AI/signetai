import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAllPresence, upsertAgentPresence } from "./cross-agent";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { isSessionBypassed, unbypassSession } from "./session-tracker";

let app: Hono;
let dir = "";
let prev: string | undefined;

function jsonHeader(): HeadersInit {
	return { "Content-Type": "application/json" };
}

describe("session API", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-session-api-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: false
`,
		);
		process.env.SIGNET_PATH = dir;

		const daemon = await import("./daemon");
		app = daemon.app;
	});

	beforeEach(() => {
		closeDbAccessor();
		rmSync(join(dir, "memory", "memories.db"), { force: true });
		rmSync(join(dir, "memory", "memories.db-shm"), { force: true });
		rmSync(join(dir, "memory", "memories.db-wal"), { force: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		clearAllPresence();
		unbypassSession("sess-live");
	});

	afterEach(() => {
		closeDbAccessor();
		clearAllPresence();
		unbypassSession("sess-live");
	});

	afterAll(() => {
		closeDbAccessor();
		clearAllPresence();
		if (prev === undefined) {
			process.env.SIGNET_PATH = undefined;
		} else {
			process.env.SIGNET_PATH = prev;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists live presence sessions even when no tracker claim exists", async () => {
		upsertAgentPresence({
			sessionKey: "sess-live",
			agentId: "default",
			harness: "codex",
			project: "proj-a",
			runtimePath: "plugin",
			provider: "codex",
		});

		const res = await app.request("http://localhost/api/sessions", {
			headers: jsonHeader(),
		});
		const json = (await res.json()) as {
			sessions?: Array<{ key: string }>;
			count?: number;
		};

		expect(res.status).toBe(200);
		expect(json.count).toBe(1);
		expect(json.sessions?.[0]?.key).toBe("sess-live");
	});

	it("accepts prefixed session keys for bypass toggles", async () => {
		upsertAgentPresence({
			sessionKey: "sess-live",
			agentId: "default",
			harness: "codex",
			project: "proj-a",
			runtimePath: "plugin",
			provider: "codex",
		});

		const res = await app.request("http://localhost/api/sessions/session%3Asess-live/bypass", {
			method: "POST",
			headers: jsonHeader(),
			body: JSON.stringify({ enabled: true }),
		});
		const json = (await res.json()) as { key?: string; bypassed?: boolean };

		expect(res.status).toBe(200);
		expect(json.key).toBe("sess-live");
		expect(json.bypassed).toBe(true);
		expect(isSessionBypassed("sess-live")).toBe(true);
	});
});
