import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	readStaticIdentity,
	resolveSessionStartTimeoutMs,
	STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS,
} from "../identity";

const TMP = join(tmpdir(), `signet-identity-test-${Date.now()}`);

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("readStaticIdentity", () => {
	test("returns null when dir does not exist", () => {
		expect(readStaticIdentity("/nonexistent/path")).toBeNull();
	});

	test("returns null when dir is empty", () => {
		expect(readStaticIdentity(TMP)).toBeNull();
	});

	test("reads available identity files with headers", () => {
		writeFileSync(join(TMP, "AGENTS.md"), "agent rules here");
		writeFileSync(join(TMP, "SOUL.md"), "soul content");

		const result = readStaticIdentity(TMP);
		expect(result).not.toBeNull();
		expect(result).toContain("[signet: daemon offline");
		expect(result).toContain("## Agent Instructions");
		expect(result).toContain("agent rules here");
		expect(result).toContain("## Soul");
		expect(result).toContain("soul content");
	});

	test("allows callers to override the degraded status line", () => {
		writeFileSync(join(TMP, "AGENTS.md"), "agent rules here");

		const result = readStaticIdentity(TMP, STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS);
		expect(result).not.toBeNull();
		expect(result).toContain("[signet: daemon session-start timed out");
		expect(result).not.toContain("[signet: daemon offline");
	});

	test("handles partial file availability", () => {
		writeFileSync(join(TMP, "USER.md"), "user prefs");

		const result = readStaticIdentity(TMP);
		expect(result).not.toBeNull();
		expect(result).toContain("## About Your User");
		expect(result).toContain("user prefs");
		expect(result).not.toContain("## Agent Instructions");
		expect(result).not.toContain("## Soul");
	});

	test("truncates files exceeding budget", () => {
		// IDENTITY.md has a 2KB budget
		const large = "x".repeat(3000);
		writeFileSync(join(TMP, "IDENTITY.md"), large);

		const result = readStaticIdentity(TMP);
		expect(result).not.toBeNull();
		expect(result).toContain("[truncated]");
		// Should contain exactly 2000 chars of content + truncation marker
		expect(result).toContain("x".repeat(2000));
		expect(result).not.toContain("x".repeat(2001));
	});

	test("skips empty files", () => {
		writeFileSync(join(TMP, "AGENTS.md"), "real content");
		writeFileSync(join(TMP, "SOUL.md"), "   ");

		const result = readStaticIdentity(TMP);
		expect(result).not.toBeNull();
		expect(result).toContain("## Agent Instructions");
		expect(result).not.toContain("## Soul");
	});

	test("reads all five identity files", () => {
		writeFileSync(join(TMP, "AGENTS.md"), "agents");
		writeFileSync(join(TMP, "SOUL.md"), "soul");
		writeFileSync(join(TMP, "IDENTITY.md"), "identity");
		writeFileSync(join(TMP, "USER.md"), "user");
		writeFileSync(join(TMP, "MEMORY.md"), "memory");

		const result = readStaticIdentity(TMP);
		expect(result).not.toBeNull();
		expect(result).toContain("## Agent Instructions");
		expect(result).toContain("## Soul");
		expect(result).toContain("## Identity");
		expect(result).toContain("## About Your User");
		expect(result).toContain("## Working Memory");
	});
});

describe("resolveSessionStartTimeoutMs", () => {
	test("returns the default when unset or invalid", () => {
		expect(resolveSessionStartTimeoutMs()).toBe(15000);
		expect(resolveSessionStartTimeoutMs("oops")).toBe(15000);
		expect(resolveSessionStartTimeoutMs("250")).toBe(15000);
	});

	test("clamps high values and preserves valid ones", () => {
		expect(resolveSessionStartTimeoutMs("18000")).toBe(18000);
		expect(resolveSessionStartTimeoutMs("999999")).toBe(120000);
	});
});
