import { afterEach, describe, expect, it } from "bun:test";
import { bypassSession, claimSession, isSessionBypassed, resetSessions, runStaleCleanup } from "./session-tracker";

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
