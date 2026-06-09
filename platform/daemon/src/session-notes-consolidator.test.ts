import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LlmProvider } from "./pipeline/provider";
import { __testing, consolidateSession } from "./session-notes-consolidator";
import { appendTaskSection, readSessionNotes } from "./session-notes-writer";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = `/tmp/signet-consolidator-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
	if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

function mockProvider(output: string): LlmProvider {
	return {
		name: "mock",
		generate: async () => output,
	};
}

const baseInput = (overrides: Partial<Parameters<typeof consolidateSession>[0]> = {}) => ({
	sessionKey: "019econsol-fake-uuid",
	agentId: "default",
	harness: "opencode",
	cwd: "/tmp/repo",
	transcript: "User: do thing\nAssistant: did thing\n",
	agentsDir: tmpRoot,
	provider: null,
	providerModel: null,
	...overrides,
});

describe("session-notes-consolidator extractTaskBody", () => {
	const { extractTaskBody } = __testing;

	test("rejects empty input", () => {
		expect(extractTaskBody("", 1)).toBeNull();
	});

	test("rejects input without the expected heading", () => {
		expect(extractTaskBody("## Task 99\n\nOutcome: x", 1)).toBeNull();
	});

	test("parses a well-formed section block", () => {
		const input = [
			"## Task 1",
			"",
			"Outcome:",
			"Wired the consolidator and validated the schema.",
			"",
			"Preference signals:",
			"- Likes structured sections",
			"- Wants failures as first-class",
			"",
			"Key steps:",
			"- Built the prompt",
			"- Wrote the parser",
			"",
			"Failures and how to do differently:",
			"- (none captured)",
			"",
			"Reusable knowledge:",
			"- Use redactSecrets before writing",
			"",
			"References:",
			"- docs/ARCHITECTURE.md",
			"",
		].join("\n");
		const parsed = extractTaskBody(input, 1);
		expect(parsed).not.toBeNull();
		if (!parsed) return;
		expect(parsed.outcome).toContain("Wired the consolidator");
		expect(parsed.preferenceSignals).toEqual(["Likes structured sections", "Wants failures as first-class"]);
		expect(parsed.keySteps).toEqual(["Built the prompt", "Wrote the parser"]);
		expect(parsed.failures).toEqual([]);
		expect(parsed.reusableKnowledge).toEqual(["Use redactSecrets before writing"]);
		expect(parsed.references).toEqual(["docs/ARCHITECTURE.md"]);
	});

	test("rejects when the outcome block is empty", () => {
		const input = ["## Task 1", "", "Outcome:", "", "Key steps:", "- none", ""].join("\n");
		expect(extractTaskBody(input, 1)).toBeNull();
	});
});

describe("consolidateSession lifecycle", () => {
	test("returns no-file when no notes.md exists", async () => {
		const out = await consolidateSession(baseInput());
		expect(out.ran).toBe(false);
		expect(out.reason).toBe("no-file");
	});

	test("returns no-transcript when transcript is empty", async () => {
		appendTaskSection({
			sessionKey: "k",
			agentId: "default",
			harness: "opencode",
			cwd: "/tmp",
			task: { taskIndex: 1, outcome: "agent wrote" },
			agentsDir: tmpRoot,
		});
		const out = await consolidateSession(baseInput({ sessionKey: "k", transcript: "" }));
		expect(out.ran).toBe(false);
		expect(out.reason).toBe("no-transcript");
	});

	test("returns no-provider when provider is null", async () => {
		appendTaskSection({
			sessionKey: "k2",
			agentId: "default",
			harness: "opencode",
			cwd: "/tmp",
			task: { taskIndex: 1, outcome: "agent wrote" },
			agentsDir: tmpRoot,
		});
		const out = await consolidateSession(baseInput({ sessionKey: "k2", provider: null }));
		expect(out.ran).toBe(false);
		expect(out.reason).toBe("no-provider");
	});

	test("writes a consolidator.json artifact recording the run", async () => {
		appendTaskSection({
			sessionKey: "k3",
			agentId: "default",
			harness: "opencode",
			cwd: "/tmp",
			task: { taskIndex: 1, outcome: "agent wrote" },
			agentsDir: tmpRoot,
		});
		// No provider => no consolidation runs, but an artifact is still written.
		await consolidateSession(baseInput({ sessionKey: "k3", provider: null }));
		const artifactPath = join(tmpRoot, "memory", "sessions", "k3", "consolidator.json");
		expect(existsSync(artifactPath)).toBe(true);
		const raw = JSON.parse(readFileSync(artifactPath, "utf8")) as { status: string; tasksFilled: number };
		expect(raw.status).toBe("skipped");
		expect(raw.tasksFilled).toBe(0);
	});

	test("does not delete the notes file when the consolidator skips", async () => {
		appendTaskSection({
			sessionKey: "k4",
			agentId: "default",
			harness: "opencode",
			cwd: "/tmp",
			task: { taskIndex: 1, outcome: "agent wrote" },
			agentsDir: tmpRoot,
		});
		const notesPath = join(tmpRoot, "memory", "sessions", "k4", "notes.md");
		await consolidateSession(baseInput({ sessionKey: "k4", provider: null }));
		expect(existsSync(notesPath)).toBe(true);
	});

	test("model output is recorded as a task when provider succeeds", async () => {
		const provider = mockProvider(
			[
				"## Task 2",
				"",
				"Outcome:",
				"Consolidator filled this task from the transcript.",
				"",
				"Preference signals:",
				"- (none captured)",
				"",
				"Key steps:",
				"- Ran the consolidator",
				"- Wrote the artifact",
				"",
				"Failures and how to do differently:",
				"- (none captured)",
				"",
				"Reusable knowledge:",
				"- One section per pass keeps focus tight",
				"",
				"References:",
				"- (none captured)",
				"",
			].join("\n"),
		);
		appendTaskSection({
			sessionKey: "k5",
			agentId: "default",
			harness: "opencode",
			cwd: "/tmp",
			task: { taskIndex: 1, outcome: "agent wrote task 1" },
			agentsDir: tmpRoot,
		});
		// Backdate the file so the freshness-skip does not fire.
		const staleNow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		const out = await consolidateSession(
			baseInput({ sessionKey: "k5", provider, providerModel: "mock-model", now: staleNow }),
		);
		expect(out.ran).toBe(true);
		expect(out.tasksFilled).toBe(1);
		expect(out.model).toBe("mock-model");

		const read = readSessionNotes("k5", tmpRoot);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.file.tasks).toHaveLength(2);
		const consolidated = read.file.tasks.find((t) => t.taskIndex === 2);
		expect(consolidated?.source).toBe("consolidator");
		expect(consolidated?.outcome).toContain("Consolidator filled");
	});

	test("fills the lowest missing index, not last+1", async () => {
		const provider = mockProvider(
			[
				"## Task 3",
				"",
				"Outcome:",
				"Filled the gap at task 3.",
				"",
				"Preference signals:",
				"- (none captured)",
				"",
				"Key steps:",
				"- Detected gap",
				"",
				"Failures and how to do differently:",
				"- (none captured)",
				"",
				"Reusable knowledge:",
				"- (none captured)",
				"",
				"References:",
				"- (none captured)",
				"",
			].join("\n"),
		);
		// Plant tasks 1 and 4 so the lowest missing is 2 — but a
		// model output keyed to task 3 should be rejected, while one
		// keyed to task 2 should be accepted. Use a 2-keyed output.
		const providerForTask2 = mockProvider(
			[
				"## Task 2",
				"",
				"Outcome:",
				"Filled the gap at task 2.",
				"",
				"Preference signals:",
				"- (none captured)",
				"",
				"Key steps:",
				"- Detected gap",
				"",
				"Failures and how to do differently:",
				"- (none captured)",
				"",
				"Reusable knowledge:",
				"- (none captured)",
				"",
				"References:",
				"- (none captured)",
				"",
			].join("\n"),
		);
		appendTaskSection({
			sessionKey: "kgap",
			agentId: "default",
			harness: "opencode",
			cwd: "/tmp",
			task: { taskIndex: 1, outcome: "task 1" },
			agentsDir: tmpRoot,
		});
		appendTaskSection({
			sessionKey: "kgap",
			agentId: "default",
			harness: "opencode",
			cwd: "/tmp",
			task: { taskIndex: 4, outcome: "task 4" },
			agentsDir: tmpRoot,
		});
		// Backdate the file so the freshness-skip does not fire — we want
		// to exercise the gap-fill code path on a stale file.
		const staleNow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		// Sanity: the unused provider for task 3 should be rejected.
		const wrongOut = await consolidateSession(baseInput({ sessionKey: "kgap", provider, now: staleNow }));
		expect(wrongOut.ran).toBe(false);
		expect(wrongOut.reason).toBe("error");
		expect(wrongOut.error).toContain("unparseable");

		// The provider for task 2 should fill the gap.
		const out = await consolidateSession(
			baseInput({ sessionKey: "kgap", provider: providerForTask2, providerModel: "m", now: staleNow }),
		);
		expect(out.ran).toBe(true);
		const read = readSessionNotes("kgap", tmpRoot);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.file.tasks.map((t) => t.taskIndex)).toEqual([1, 2, 4]);
	});

	test("skips fresh files even when provider is configured (no phantom task)", async () => {
		const provider = mockProvider("## Task 2\n\nOutcome: Should not be written.\n\nKey steps:\n- none\n");
		appendTaskSection({
			sessionKey: "kfresh",
			agentId: "default",
			harness: "opencode",
			cwd: "/tmp",
			task: { taskIndex: 1, outcome: "agent wrote the only section" },
			agentsDir: tmpRoot,
		});
		// now defaults to the current time — file is fresh.
		const out = await consolidateSession(baseInput({ sessionKey: "kfresh", provider, providerModel: "m" }));
		expect(out.ran).toBe(false);
		expect(out.reason).toBe("no-missing-tasks");

		const read = readSessionNotes("kfresh", tmpRoot);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		// The phantom task 2 must not have been written.
		expect(read.file.tasks.map((t) => t.taskIndex)).toEqual([1]);
	});
});
