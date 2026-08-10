import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createAgentMessage, resetCrossAgentStateForTest, upsertAgentPresence } from "../cross-agent";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";

const previousSignetPath = process.env.SIGNET_PATH;
const suiteDir = mkdtempSync(join(tmpdir(), "signet-notification-routes-suite-"));
process.env.SIGNET_PATH = suiteDir;
const { registerHooksRoutes } = await import("./hooks-routes");

let dir = "";
let app: Hono;

beforeEach(() => {
	dir = mkdtempSync(join(suiteDir, "case-"));
	initDbAccessor(join(dir, "memory.db"), { agentsDir: dir });
	app = new Hono();
	registerHooksRoutes(app);
});

afterEach(() => {
	resetCrossAgentStateForTest();
	closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
	if (previousSignetPath === undefined) {
		Reflect.deleteProperty(process.env, "SIGNET_PATH");
	} else {
		process.env.SIGNET_PATH = previousSignetPath;
	}
	rmSync(suiteDir, { recursive: true, force: true });
});

async function post(path: string, body: Readonly<Record<string, unknown>>): Promise<Response> {
	return app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("cross-agent notification routes", () => {
	it("injects unread messages at a compatible hook and suppresses them after explicit acknowledgement", async () => {
		upsertAgentPresence({ agentId: "beta", harness: "opencode", sessionKey: "session-beta" });
		const message = createAgentMessage({
			fromAgentId: "alpha",
			toAgentId: "beta",
			type: "question",
			content: "Can you verify the release?",
		});

		const first = await post("/api/hooks/notifications", {
			harness: "opencode",
			hook: "experimental.chat.system.transform",
			agentId: "beta",
			sessionKey: "session-beta",
		});
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as {
			inject: string;
			notifications?: { items: Array<{ id: string }>; unreadCount: number };
		};
		expect(firstBody.inject).toContain("Can you verify the release?");
		expect(firstBody.notifications?.items[0]?.id).toBe(message.id);
		expect(firstBody.notifications?.unreadCount).toBe(1);

		const ack = await post(`/api/cross-agent/messages/${message.id}/ack`, {
			agentId: "beta",
			sessionKey: "session-beta",
		});
		expect(ack.status).toBe(200);
		const ackBody = (await ack.json()) as { messageId: string; alreadyAcknowledged: boolean };
		expect(ackBody).toEqual(expect.objectContaining({ messageId: message.id, alreadyAcknowledged: false }));

		const second = await post("/api/hooks/notifications", {
			harness: "opencode",
			hook: "experimental.chat.system.transform",
			agentId: "beta",
			sessionKey: "session-beta",
		});
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual({ inject: "" });
	});

	it("rejects unsupported hooks and cross-agent acknowledgements", async () => {
		upsertAgentPresence({ agentId: "beta", harness: "opencode", sessionKey: "session-beta" });
		const message = createAgentMessage({
			fromAgentId: "alpha",
			toAgentId: "beta",
			type: "info",
			content: "Private to beta",
		});

		const unsupported = await post("/api/hooks/notifications", {
			harness: "opencode",
			hook: "session-end",
			agentId: "beta",
			sessionKey: "session-beta",
		});
		expect(unsupported.status).toBe(400);

		const denied = await post(`/api/cross-agent/messages/${message.id}/ack`, { agentId: "gamma" });
		expect(denied.status).toBe(404);
	});
	it("attaches pending messages to the universal session-start response", async () => {
		const message = createAgentMessage({
			fromAgentId: "alpha",
			toAgentId: "beta",
			type: "decision_update",
			content: "The release candidate is ready.",
		});

		const response = await post("/api/hooks/session-start", {
			harness: "opencode",
			agentId: "beta",
			sessionKey: "session-beta",
			project: dir,
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			inject: string;
			contextHash: string;
			notifications?: { items: Array<{ id: string }> };
		};
		expect(body.inject).toContain("The release candidate is ready.");
		expect(body.notifications?.items.some((item) => item.id === message.id)).toBe(true);
		expect(body.contextHash).toBe(createHash("sha256").update(body.inject).digest("hex"));
	});

	it("preserves the exact prompt envelope and hash when no notification is pending", async () => {
		const response = await post("/api/hooks/session-start", {
			harness: "opencode",
			sessionKey: "session-without-notifications",
			project: dir,
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { inject: string; contextHash: string };

		expect(body.inject.endsWith("\n</signet-memory-context>\n")).toBe(true);
		expect(body.contextHash).toBe(createHash("sha256").update(body.inject).digest("hex"));
	});
	it("returns 429 instead of dropping unread messages when the durable inbox is full", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.exec(`
				WITH RECURSIVE seq(value) AS (
					VALUES(1)
					UNION ALL
					SELECT value + 1 FROM seq WHERE value < 10000
				)
				INSERT INTO cross_agent_messages (
					id, from_agent_id, to_agent_id, broadcast, message_type, content,
					delivery_path, delivery_status, created_at, expires_at
				)
				SELECT
					printf('capacity-%05d', value), 'alpha', 'beta', 0, 'info', 'queued',
					'local', 'delivered', '2026-08-08T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
				FROM seq;
			`);
		});

		const originalFetch = globalThis.fetch;
		let relayCalls = 0;
		globalThis.fetch = Object.assign(
			async (): Promise<Response> => {
				relayCalls += 1;
				return Response.json({ id: "remote-run" }, { status: 201 });
			},
			{ preconnect: originalFetch.preconnect },
		);
		let response: Response;
		try {
			response = await post("/api/cross-agent/messages", {
				fromAgentId: "alpha",
				content: "must not relay after local capacity failure",
				via: "acp",
				acp: { baseUrl: "https://acp.example", targetAgentName: "beta" },
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(response.status).toBe(429);
		expect(relayCalls).toBe(0);
		expect(await response.json()).toEqual({
			error: "Cross-agent message capacity reached; wait for retention cleanup before retrying",
		});
	});
});
