import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentMemoryConfig, getAgentIdentityFiles, normalizeAgentRosterEntry, scaffoldAgent } from "../agents";
import {
	STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS,
	detectExistingSetup,
	readStaticIdentity,
	resolvePromptSubmitTimeoutMs,
	resolveSessionStartTimeoutMs,
} from "../identity";
import { parseSimpleYaml } from "../yaml";

const TMP = join(tmpdir(), `signet-identity-test-${Date.now()}`);
const ORIGINAL_HERMES_REPO = process.env.HERMES_REPO;

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => {
	if (ORIGINAL_HERMES_REPO === undefined) {
		// biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined"
		delete process.env.HERMES_REPO;
	} else {
		process.env.HERMES_REPO = ORIGINAL_HERMES_REPO;
	}
	rmSync(TMP, { recursive: true, force: true });
});

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

describe("parseSimpleYaml", () => {
	test("degrades malformed YAML to an empty object", () => {
		expect(parseSimpleYaml("agent:\n  name: [unterminated")).toEqual({});
	});
});

describe("detectExistingSetup", () => {
	test("detects Hermes Agent before the Signet memory plugin is installed", () => {
		const hermesRepo = join(TMP, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_REPO = hermesRepo;

		const detection = detectExistingSetup(TMP);

		expect(detection.harnesses.hermesAgent).toBe(true);
	});
});

describe("agent roster helpers", () => {
	test("resolves agent-local identity files before root fallbacks", () => {
		mkdirSync(join(TMP, "agents", "dot"), { recursive: true });
		writeFileSync(join(TMP, "AGENTS.md"), "root agents");
		writeFileSync(join(TMP, "USER.md"), "root user");
		writeFileSync(join(TMP, "agents", "dot", "AGENTS.md"), "dot agents");
		writeFileSync(join(TMP, "agents", "dot", "IDENTITY.md"), "dot identity");

		expect(getAgentIdentityFiles("dot", TMP)).toMatchObject({
			"AGENTS.md": join(TMP, "agents", "dot", "AGENTS.md"),
			"IDENTITY.md": join(TMP, "agents", "dot", "IDENTITY.md"),
			"USER.md": join(TMP, "USER.md"),
		});
	});

	test("scaffolds only SOUL.md and IDENTITY.md for named agents", () => {
		scaffoldAgent("dot", TMP);
		const agentDir = join(TMP, "agents", "dot");

		expect(existsSync(join(agentDir, "SOUL.md"))).toBe(true);
		expect(existsSync(join(agentDir, "IDENTITY.md"))).toBe(true);
		expect(existsSync(join(agentDir, "AGENTS.md"))).toBe(false);
		expect(existsSync(join(agentDir, "MEMORY.md"))).toBe(false);
	});

	test("normalizes canonical nested memory policies", () => {
		expect(
			normalizeAgentRosterEntry({
				name: "writer",
				memory: { read_policy: { type: "group", group: "writers" } },
			}),
		).toEqual({
			name: "writer",
			readPolicy: "group",
			policyGroup: "writers",
		});
	});

	test("normalizes legacy flat roster policies for backward compatibility", () => {
		expect(normalizeAgentRosterEntry({ name: "writer", read_policy: "shared", policy_group: "ignored" })).toEqual({
			name: "writer",
			readPolicy: "shared",
			policyGroup: null,
		});
	});

	test("normalizes legacy flat roster group policies for backward compatibility", () => {
		expect(normalizeAgentRosterEntry({ name: "writer", read_policy: "group", policy_group: "writers" })).toEqual({
			name: "writer",
			readPolicy: "group",
			policyGroup: "writers",
		});
	});

	test("preserves legacy flat group policy inside a memory block", () => {
		expect(
			normalizeAgentRosterEntry({ name: "writer", memory: { read_policy: "group", policy_group: "writers" } }),
		).toEqual({
			name: "writer",
			readPolicy: "group",
			policyGroup: "writers",
		});
	});

	test("builds canonical nested memory config for group policies", () => {
		expect(buildAgentMemoryConfig("group", "writers")).toEqual({
			read_policy: { type: "group", group: "writers" },
		});
	});

	test("fails closed to isolated when group policy is missing its group", () => {
		expect(buildAgentMemoryConfig("group", null)).toEqual({
			read_policy: "isolated",
		});
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

describe("resolvePromptSubmitTimeoutMs", () => {
	test("returns the default when unset or invalid", () => {
		expect(resolvePromptSubmitTimeoutMs()).toBe(5000);
		expect(resolvePromptSubmitTimeoutMs("oops")).toBe(5000);
		expect(resolvePromptSubmitTimeoutMs("NaN")).toBe(5000);
		expect(resolvePromptSubmitTimeoutMs("0")).toBe(5000);
		expect(resolvePromptSubmitTimeoutMs("-100")).toBe(5000);
		expect(resolvePromptSubmitTimeoutMs("250")).toBe(5000);
	});

	test("clamps high values and preserves valid ones", () => {
		expect(resolvePromptSubmitTimeoutMs("6000")).toBe(6000);
		expect(resolvePromptSubmitTimeoutMs("999999")).toBe(120000);
		expect(resolvePromptSubmitTimeoutMs(String(Number.MAX_SAFE_INTEGER))).toBe(120000);
	});
});
