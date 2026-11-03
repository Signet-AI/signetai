import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acknowledgeAgentMessage,
	createAgentMessage,
	resetCrossAgentStateForTest,
	upsertAgentPresence,
} from "./cross-agent";
import {
	WAKE_RATE_LIMIT_PER_HOUR,
	activeWakeWaiterCount,
	claimDirectMessageWakes,
	releaseDirectMessageWakes,
	resetDirectMessageWakeStateForTest,
	setWakeWaiterCapForTest,
	waitForDirectMessageWake,
} from "./cross-agent-wake";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { dbOwnerQuery, ownerStatement } from "./db-owner-runtime";

let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "signet-cross-agent-wake-"));
	initDbAccessor(join(tempDir, "memory.db"), { agentsDir: tempDir });
});

afterEach(async () => {
	resetDirectMessageWakeStateForTest();
	resetCrossAgentStateForTest();
	await closeDbAccessor();
	rmSync(tempDir, { recursive: true, force: true });
});

async function wakeRows(): Promise<ReadonlyArray<{ message_id: string; session_key: string; harness: string }>> {
	return await dbOwnerQuery<ReadonlyArray<{ message_id: string; session_key: string; harness: string }>>(
		ownerStatement("SELECT message_id, session_key, harness FROM cross_agent_message_wakes ORDER BY rowid", [], "all"),
		{ operation: "test.wake-rows", lane: "read" },
	);
}

describe("direct message wake", () => {
	it("wakes a waiting session when a direct message arrives and records one durable claim", async () => {
		upsertAgentPresence({ sessionKey: "beta-1", agentId: "beta", harness: "claude-code" });
		const pending = waitForDirectMessageWake({
			agentId: "beta",
			sessionKey: "beta-1",
			harness: "claude-code",
			waitMs: 5_000,
		});
		await Bun.sleep(50);
		const message = createAgentMessage({
			fromAgentId: "alpha",
			fromSessionKey: "alpha-1",
			toAgentId: "beta",
			content: "Can you review the migration?",
			type: "question",
		});

		const result = await pending;
		expect(result.wake).toBe(true);
		if (!result.wake) throw new Error("expected wake");
		expect(result.messageIds).toEqual([message.id]);
		expect(result.inject).toContain("Direct message from another agent");
		expect(result.inject).toContain("> Can you review the migration?");
		expect(result.inject).toContain("Your session key is beta-1");
		expect(result.inject).toContain("alpha-1");
		expect(await wakeRows()).toEqual([{ message_id: message.id, session_key: "beta-1", harness: "claude-code" }]);
		expect(activeWakeWaiterCount()).toBe(0);
	});

	it("claims backlog immediately and never wakes for the same message twice", async () => {
		const message = createAgentMessage({ fromAgentId: "alpha", toAgentId: "beta", content: "queued while idle" });

		const first = await waitForDirectMessageWake({ agentId: "beta", sessionKey: "b1", harness: "pi", waitMs: 0 });
		expect(first.wake).toBe(true);

		const second = await waitForDirectMessageWake({ agentId: "beta", sessionKey: "b2", harness: "pi", waitMs: 0 });
		expect(second).toEqual({ wake: false, reason: "timeout" });
		expect((await wakeRows()).map((row) => row.message_id)).toEqual([message.id]);
	});

	it("does not wake for broadcasts, acknowledged messages, or the sender's own session", async () => {
		createAgentMessage({ fromAgentId: "alpha", broadcast: true, content: "broadcast" });
		const acked = createAgentMessage({ fromAgentId: "alpha", toAgentId: "beta", content: "already handled" });
		acknowledgeAgentMessage({ messageId: acked.id, agentId: "beta" });
		createAgentMessage({ fromAgentId: "beta", fromSessionKey: "b1", toAgentId: "beta", content: "note to self" });

		const result = await waitForDirectMessageWake({ agentId: "beta", sessionKey: "b1", harness: "pi", waitMs: 0 });
		expect(result).toEqual({ wake: false, reason: "timeout" });

		const other = await waitForDirectMessageWake({ agentId: "beta", sessionKey: "b2", harness: "pi", waitMs: 0 });
		expect(other.wake).toBe(true);
	});

	it("routes session-addressed messages only to that session", async () => {
		upsertAgentPresence({ sessionKey: "b1", agentId: "beta", harness: "hermes-agent" });
		upsertAgentPresence({ sessionKey: "b2", agentId: "beta", harness: "hermes-agent" });
		const message = createAgentMessage({ fromAgentId: "alpha", toSessionKey: "b2", content: "for b2 only" });

		expect(await claimDirectMessageWakes({ agentId: "beta", sessionKey: "b1", harness: "hermes-agent" })).toEqual([]);
		const claimed = await claimDirectMessageWakes({ agentId: "beta", sessionKey: "b2", harness: "hermes-agent" });
		expect(claimed.map((item) => item.id)).toEqual([message.id]);
	});

	it("wakes the most recently active waiting session for agent-addressed messages", async () => {
		upsertAgentPresence({ sessionKey: "old", agentId: "beta", harness: "pi" });
		await Bun.sleep(5);
		upsertAgentPresence({ sessionKey: "new", agentId: "beta", harness: "pi" });
		await claimDirectMessageWakes({ agentId: "beta", sessionKey: "warmup", harness: "pi" });
		const older = waitForDirectMessageWake({ agentId: "beta", sessionKey: "old", harness: "pi", waitMs: 1_500 });
		const newer = waitForDirectMessageWake({ agentId: "beta", sessionKey: "new", harness: "pi", waitMs: 1_500 });
		await Bun.sleep(300);
		createAgentMessage({ fromAgentId: "alpha", toAgentId: "beta", content: "pick one" });

		const [olderResult, newerResult] = await Promise.all([older, newer]);
		expect(newerResult.wake).toBe(true);
		expect(olderResult).toEqual({ wake: false, reason: "timeout" });
	});

	it("can skip agent-addressed backlog so a more recent waiter keeps it", async () => {
		upsertAgentPresence({ sessionKey: "b1", agentId: "beta", harness: "pi" });
		createAgentMessage({ fromAgentId: "alpha", toAgentId: "beta", content: "for any beta session" });
		const direct = createAgentMessage({ fromAgentId: "alpha", toSessionKey: "b1", content: "for b1" });
		const claimed = await claimDirectMessageWakes({
			agentId: "beta",
			sessionKey: "b1",
			harness: "pi",
			includeAgentAddressed: false,
		});
		expect(claimed.map((message) => message.id)).toEqual([direct.id]);
	});

	it("releases a claim when the waiter finished before the claim committed", async () => {
		createAgentMessage({ fromAgentId: "alpha", toAgentId: "beta", content: "racing" });
		const first = waitForDirectMessageWake({ agentId: "beta", sessionKey: "b1", harness: "pi", waitMs: 5_000 });
		const second = waitForDirectMessageWake({ agentId: "beta", sessionKey: "b1", harness: "pi", waitMs: 5_000 });
		const results = await Promise.all([first, second]);
		const woke = results.filter((result) => result.wake);
		expect(woke).toHaveLength(1);
		expect(results[0]).toEqual({ wake: false, reason: "superseded" });
		expect((await wakeRows()).map((row) => row.session_key)).toEqual(["b1"]);
	});

	it("lets an older waiter take agent-addressed messages sent by the only more recent waiter", async () => {
		upsertAgentPresence({ sessionKey: "b-old", agentId: "beta", harness: "pi" });
		const fromSender = createAgentMessage({
			fromAgentId: "beta",
			fromSessionKey: "b-new",
			toAgentId: "beta",
			content: "from the newer session",
		});
		createAgentMessage({ fromAgentId: "alpha", toAgentId: "beta", content: "from someone else" });
		const claimed = await claimDirectMessageWakes({
			agentId: "beta",
			sessionKey: "b-old",
			harness: "pi",
			agentAddressedOnlyFromSession: "b-new",
		});
		expect(claimed.map((message) => message.id)).toEqual([fromSender.id]);
	});

	it("rejects new waiters past the global cap", async () => {
		setWakeWaiterCapForTest(1);
		const first = waitForDirectMessageWake({ agentId: "beta", sessionKey: "b1", harness: "pi", waitMs: 2_000 });
		await Bun.sleep(20);
		const second = await waitForDirectMessageWake({ agentId: "beta", sessionKey: "b2", harness: "pi", waitMs: 0 });
		expect(second).toEqual({ wake: false, reason: "rate_limited", retryAfterMs: 30_000 });
		resetDirectMessageWakeStateForTest();
		expect((await first).wake).toBe(false);
	});

	it("releases every submitted claim, beyond one batch", async () => {
		upsertAgentPresence({ sessionKey: "b1", agentId: "beta", harness: "pi" });
		const ids = Array.from(
			{ length: 12 },
			(_, index) => createAgentMessage({ fromAgentId: "alpha", toSessionKey: "b1", content: `m${index}` }).id,
		);
		await claimDirectMessageWakes({ agentId: "beta", sessionKey: "b1", harness: "pi" });
		await claimDirectMessageWakes({ agentId: "beta", sessionKey: "b1", harness: "pi" });
		expect(await wakeRows()).toHaveLength(12);
		expect(await releaseDirectMessageWakes({ agentId: "beta", sessionKey: "b1", messageIds: ids })).toBe(12);
		expect(await wakeRows()).toHaveLength(0);
	});

	it("supersedes an earlier waiter for the same session", async () => {
		const first = waitForDirectMessageWake({
			agentId: "beta",
			sessionKey: "b1",
			harness: "claude-code",
			waitMs: 5_000,
		});
		await Bun.sleep(20);
		const second = waitForDirectMessageWake({
			agentId: "beta",
			sessionKey: "b1",
			harness: "claude-code",
			waitMs: 50,
		});
		expect(await first).toEqual({ wake: false, reason: "superseded" });
		expect(await second).toEqual({ wake: false, reason: "timeout" });
	});

	it("ends the wait when the caller aborts", async () => {
		const controller = new AbortController();
		const pending = waitForDirectMessageWake({
			agentId: "beta",
			sessionKey: "b1",
			harness: "pi",
			waitMs: 5_000,
			signal: controller.signal,
		});
		await Bun.sleep(20);
		controller.abort();
		expect(await pending).toEqual({ wake: false, reason: "aborted" });
		expect(activeWakeWaiterCount()).toBe(0);
	});

	it("rate limits wakes per session so peers cannot wake each other forever", async () => {
		upsertAgentPresence({ sessionKey: "b1", agentId: "beta", harness: "pi" });
		for (let index = 0; index < WAKE_RATE_LIMIT_PER_HOUR; index++) {
			createAgentMessage({ fromAgentId: "alpha", toSessionKey: "b1", content: `ping ${index}` });
			const result = await waitForDirectMessageWake({ agentId: "beta", sessionKey: "b1", harness: "pi", waitMs: 0 });
			expect(result.wake).toBe(true);
		}
		createAgentMessage({ fromAgentId: "alpha", toSessionKey: "b1", content: "one too many" });
		const limited = await waitForDirectMessageWake({ agentId: "beta", sessionKey: "b1", harness: "pi", waitMs: 0 });
		expect(limited.wake).toBe(false);
		if (limited.wake) throw new Error("expected rate limit");
		expect(limited.reason).toBe("rate_limited");
		expect(limited.retryAfterMs).toBeGreaterThan(0);
		expect(await wakeRows()).toHaveLength(WAKE_RATE_LIMIT_PER_HOUR);
	});

	it("keeps wake claims across a daemon restart", async () => {
		createAgentMessage({ fromAgentId: "alpha", toAgentId: "beta", content: "before restart" });
		expect((await waitForDirectMessageWake({ agentId: "beta", sessionKey: "b1", harness: "pi", waitMs: 0 })).wake).toBe(
			true,
		);
		resetDirectMessageWakeStateForTest();
		await closeDbAccessor();
		initDbAccessor(join(tempDir, "memory.db"), { agentsDir: tempDir });

		const after = await waitForDirectMessageWake({ agentId: "beta", sessionKey: "b1", harness: "pi", waitMs: 0 });
		expect(after).toEqual({ wake: false, reason: "timeout" });
	});
});
