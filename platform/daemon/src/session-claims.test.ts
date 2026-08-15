import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { createSessionClaimStore } from "./session-claims";
import {
	_expireSessionForTest,
	claimSession,
	getActiveSessions,
	getEndedSession,
	hasSession,
	markSessionEnded,
	resetSessions,
	restorePersistedSessions,
	runStaleCleanup,
	setSessionClaimStore,
	setSessionEvictionHandler,
} from "./session-tracker";
import { createTelemetryCollector, setActiveTelemetry } from "./telemetry";

let agentsDir = "";

const TEST_TELEMETRY_CONFIG = {
	posthogHost: "",
	posthogApiKey: "",
	flushIntervalMs: 60000,
	flushBatchSize: 50,
	retentionDays: 90,
	memorySearchQaEnabled: false,
} as const;

function sessionClaimRow(sessionKey: string, agentId: string): Record<string, unknown> | null {
	return getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare("SELECT * FROM session_claims WHERE session_key = ? AND agent_id = ?")
				.get(sessionKey, agentId) as Record<string, unknown> | null,
	);
}

describe("durable session lifecycle claims (#1228)", () => {
	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "signet-session-claims-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		initDbAccessor(join(agentsDir, "memory", "memories.db"));
		setSessionClaimStore(createSessionClaimStore(getDbAccessor()));
	});

	afterEach(() => {
		setSessionClaimStore(null);
		resetSessions();
		closeDbAccessor();
		rmSync(agentsDir, { recursive: true, force: true });
	});

	it("rehydrates an active claim after the tracker process state is cleared", () => {
		expect(claimSession("restart-active", "plugin", "agent-a", "hermes").ok).toBe(true);
		expect(sessionClaimRow("restart-active", "agent-a")).toMatchObject({
			state: "active",
			harness: "hermes",
		});

		resetSessions();
		const restored = restorePersistedSessions();

		expect(restored).toMatchObject({ active: 1, expired: 0, ended: 0 });
		expect(hasSession("restart-active", "agent-a")).toBe(true);
	});

	it("keeps identical session keys isolated across agents", () => {
		expect(claimSession("shared-key", "plugin", "agent-a").ok).toBe(true);
		expect(claimSession("shared-key", "legacy", "agent-b").ok).toBe(true);
		expect(getActiveSessions()).toHaveLength(2);

		resetSessions();
		expect(restorePersistedSessions()).toMatchObject({ active: 2, expired: 0, ended: 0 });
		expect(
			getActiveSessions()
				.map((session) => session.agentId)
				.sort(),
		).toEqual(["agent-a", "agent-b"]);
	});

	it("persists renewals instead of retaining the old expiry", () => {
		claimSession("renew-durable", "legacy", "agent-b");
		const before = String(sessionClaimRow("renew-durable", "agent-b")?.expires_at);

		resetSessions();
		setSessionClaimStore(createSessionClaimStore(getDbAccessor()));
		claimSession("renew-durable", "legacy", "agent-b");
		const after = String(sessionClaimRow("renew-durable", "agent-b")?.expires_at);

		expect(after > before).toBe(true);
	});

	it("restores ended tombstones without reactivating the session", () => {
		claimSession("restart-ended", "plugin", "agent-c");
		markSessionEnded("restart-ended", "plugin", "agent-c");
		expect(sessionClaimRow("restart-ended", "agent-c")).toMatchObject({ state: "ended" });

		resetSessions();
		const restored = restorePersistedSessions();

		expect(restored).toMatchObject({ active: 0, expired: 0, ended: 1 });
		expect(hasSession("restart-ended")).toBe(false);
		expect(getEndedSession("restart-ended", "agent-c")).toBeDefined();
	});

	it("persists an end marker even when no runtime path was provided", () => {
		markSessionEnded("restart-unmarked");
		expect(sessionClaimRow("restart-unmarked", "default")).toMatchObject({
			state: "ended",
			runtime_path: null,
			end_marker: expect.any(String),
		});

		resetSessions();
		expect(restorePersistedSessions()).toMatchObject({ active: 0, expired: 0, ended: 1 });
		expect(getEndedSession("restart-unmarked")).toBeDefined();
	});

	it("runs the TTL finalizer for an expired claim recovered at startup", () => {
		claimSession("restart-expired", "plugin", "agent-d");
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"UPDATE session_claims SET expires_at = ?, state = 'active' WHERE session_key = ? AND agent_id = ?",
			).run("2000-01-01T00:00:00.000Z", "restart-expired", "agent-d");
		});

		resetSessions();
		const evicted: string[] = [];
		setSessionEvictionHandler((info) => {
			evicted.push(info.sessionKey);
			return "finalized";
		});
		const restored = restorePersistedSessions();

		expect(restored).toMatchObject({ active: 0, expired: 1, ended: 0 });
		expect(evicted).toEqual(["restart-expired"]);
		expect(sessionClaimRow("restart-expired", "agent-d")).toBeNull();
	});

	it("does not re-emit expiry telemetry for an already-expired durable row", async () => {
		const collector = createTelemetryCollector(getDbAccessor(), TEST_TELEMETRY_CONFIG, "0.0.0-test");
		setActiveTelemetry(collector);
		try {
			claimSession("restart-telemetry", "plugin", "agent-e", "hermes");
			_expireSessionForTest("restart-telemetry", "agent-e");
			runStaleCleanup();
			await collector.flush();

			resetSessions();
			expect(restorePersistedSessions()).toMatchObject({ active: 0, expired: 1, ended: 0 });
			await collector.flush();

			expect((await collector.query()).filter((event) => event.event === "session.end")).toHaveLength(1);
		} finally {
			setActiveTelemetry(undefined);
		}
	});
});
