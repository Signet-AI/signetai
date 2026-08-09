import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acknowledgeAgentMessage,
	claimAcpMessageDelivery,
	completeAcpMessageDelivery,
	createAgentMessage,
	isMessageVisibleToAgent,
	listAgentMessagePage,
	listAgentMessages,
	listAgentPresence,
	reconcileAcpDeliveries,
	relayMessageViaAcp,
	removeAgentPresence,
	resetCrossAgentStateForTest,
	subscribeCrossAgentEvents,
	touchAgentPresence,
	updateAgentMessageDelivery,
	upsertAgentPresence,
} from "./cross-agent";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";

let tempDir = "";
let dbPath = "";

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "signet-cross-agent-"));
	dbPath = join(tempDir, "memory.db");
	initDbAccessor(dbPath, { agentsDir: tempDir });
});

afterEach(() => {
	resetCrossAgentStateForTest();
	closeDbAccessor();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("cross-agent presence", () => {
	it("upserts and lists peer sessions while excluding self", () => {
		upsertAgentPresence({
			sessionKey: "sess-a",
			agentId: "alpha",
			harness: "openclaw",
			project: "/repo",
		});
		upsertAgentPresence({
			sessionKey: "sess-b",
			agentId: "beta",
			harness: "opencode",
			project: "/repo",
		});

		const peers = listAgentPresence({
			agentId: "alpha",
			sessionKey: "sess-a",
			includeSelf: false,
		});

		expect(peers.length).toBe(1);
		expect(peers[0]?.agentId).toBe("beta");
		expect(peers[0]?.sessionKey).toBe("sess-b");
	});

	it("touches and removes session presence", () => {
		upsertAgentPresence({
			sessionKey: "sess-x",
			agentId: "alpha",
			harness: "openclaw",
		});

		const touched = touchAgentPresence("sess-x");
		expect(touched).not.toBeNull();
		expect(touched?.agentId).toBe("alpha");

		const removed = removeAgentPresence("sess-x");
		expect(removed).toBe(true);
		expect(listAgentPresence().length).toBe(0);
	});

	it("keeps ephemeral presence keys distinct when fields include colons", () => {
		upsertAgentPresence({
			agentId: "foo:bar",
			harness: "baz",
			project: "/repo",
		});
		upsertAgentPresence({
			agentId: "foo",
			harness: "bar:baz",
			project: "/repo",
		});

		expect(listAgentPresence().length).toBe(2);
	});
});

describe("cross-agent messages", () => {
	it("stores direct messages and lists inbox for recipient", () => {
		upsertAgentPresence({
			sessionKey: "sess-a",
			agentId: "alpha",
			harness: "openclaw",
		});
		upsertAgentPresence({
			sessionKey: "sess-b",
			agentId: "beta",
			harness: "opencode",
		});

		createAgentMessage({
			fromAgentId: "alpha",
			fromSessionKey: "sess-a",
			toAgentId: "beta",
			content: "Need help with migration rollout plan.",
			type: "assist_request",
		});

		const inbox = listAgentMessages({ agentId: "beta" });
		expect(inbox.length).toBe(1);
		expect(inbox[0]?.type).toBe("assist_request");
		expect(inbox[0]?.content).toContain("migration rollout");
	});

	it("does not count outbound-only messages as unread when sent items are included", () => {
		createAgentMessage({
			fromAgentId: "alpha",
			toAgentId: "beta",
			content: "outbound",
		});
		const outboundPage = listAgentMessagePage({ agentId: "alpha", includeSent: true });
		expect(outboundPage.items).toHaveLength(1);
		expect(outboundPage.unreadCount).toBe(0);

		createAgentMessage({
			fromAgentId: "alpha",
			toAgentId: "alpha",
			content: "self-addressed",
		});
		expect(listAgentMessagePage({ agentId: "alpha", includeSent: true }).unreadCount).toBe(1);
	});

	it("includes broadcast messages in recipient inbox", () => {
		createAgentMessage({
			fromAgentId: "alpha",
			content: "CI is currently red on main.",
			broadcast: true,
			type: "decision_update",
		});

		const inbox = listAgentMessages({ agentId: "beta" });
		expect(inbox.length).toBe(1);
		expect(inbox[0]?.broadcast).toBe(true);
	});

	it("allows ACP messages without local target identifiers", () => {
		const message = createAgentMessage({
			fromAgentId: "alpha",
			content: "Escalating to external ACP helper.",
			deliveryPath: "acp",
			deliveryStatus: "queued",
		});

		expect(message.deliveryPath).toBe("acp");
		expect(message.toAgentId).toBeUndefined();
		expect(message.toSessionKey).toBeUndefined();
	});

	it("still requires target for local delivery", () => {
		expect(() =>
			createAgentMessage({
				fromAgentId: "alpha",
				content: "No recipient should fail.",
				deliveryPath: "local",
			}),
		).toThrow("target required for local delivery");
	});

	it("persists ACP messages before relay and updates their delivery result", () => {
		const queued = createAgentMessage({
			fromAgentId: "alpha",
			content: "relay me",
			deliveryPath: "acp",
			deliveryStatus: "queued",
		});
		expect(queued.deliveryStatus).toBe("queued");

		const delivered = updateAgentMessageDelivery(queued.id, {
			status: "delivered",
			receipt: { status: 201, runId: "run-1" },
		});
		expect(delivered.deliveryStatus).toBe("delivered");
		expect(delivered.deliveryReceipt).toEqual({ status: 201, runId: "run-1" });
		expect(listAgentMessages({ agentId: "alpha", includeSent: true })[0]?.deliveryStatus).toBe("delivered");
	});

	it("rejects unresolved local session targets instead of allowing session-key reassignment leaks", () => {
		expect(() =>
			createAgentMessage({
				fromAgentId: "alpha",
				toSessionKey: "absent-session",
				content: "private",
			}),
		).toThrow("target session is not active");
	});

	it("deep-clones delivery receipts to avoid external mutation", () => {
		const message = createAgentMessage({
			fromAgentId: "alpha",
			toAgentId: "beta",
			content: "Receipt immutability check.",
			deliveryReceipt: {
				status: 200,
				nested: { ok: true },
			},
		});

		if (message.deliveryReceipt) {
			message.deliveryReceipt.status = 999;
			message.deliveryReceipt.nested = { ok: false };
		}

		const inbox = listAgentMessages({ agentId: "beta" });
		expect(inbox[0]?.deliveryReceipt).toEqual({
			status: 200,
			nested: { ok: true },
		});
	});

	it("emits events for presence and messages", () => {
		const seen: string[] = [];
		const unsubscribe = subscribeCrossAgentEvents((event) => {
			seen.push(event.type);
		});

		upsertAgentPresence({
			sessionKey: "sess-a",
			agentId: "alpha",
			harness: "openclaw",
		});
		createAgentMessage({
			fromAgentId: "alpha",
			toAgentId: "beta",
			content: "status?",
		});

		unsubscribe();
		expect(seen).toEqual(["presence", "message"]);
	});

	it("keeps session-targeted routing stable if session key is later reused", () => {
		upsertAgentPresence({
			sessionKey: "sess-reused",
			agentId: "beta",
			harness: "openclaw",
		});
		const message = createAgentMessage({
			fromAgentId: "alpha",
			toSessionKey: "sess-reused",
			content: "This message should stay with beta.",
		});

		removeAgentPresence("sess-reused");
		upsertAgentPresence({
			sessionKey: "sess-reused",
			agentId: "gamma",
			harness: "opencode",
		});

		const betaInbox = listAgentMessages({ agentId: "beta" });
		const gammaInbox = listAgentMessages({ agentId: "gamma" });
		expect(betaInbox.length).toBe(1);
		expect(gammaInbox.length).toBe(0);
		expect(
			isMessageVisibleToAgent(message, {
				agentId: "gamma",
				sessionKey: "sess-reused",
				includeBroadcast: true,
			}),
		).toBe(false);
	});

	it("persists unread messages across daemon restarts", () => {
		createAgentMessage({
			fromAgentId: "alpha",
			toAgentId: "beta",
			content: "Durable restart delivery.",
		});

		closeDbAccessor();
		initDbAccessor(dbPath, { agentsDir: tempDir });

		const inbox = listAgentMessagePage({ agentId: "beta", unreadOnly: true });
		expect(inbox.unreadCount).toBe(1);
		expect(inbox.items[0]?.content).toBe("Durable restart delivery.");
	});

	it("acknowledges only visible recipient messages and suppresses unread delivery", () => {
		const message = createAgentMessage({
			fromAgentId: "alpha",
			toAgentId: "beta",
			content: "Acknowledge after processing.",
		});

		expect(() => acknowledgeAgentMessage({ messageId: message.id, agentId: "gamma" })).toThrow(
			"not found or not visible",
		);

		const first = acknowledgeAgentMessage({ messageId: message.id, agentId: "beta" });
		const retry = acknowledgeAgentMessage({ messageId: message.id, agentId: "beta" });
		expect(first.alreadyAcknowledged).toBe(false);
		expect(retry).toEqual({ ...first, alreadyAcknowledged: true });

		const unread = listAgentMessagePage({ agentId: "beta", unreadOnly: true });
		const history = listAgentMessagePage({ agentId: "beta" });
		expect(unread.items).toEqual([]);
		expect(unread.unreadCount).toBe(0);
		expect(history.items[0]?.acknowledgedAt).toBe(first.acknowledgedAt);
	});
});

describe("ACP delivery reconciliation", () => {
	it("marks a committed ACP row indeterminate if the process dies before claiming it", () => {
		const message = createAgentMessage({
			fromAgentId: "alpha",
			content: "queued before crash",
			deliveryPath: "acp",
			deliveryStatus: "queued",
			acpBaseUrl: "https://acp.example.com",
			acpTargetAgentName: "helper",
		});

		expect(reconcileAcpDeliveries(undefined, Date.parse(message.createdAt) + 31_000)).toBe(1);
		const recovered = listAgentMessages({ agentId: "alpha", includeSent: true })[0];
		expect(recovered?.deliveryState).toBe("indeterminate");
		expect(recovered?.deliveryError).toBe("ACP relay was queued but never started");
	});

	it("uses a lease so a second daemon cannot reconcile an active relay", () => {
		const message = createAgentMessage({
			fromAgentId: "alpha",
			content: "lease me",
			deliveryPath: "acp",
			deliveryStatus: "queued",
			acpBaseUrl: "https://acp.example.com",
			acpTargetAgentName: "helper",
		});
		const first = claimAcpMessageDelivery({ messageId: message.id, agentId: "alpha", nowMs: 1_000 });
		expect(() => reconcileAcpDeliveries(undefined, 80_000)).not.toThrow();
		expect(() => claimAcpMessageDelivery({ messageId: message.id, agentId: "alpha", nowMs: 20_000 })).toThrow(
			"already active",
		);
		expect(first.idempotencyKey).toBe(`signet-acp-${message.deliveryAttemptId}`);
		expect(completeAcpMessageDelivery(message.id, first.leaseToken, { status: "delivered" }).deliveryState).toBe(
			"delivered",
		);
	});

	it("marks a fetch-complete but locally-uncommitted relay indeterminate and retries with the same idempotency key", () => {
		const message = createAgentMessage({
			fromAgentId: "alpha",
			content: "recover me",
			deliveryPath: "acp",
			deliveryStatus: "queued",
			acpBaseUrl: "https://acp.example.com",
			acpTargetAgentName: "helper",
		});
		const first = claimAcpMessageDelivery({ messageId: message.id, agentId: "alpha", nowMs: 1_000 });
		expect(reconcileAcpDeliveries(undefined, 200_000)).toBe(1);
		const indeterminate = listAgentMessages({ agentId: "alpha", includeSent: true })[0];
		expect(indeterminate?.deliveryState).toBe("indeterminate");
		expect(indeterminate?.deliveryStatus).toBe("queued");
		expect(() =>
			claimAcpMessageDelivery({
				messageId: message.id,
				agentId: "other-agent",
				retryIndeterminate: true,
				nowMs: 101_000,
			}),
		).toThrow();

		const retry = claimAcpMessageDelivery({
			messageId: message.id,
			agentId: "alpha",
			retryIndeterminate: true,
			nowMs: 201_000,
		});
		expect(retry.idempotencyKey).toBe(first.idempotencyKey);
		expect(retry.message.deliveryAttempts).toBe(2);
	});
});

describe("ACP relay", () => {
	it("posts a run request and returns run id", async () => {
		const originalFetch = globalThis.fetch;
		const capture: { url?: string; body?: string; idempotencyKey?: string } = {};

		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			capture.url = typeof input === "string" ? input : input.toString();
			capture.body = typeof init?.body === "string" ? init.body : "";
			capture.idempotencyKey = new Headers(init?.headers).get("Idempotency-Key") ?? undefined;
			return new Response(JSON.stringify({ run_id: "run-123", status: "running" }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const result = await relayMessageViaAcp({
			baseUrl: "https://acp.example.com/",
			targetAgentName: "helper-agent",
			content: "Can you verify this deployment plan?",
			fromAgentId: "alpha",
			fromSessionKey: "sess-a",
			idempotencyKey: "signet-acp-attempt-123",
		});

		globalThis.fetch = originalFetch;

		expect(capture.url).toBe("https://acp.example.com/runs");
		const body = JSON.parse(capture.body ?? "{}");
		expect(body.agent_name).toBe("helper-agent");
		expect(body.input?.[0]?.parts?.[0]?.content).toContain("deployment plan");
		expect(capture.idempotencyKey).toBe("signet-acp-attempt-123");
		expect(result.ok).toBe(true);
		expect(result.runId).toBe("run-123");
	});

	it("treats ACP 5xx responses as indeterminate", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ error: "upstream overloaded" }), {
					status: 503,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as typeof fetch;

		try {
			const result = await relayMessageViaAcp({
				baseUrl: "https://acp.example.com/",
				targetAgentName: "helper-agent",
				content: "retry safely",
			});
			expect(result.ok).toBe(false);
			expect(result.indeterminate).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("rejects private ACP origins unless allowlisted", async () => {
		const result = await relayMessageViaAcp({
			baseUrl: "http://localhost:9000/",
			targetAgentName: "helper-agent",
			content: "test",
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("allowlisted");
	});

	it("allows allowlisted private ACP origins", async () => {
		const originalFetch = globalThis.fetch;
		const originalAllowlist = process.env.SIGNET_ACP_ALLOWED_ORIGINS;
		const capture: { url?: string } = {};
		process.env.SIGNET_ACP_ALLOWED_ORIGINS = "http://localhost:9000";
		globalThis.fetch = mock(async (input: string | URL | Request) => {
			capture.url = typeof input === "string" ? input : input.toString();
			return new Response(JSON.stringify({ run_id: "run-allowlisted" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		let result: Awaited<ReturnType<typeof relayMessageViaAcp>> | null = null;
		try {
			result = await relayMessageViaAcp({
				baseUrl: "http://localhost:9000/",
				targetAgentName: "helper-agent",
				content: "allowlisted",
			});
		} finally {
			globalThis.fetch = originalFetch;
			if (originalAllowlist === undefined) {
				process.env.SIGNET_ACP_ALLOWED_ORIGINS = undefined;
			} else {
				process.env.SIGNET_ACP_ALLOWED_ORIGINS = originalAllowlist;
			}
		}

		expect(result?.ok).toBe(true);
		expect(capture.url).toBe("http://localhost:9000/runs");
	});
});
