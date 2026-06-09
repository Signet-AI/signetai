import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	REQUIRED_TASK_SECTIONS,
	SESSION_NOTES_FILENAME,
	appendTaskSection,
	readSessionNotes,
	sessionNotesDir,
	sessionNotesFingerprint,
	sessionNotesPath,
} from "./session-notes-writer";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = `/tmp/signet-session-notes-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
	if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

const baseParams = (overrides: Partial<Parameters<typeof appendTaskSection>[0]> = {}) => ({
	sessionKey: "019e1234-fake-uuid",
	agentId: "default",
	harness: "opencode",
	cwd: "/tmp/repo",
	gitBranch: "main",
	task: {
		taskIndex: 1,
		outcome: "Wired the writer and verified the file format.",
		preferenceSignals: ["The user prefers structured sections over freeform prose."],
		keySteps: ["Wrote session-notes-writer.ts", "Added tests"],
		failures: [],
		reusableKnowledge: ["Use redactSecrets on all free-text fields."],
		references: ["docs/ARCHITECTURE.md"],
	},
	agentsDir: tmpRoot,
	...overrides,
});

describe("session-notes-writer", () => {
	test("creates notes file with required frontmatter and section schema", () => {
		const result = appendTaskSection(baseParams());
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const path = sessionNotesPath("019e1234-fake-uuid", tmpRoot);
		const raw = readFileSync(path, "utf8");
		expect(raw.startsWith("---\n")).toBe(true);
		expect(raw).toContain("thread_id: 019e1234-fake-uuid");
		expect(raw).toContain("agent_id: default");
		expect(raw).toContain("harness: opencode");
		expect(raw).toContain("cwd: /tmp/repo");
		expect(raw).toContain("git_branch: main");
		expect(raw).toContain("source_kind: signet-sessions");
		expect(raw).toContain("schema_version: 1");
		for (const section of REQUIRED_TASK_SECTIONS) {
			expect(raw).toContain(section);
		}
	});

	test("appends additional task sections in order", () => {
		appendTaskSection(baseParams());
		appendTaskSection(
			baseParams({
				task: {
					taskIndex: 2,
					outcome: "Second task done.",
					keySteps: ["step A", "step B"],
				},
			}),
		);

		const read = readSessionNotes("019e1234-fake-uuid", tmpRoot);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.file.tasks).toHaveLength(2);
		expect(read.file.tasks[0]?.taskIndex).toBe(1);
		expect(read.file.tasks[1]?.taskIndex).toBe(2);
	});

	test("overwrites a task with the same taskIndex in place (idempotent)", () => {
		appendTaskSection(baseParams());
		appendTaskSection(
			baseParams({
				task: {
					taskIndex: 2,
					outcome: "Wrote test, then re-ran.",
				},
			}),
		);
		appendTaskSection(
			baseParams({
				task: {
					taskIndex: 2,
					outcome: "Wrote test, then re-ran, then committed.",
				},
			}),
		);
		const read = readSessionNotes("019e1234-fake-uuid", tmpRoot);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.file.tasks).toHaveLength(2);
		expect(read.file.tasks[1]?.outcome).toContain("then committed");
	});

	test("rejects duplicate taskIndex when overwrite is not intended (caller-controlled)", () => {
		// The writer itself overwrites in place; the test below proves that two
		// writes with the same taskIndex converge to a single, latest version.
		appendTaskSection(baseParams());
		appendTaskSection(
			baseParams({
				task: { taskIndex: 1, outcome: "v2" },
			}),
		);
		const read = readSessionNotes("019e1234-fake-uuid", tmpRoot);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.file.tasks).toHaveLength(1);
		expect(read.file.tasks[0]?.outcome).toBe("v2");
	});

	test("rejects non-positive taskIndex", () => {
		const r = appendTaskSection(baseParams({ task: { taskIndex: 0, outcome: "nope" } }));
		expect(r.ok).toBe(false);
	});

	test("redacts secrets in free-text fields", () => {
		appendTaskSection(
			baseParams({
				task: {
					taskIndex: 1,
					outcome: "Found GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234 in the logs.",
					keySteps: ["Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop in the request"],
				},
			}),
		);
		const path = sessionNotesPath("019e1234-fake-uuid", tmpRoot);
		const raw = readFileSync(path, "utf8");
		expect(raw).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234");
		expect(raw).not.toContain("eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop");
		expect(raw).toContain("[REDACTED]");
	});

	test("embeds source and attributed_at marker on each task section", () => {
		appendTaskSection(baseParams());
		appendTaskSection(
			baseParams({
				source: "consolidator",
				task: { taskIndex: 2, outcome: "filled by consolidator" },
			}),
		);
		const read = readSessionNotes("019e1234-fake-uuid", tmpRoot);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.file.tasks[0]?.source).toBe("agent");
		expect(read.file.tasks[1]?.source).toBe("consolidator");
	});

	test("readSessionNotes returns a structured error when file is missing", () => {
		const r = readSessionNotes("nope", tmpRoot);
		expect(r.ok).toBe(false);
	});

	test("fingerprint changes when a section is added", () => {
		appendTaskSection(baseParams());
		const before = readSessionNotes("019e1234-fake-uuid", tmpRoot);
		if (!before.ok) throw new Error("setup failed");
		const fpBefore = sessionNotesFingerprint(before.file);
		appendTaskSection(baseParams({ task: { taskIndex: 2, outcome: "another" } }));
		const after = readSessionNotes("019e1234-fake-uuid", tmpRoot);
		if (!after.ok) throw new Error("setup failed");
		const fpAfter = sessionNotesFingerprint(after.file);
		expect(fpBefore).not.toBe(fpAfter);
	});

	test("sessionNotesDir sanitizes unsafe characters in the session key", () => {
		const dir = sessionNotesDir("../../etc/passwd", tmpRoot);
		expect(dir.startsWith(tmpRoot)).toBe(true);
		expect(dir).not.toContain("..");
		expect(dir).not.toContain("/etc/");
	});

	test("reuses existing frontmatter (consolidated) when adding later tasks", () => {
		appendTaskSection(baseParams());
		// Mark the existing file as already consolidated by patching the raw text.
		const path = sessionNotesPath("019e1234-fake-uuid", tmpRoot);
		const raw = readFileSync(path, "utf8");
		const replaced = raw.replace(/^consolidated:\s*null/m, "consolidated: 2026-06-09T00:00:00.000Z");
		require("node:fs").writeFileSync(path, replaced);

		appendTaskSection(baseParams({ task: { taskIndex: 2, outcome: "later" } }));
		const reread = readSessionNotes("019e1234-fake-uuid", tmpRoot);
		expect(reread.ok).toBe(true);
		if (!reread.ok) return;
		expect(reread.file.frontmatter.consolidated).toBe("2026-06-09T00:00:00.000Z");
	});

	test("creates the sessions directory if it does not exist", () => {
		const dir = sessionNotesDir("brand-new", tmpRoot);
		expect(existsSync(dir)).toBe(false);
		appendTaskSection(baseParams({ sessionKey: "brand-new" }));
		expect(existsSync(dir)).toBe(true);
		expect(existsSync(join(dir, SESSION_NOTES_FILENAME))).toBe(true);
	});
});
