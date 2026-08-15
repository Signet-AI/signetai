import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { DbAccessor } from "./db-accessor";
import { hashSessionKey, markSessionEndTelemetry } from "./session-end-state";
import {
	type SessionEvictionHandler,
	_expireSessionForTest,
	bypassSession,
	claimSession,
	getActiveSessions,
	getBypassedSessionKeys,
	getEndedSession,
	getSessionPath,
	getSessionTrackerStats,
	hasSession,
	isSessionBypassed,
	markSessionEnded,
	renewSession,
	resetSessions,
	runStaleCleanup,
	setSessionEvictionHandler,
} from "./session-tracker";
import { createTelemetryCollector, setActiveTelemetry } from "./telemetry";

// Collector config for telemetry regression tests (#1212): empty posthogHost
// means nothing is ever sent, and the buffer is queried directly.
const TEST_TELEMETRY_CONFIG = {
	posthogHost: "",
	posthogApiKey: "",
	flushIntervalMs: 60000,
	flushBatchSize: 50,
	retentionDays: 90,
	memorySearchQaEnabled: false,
} as const;

afterEach(() => {
	resetSessions();
});

/**
 * Real in-memory telemetry DB: the collector writes the event buffer to
 * `telemetry_events` on flush, and `query()` reads it back — a fake that
 * returns [] for every SELECT would hide the events. Mirrors the real
 * schema (migration 109) so flush + query behave like production.
 */
function telemetryTestDb(): DbAccessor {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE telemetry_install (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
	db.exec(
		`CREATE TABLE telemetry_events (
			id TEXT PRIMARY KEY,
			event TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			properties TEXT NOT NULL,
			sent_to_posthog INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'daemon',
			claim_token TEXT,
			claimed_at TEXT
		)`,
	);
	return {
		withWriteTx: (fn: (d: Database) => unknown) => fn(db),
		withWriteTxAsync: async (fn: (d: Database) => unknown) => fn(db),
		withReadDb: (fn: (d: Database) => unknown) => fn(db),
		withReadDbAsync: async (fn: (d: Database) => Promise<unknown>) => fn(db),
	} as unknown as DbAccessor;
}

describe("bypass with allowUnknown", () => {
	it("adds a bypass entry for an unclaimed session", () => {
		const ok = bypassSession("pipeline-sess-1", { allowUnknown: true });
		expect(ok).toBe(true);
		expect(isSessionBypassed("pipeline-sess-1")).toBe(true);
	});

	it("rejects bypass for unknown session without allowUnknown", () => {
		const ok = bypassSession("pipeline-sess-2");
		expect(ok).toBe(false);
		expect(isSessionBypassed("pipeline-sess-2")).toBe(false);
	});
});

describe("bypass TTL cleanup", () => {
	it("evicts bypass-only entries after TTL expires", () => {
		bypassSession("leak-sess", { allowUnknown: true, ttlMs: 1 });
		expect(isSessionBypassed("leak-sess")).toBe(true);

		Bun.sleepSync(5);
		runStaleCleanup();

		expect(isSessionBypassed("leak-sess")).toBe(false);
	});

	it("keeps bypass-only entries alive before TTL expires", () => {
		bypassSession("alive-sess", { allowUnknown: true, ttlMs: 60_000 });
		expect(isSessionBypassed("alive-sess")).toBe(true);

		runStaleCleanup();

		expect(isSessionBypassed("alive-sess")).toBe(true);
	});

	it("uses default TTL when none specified", () => {
		bypassSession("default-ttl", { allowUnknown: true });
		expect(isSessionBypassed("default-ttl")).toBe(true);

		runStaleCleanup();

		expect(isSessionBypassed("default-ttl")).toBe(true);
	});
});

describe("bypass persists through session rotation", () => {
	it("keeps both old and new sessions bypassed during rotation", () => {
		claimSession("sess-A", "plugin");
		bypassSession("sess-A");
		expect(isSessionBypassed("sess-A")).toBe(true);

		bypassSession("sess-B", { allowUnknown: true });

		expect(isSessionBypassed("sess-A")).toBe(true);
		expect(isSessionBypassed("sess-B")).toBe(true);
	});
});

describe("bypassSession ttlMs guard", () => {
	const fourHours = 4 * 60 * 60 * 1000;

	it("falls back to default TTL when ttlMs is NaN", () => {
		bypassSession("nan-sess", { allowUnknown: true, ttlMs: Number.NaN });
		expect(isSessionBypassed("nan-sess")).toBe(true);

		const expiry = getBypassedSessionKeys().get("nan-sess");
		expect(expiry).toBeDefined();
		if (expiry === undefined) return;
		expect(expiry - Date.now()).toBeGreaterThan(fourHours - 1000);
	});

	it("falls back to default TTL when ttlMs is Infinity", () => {
		bypassSession("inf-sess", { allowUnknown: true, ttlMs: Number.POSITIVE_INFINITY });
		expect(isSessionBypassed("inf-sess")).toBe(true);

		const expiry = getBypassedSessionKeys().get("inf-sess");
		expect(expiry).toBeDefined();
		if (expiry === undefined) return;
		expect(expiry - Date.now()).toBeGreaterThan(fourHours - 1000);
		expect(expiry - Date.now()).toBeLessThan(fourHours + 1000);
	});

	it("falls back to default TTL when ttlMs is negative", () => {
		bypassSession("neg-sess", { allowUnknown: true, ttlMs: -5000 });
		expect(isSessionBypassed("neg-sess")).toBe(true);

		const expiry = getBypassedSessionKeys().get("neg-sess");
		expect(expiry).toBeDefined();
		if (expiry === undefined) return;
		expect(expiry - Date.now()).toBeGreaterThan(fourHours - 1000);
	});

	it("falls back to default TTL when ttlMs is zero", () => {
		bypassSession("zero-sess", { allowUnknown: true, ttlMs: 0 });
		expect(isSessionBypassed("zero-sess")).toBe(true);

		const expiry = getBypassedSessionKeys().get("zero-sess");
		expect(expiry).toBeDefined();
		if (expiry === undefined) return;
		expect(expiry - Date.now()).toBeGreaterThan(fourHours - 1000);
	});
});

describe("renewSession bypass TTL refresh", () => {
	it("refreshes bypass TTL when session is renewed", () => {
		claimSession("renew-bp", "plugin");
		bypassSession("renew-bp", { ttlMs: 5000 });

		const before = getBypassedSessionKeys().get("renew-bp");
		expect(before).toBeDefined();
		if (before === undefined) return;

		Bun.sleepSync(10);
		renewSession("renew-bp");

		const after = getBypassedSessionKeys().get("renew-bp");
		expect(after).toBeDefined();
		if (after === undefined) return;
		expect(after).toBeGreaterThan(before);
	});

	it("does not add bypass entry for non-bypassed session on renewal", () => {
		claimSession("renew-no-bp", "plugin");

		renewSession("renew-no-bp");

		expect(isSessionBypassed("renew-no-bp")).toBe(false);
		expect(getBypassedSessionKeys().has("renew-no-bp")).toBe(false);
	});
});

describe("ended session tombstones", () => {
	it("records a short-lived marker after a session is ended", () => {
		claimSession("ended-sess", "plugin");

		markSessionEnded("ended-sess", "plugin");

		const ended = getEndedSession("ended-sess");
		expect(ended).toBeDefined();
		expect(ended?.key).toBe("ended-sess");
		expect(ended?.runtimePath).toBe("plugin");
	});

	it("clears an ended marker when the session is claimed again", () => {
		markSessionEnded("reused-sess", "legacy");
		expect(getEndedSession("reused-sess")).toBeDefined();

		claimSession("reused-sess", "plugin");

		expect(getEndedSession("reused-sess")).toBeUndefined();
	});

	it("removes expired ended markers from the agent-scoped map", () => {
		markSessionEnded("expired-scoped", "plugin", "agent-scoped");
		const realNow = Date.now;
		Date.now = () => realNow() + 31 * 60 * 1000;
		try {
			expect(getEndedSession("expired-scoped", "agent-scoped")).toBeUndefined();
			expect(getSessionTrackerStats().ended).toBe(0);
		} finally {
			Date.now = realNow;
		}
	});
});

describe("TTL eviction lifecycle handler (#902)", () => {
	it("invokes the handler with the evicted claim and increments expired", () => {
		const seen: Array<{ key: string; agentId: string; runtimePath: string }> = [];
		const handler: SessionEvictionHandler = (info) => {
			seen.push({ key: info.sessionKey, agentId: info.agentId, runtimePath: info.runtimePath });
			return undefined;
		};
		setSessionEvictionHandler(handler);
		claimSession("ttl-sess-1", "plugin", "agent-a");
		_expireSessionForTest("ttl-sess-1", "agent-a");

		runStaleCleanup();

		expect(seen).toEqual([{ key: "ttl-sess-1", agentId: "agent-a", runtimePath: "plugin" }]);
		expect(getSessionTrackerStats().expired).toBe(1);
		expect(getSessionTrackerStats().unfinalized).toBe(0);
	});

	it("counts a handler 'skipped' outcome as unfinalized", () => {
		setSessionEvictionHandler(() => "skipped");
		claimSession("ttl-sess-2", "legacy", "agent-b");
		_expireSessionForTest("ttl-sess-2", "agent-b");

		runStaleCleanup();

		expect(getSessionTrackerStats().expired).toBe(1);
		expect(getSessionTrackerStats().unfinalized).toBe(1);
	});

	it("does not count a 'finalized' outcome as unfinalized", () => {
		setSessionEvictionHandler(() => "finalized");
		claimSession("ttl-sess-3", "plugin", "agent-c");
		_expireSessionForTest("ttl-sess-3", "agent-c");

		runStaleCleanup();

		expect(getSessionTrackerStats().expired).toBe(1);
		expect(getSessionTrackerStats().unfinalized).toBe(0);
	});

	it("counts expired sessions even without a registered handler", () => {
		setSessionEvictionHandler(null);
		claimSession("ttl-sess-4", "plugin");
		_expireSessionForTest("ttl-sess-4");

		runStaleCleanup();

		expect(getSessionTrackerStats().expired).toBe(1);
		expect(getSessionTrackerStats().unfinalized).toBe(0);
	});

	it("does not invoke the handler for a live (unexpired) claim", () => {
		let calls = 0;
		setSessionEvictionHandler(() => {
			calls++;
			return "finalized";
		});
		claimSession("ttl-live", "plugin");

		runStaleCleanup();

		expect(calls).toBe(0);
		expect(getSessionTrackerStats().expired).toBe(0);
	});

	it("invokes the handler for every synchronous TTL eviction path", () => {
		const evicted: string[] = [];
		setSessionEvictionHandler((info) => {
			evicted.push(info.sessionKey);
			return "finalized";
		});

		claimSession("ttl-reclaim", "plugin");
		_expireSessionForTest("ttl-reclaim");
		claimSession("ttl-reclaim", "legacy");

		claimSession("ttl-has", "plugin");
		_expireSessionForTest("ttl-has");
		hasSession("ttl-has");

		claimSession("ttl-path", "plugin");
		_expireSessionForTest("ttl-path");
		getSessionPath("ttl-path");

		claimSession("ttl-active", "plugin");
		_expireSessionForTest("ttl-active");
		getActiveSessions();

		claimSession("ttl-renew", "plugin");
		_expireSessionForTest("ttl-renew");
		renewSession("ttl-renew");

		expect(evicted).toEqual(["ttl-reclaim", "ttl-has", "ttl-path", "ttl-active", "ttl-renew"]);
		expect(getSessionTrackerStats().expired).toBe(5);
	});

	describe("session.end telemetry on TTL eviction (#1212)", () => {
		it("emits session.end once per session lifetime when a claim TTL-evicts", async () => {
			const collector = createTelemetryCollector(telemetryTestDb(), TEST_TELEMETRY_CONFIG, "0.0.0-test");
			setActiveTelemetry(collector);
			try {
				claimSession("sess-evict", "legacy", "default", "claude-code");
				_expireSessionForTest("sess-evict");
				runStaleCleanup();
				await collector.flush();

				const ends = (await collector.query()).filter((e) => e.event === "session.end");
				expect(ends).toHaveLength(1);
				expect(ends[0]?.properties.reason).toBe("expired");
				expect(ends[0]?.properties.harness).toBe("claude-code");
				expect(typeof ends[0]?.properties.sessionHash).toBe("string");

				// A re-claimed session that evicts again without a new session
				// start is the same lifetime — no second event.
				claimSession("sess-evict", "legacy", "default", "claude-code");
				_expireSessionForTest("sess-evict");
				runStaleCleanup();
				await collector.flush();
				expect((await collector.query()).filter((e) => e.event === "session.end")).toHaveLength(1);
			} finally {
				setActiveTelemetry(undefined);
			}
		});

		it("emits session.end for claims without a harness as harness null", async () => {
			const collector = createTelemetryCollector(telemetryTestDb(), TEST_TELEMETRY_CONFIG, "0.0.0-test");
			setActiveTelemetry(collector);
			try {
				claimSession("sess-evict-noharness", "plugin");
				_expireSessionForTest("sess-evict-noharness");
				runStaleCleanup();
				await collector.flush();

				const ends = (await collector.query()).filter((e) => e.event === "session.end");
				expect(ends).toHaveLength(1);
				expect(ends[0]?.properties.harness).toBeNull();
			} finally {
				setActiveTelemetry(undefined);
			}
		});

		it("refreshes the harness on a same-path reclaim before TTL eviction", async () => {
			const collector = createTelemetryCollector(telemetryTestDb(), TEST_TELEMETRY_CONFIG, "0.0.0-test");
			setActiveTelemetry(collector);
			try {
				// The session-start route must repair a claim created without a
				// harness before TTL eviction emits its lifecycle event.
				claimSession("sess-evict-harness", "plugin", "default");
				claimSession("sess-evict-harness", "plugin", "default", "opencode");
				_expireSessionForTest("sess-evict-harness");
				runStaleCleanup();
				await collector.flush();

				const ends = (await collector.query()).filter((e) => e.event === "session.end");
				expect(ends).toHaveLength(1);
				expect(ends[0]?.properties.harness).toBe("opencode");
			} finally {
				setActiveTelemetry(undefined);
			}
		});

		it("does not double-count a lifetime when clear and TTL use different harness values", async () => {
			const collector = createTelemetryCollector(telemetryTestDb(), TEST_TELEMETRY_CONFIG, "0.0.0-test");
			setActiveTelemetry(collector);
			try {
				// Simulate the explicit-clear path recording the end marker with
				// the harness supplied by the termination request.
				markSessionEndTelemetry({
					agentId: "default",
					harness: "opencode",
					sessionKey: "sess-evict-dedup",
				});
				// The claim was created by a path that did not retain harness
				// metadata. The TTL path must still find the same marker.
				claimSession("sess-evict-dedup", "plugin", "default");
				_expireSessionForTest("sess-evict-dedup");
				runStaleCleanup();
				await collector.flush();

				expect((await collector.query()).filter((e) => e.event === "session.end")).toHaveLength(0);
			} finally {
				setActiveTelemetry(undefined);
			}
		});

		it("does not double-count a lifetime whose clear used a session:-prefixed key (#1212)", async () => {
			const collector = createTelemetryCollector(telemetryTestDb(), TEST_TELEMETRY_CONFIG, "0.0.0-test");
			setActiveTelemetry(collector);
			try {
				// Harnesses (openclaw) send "session:<uuid>" keys. The clear
				// path and the tracker eviction path must agree on the same
				// normalized identity, or the same lifetime emits session.end
				// twice — once for clear, once for the eviction.
				markSessionEndTelemetry({ agentId: "default", harness: "claude-code", sessionKey: "session:evict-prefixed" });
				claimSession("session:evict-prefixed", "legacy", "default", "claude-code");
				_expireSessionForTest("session:evict-prefixed");
				runStaleCleanup();
				await collector.flush();

				expect((await collector.query()).filter((e) => e.event === "session.end")).toHaveLength(0);

				// And the anonymous hash is joinable across raw/normalized forms.
				expect(hashSessionKey("session:abc")).toBe(hashSessionKey("abc"));
			} finally {
				setActiveTelemetry(undefined);
			}
		});
	});
});
