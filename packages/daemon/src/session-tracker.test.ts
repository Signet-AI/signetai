import { afterEach, describe, expect, it } from "bun:test";
import {
	bypassSession,
	claimSession,
	getBypassedSessionKeys,
	getEndedSession,
	isSessionBypassed,
	markSessionEnded,
	renewSession,
	resetSessions,
	runStaleCleanup,
} from "./session-tracker";

afterEach(() => {
	resetSessions();
});

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
});
