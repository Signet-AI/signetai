import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledgeAgentMessage, createAgentMessage, resetCrossAgentStateForTest } from "../cross-agent";
import { closeDbAccessor, initDbAccessor } from "../db-accessor";
import {
	appendNotificationInject,
	collectCrossAgentNotifications,
	isNotificationCompatibleHook,
} from "./cross-agent-notifications";

let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "signet-notifications-"));
	initDbAccessor(join(tempDir, "memory.db"), { agentsDir: tempDir });
});

afterEach(async () => {
	resetCrossAgentStateForTest();
	await closeDbAccessor();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("cross-agent hook notifications", () => {
	it("declares universal and harness-specific compatible hooks", () => {
		expect(isNotificationCompatibleHook("custom", "SessionStart")).toBe(true);
		expect(isNotificationCompatibleHook("claude-code", "PreToolUse")).toBe(true);
		expect(isNotificationCompatibleHook("opencode", "tool.execute.before")).toBe(true);
		expect(isNotificationCompatibleHook("gemini", "poll")).toBe(true);
		expect(isNotificationCompatibleHook("gemini", "PreToolUse")).toBe(false);
	});

	it("injects the oldest unread messages with stable ids and acknowledgement guidance", () => {
		const first = createAgentMessage({
			fromAgentId: "alpha",
			toAgentId: "beta",
			content: "First pending update.",
			type: "decision_update",
		});
		createAgentMessage({
			fromAgentId: "gamma",
			toAgentId: "beta",
			content: "Second pending question.",
			type: "question",
		});

		const notifications = collectCrossAgentNotifications({
			harness: "claude-code",
			hook: "PreToolUse",
			agentId: "beta",
			limit: 1,
		});

		expect(notifications?.items).toHaveLength(1);
		expect(notifications?.items[0]?.id).toBe(first.id);
		expect(notifications?.unreadCount).toBe(2);
		expect(notifications?.hasMore).toBe(true);
		expect(notifications?.inject).toContain("agent_message_ack");
		expect(notifications?.inject).toContain(first.id);
		expect(appendNotificationInject("base context", notifications)).toContain(
			"base context\n\n## Cross-agent notifications",
		);
	});

	it("neutralizes control characters in peer content and sender labels", () => {
		createAgentMessage({
			fromAgentId: "alpha\n### forged\u001b[31m",
			toAgentId: "beta",
			content: "safe\u0007 text\nnext line",
		});

		const notifications = collectCrossAgentNotifications({
			harness: "pi",
			hook: "context",
			agentId: "beta",
		});

		expect(notifications?.items[0]?.fromAgentId).toBe("alpha ### forged [31m");
		expect(notifications?.items[0]?.content).toBe("safe text\nnext line");
		expect(notifications?.inject).not.toContain("\u001b");
	});

	it("bounds hook payload content and stops injecting acknowledged messages", () => {
		const message = createAgentMessage({
			fromAgentId: "alpha",
			toAgentId: "beta",
			content: "x".repeat(4_000),
		});

		const before = collectCrossAgentNotifications({
			harness: "opencode",
			hook: "experimental.chat.system.transform",
			agentId: "beta",
		});
		expect(before?.items[0]?.contentTruncated).toBe(true);
		expect(before?.items[0]?.content.length).toBeLessThanOrEqual(1_801);

		acknowledgeAgentMessage({ messageId: message.id, agentId: "beta" });
		const after = collectCrossAgentNotifications({
			harness: "opencode",
			hook: "experimental.chat.system.transform",
			agentId: "beta",
		});
		expect(after).toBeNull();
	});
});
