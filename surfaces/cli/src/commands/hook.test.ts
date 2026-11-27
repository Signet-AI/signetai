import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { Command } from "commander";
import type { TranscriptUploadOutcome, TranscriptUploadTarget } from "@signet/core/transcript-upload";
import {
	buildCodexHookOutput,
	buildCompactionCompleteBody,
	buildSessionEndBody,
	buildSessionStartBody,
	buildSessionStartFallback,
	buildUserPromptSubmitBody,
	pickSessionKey,
	readJson,
	registerHookCommands,
	resolvePromptSubmitTimeout,
	shouldReadCompactionInput,
} from "./hook";

const prevLog = console.log;
const hookExitCodes: number[] = [];
const noUpload = async () => ({ status: "unchanged" as const });
const originalExit = process.exit;

beforeAll(() => {
	process.exit = ((code?: number) => {
		hookExitCodes.push(code ?? 0);
	}) as typeof process.exit;
});

afterAll(() => {
	process.exit = originalExit;
});

beforeEach(() => {
	hookExitCodes.length = 0;
});

afterEach(() => {
	console.log = prevLog;
});

describe("pickSessionKey", () => {
	test("prefers canonical sessionKey fields before legacy session_id aliases", () => {
		expect(
			pickSessionKey({
				session_key: "sess-kebab",
				sessionKey: "sess-camel",
				session_id: "sess-snake-id",
				sessionId: "sess-camel-id",
			}),
		).toBe("sess-kebab");
	});

	test("falls back through legacy aliases when canonical keys are absent", () => {
		expect(
			pickSessionKey({
				sessionId: "sess-camel-id",
			}),
		).toBe("sess-camel-id");
	});
});

describe("resolvePromptSubmitTimeout", () => {
	test("uses prompt-submit timeout env when valid", () => {
		const prev = process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT;
		process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT = "9000";
		expect(resolvePromptSubmitTimeout()).toBe(9000);
		if (prev === undefined) delete process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT;
		else process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT = prev;
	});

	test("falls back to the default when env is invalid or too small", () => {
		const prev = process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT;
		process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT = "200";
		expect(resolvePromptSubmitTimeout()).toBe(5000);
		if (prev === undefined) delete process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT;
		else process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT = prev;
	});
});

describe("buildCodexHookOutput", () => {
	test("formats Codex additional context using hookSpecificOutput", () => {
		expect(buildCodexHookOutput("SessionStart", " recalled context ")).toEqual({
			continue: true,
			suppressOutput: true,
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext: "recalled context",
			},
		});
	});

	test("emits a valid no-op Codex hook output when context is empty", () => {
		expect(buildCodexHookOutput("UserPromptSubmit", " ")).toEqual({
			continue: true,
			suppressOutput: true,
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
			},
		});
	});
});

describe("buildSessionStartFallback", () => {
	test("uses a timeout-specific banner when session-start times out", () => {
		const readStaticIdentity = (_dir: string, status?: string): string | null => status ?? null;
		expect(buildSessionStartFallback(readStaticIdentity, "/tmp/agents", "timeout")).toContain(
			"session-start timed out",
		);
	});

	test("preserves the default offline banner for reachability failures", () => {
		const readStaticIdentity = (_dir: string, status?: string): string | null =>
			status ?? "[signet: daemon offline — running with static identity]";
		expect(buildSessionStartFallback(readStaticIdentity, "/tmp/agents", "offline")).toContain("daemon offline");
	});

	test("degrades to static identity on http error instead of exiting", () => {
		const readStaticIdentity = (_dir: string, status?: string): string | null =>
			status ?? "[signet: daemon offline — running with static identity]";
		expect(buildSessionStartFallback(readStaticIdentity, "/tmp/agents", "http")).not.toBeNull();
		expect(buildSessionStartFallback(readStaticIdentity, "/tmp/agents", "http")).toContain("daemon offline");
	});

	test("degrades to static identity on invalid-json instead of exiting", () => {
		const readStaticIdentity = (_dir: string, status?: string): string | null =>
			status ?? "[signet: daemon offline — running with static identity]";
		expect(buildSessionStartFallback(readStaticIdentity, "/tmp/agents", "invalid-json")).not.toBeNull();
		expect(buildSessionStartFallback(readStaticIdentity, "/tmp/agents", "invalid-json")).toContain("daemon offline");
	});
});

describe("buildSessionEndBody", () => {
	test("forwards inline transcript capture for session-end hooks", () => {
		expect(
			buildSessionEndBody(
				{
					sessionKey: "sess-1",
					transcript: "user: hi\nassistant: hello",
					transcriptPath: "/tmp/session.txt",
					cwd: "/tmp/project",
					reason: "shutdown",
				},
				"claude-code",
			),
		).toEqual({
			harness: "claude-code",
			transcript: "user: hi\nassistant: hello",
			sessionId: "sess-1",
			sessionKey: "sess-1",
			cwd: "/tmp/project",
			reason: "shutdown",
			runtimePath: "legacy",
		});
	});

	test("forwards the turn's final assistant reply from Stop payloads", () => {
		const body = buildSessionEndBody(
			{
				session_id: "muse-sess",
				hook_event_name: "Stop",
				last_assistant_message: "Ultramarine noted.",
				transcript_path: null,
			},
			"muse-code",
		);
		expect(body.lastAssistantMessage).toBe("Ultramarine noted.");
		expect(body).not.toHaveProperty("transcriptPath");
	});

	test("preserves a distinct legacy sessionId alongside canonical sessionKey", () => {
		expect(
			buildSessionEndBody(
				{
					sessionId: "sess-legacy-id",
					sessionKey: "sess-canonical-key",
					transcriptPath: "/tmp/session.txt",
				},
				"claude-code",
			),
		).toEqual({
			cwd: "",
			harness: "claude-code",
			reason: "",
			sessionId: "sess-legacy-id",
			sessionKey: "sess-canonical-key",
			transcript: "",
			runtimePath: "legacy",
		});
	});

	test("preserves existing agentId and non-Claude agent_id inputs as Signet scope", () => {
		expect(buildSessionEndBody({ agentId: "research-agent", sessionKey: "sess-1" }, "claude-code").agentId).toBe(
			"research-agent",
		);
		expect(buildSessionEndBody({ agent_id: "legacy-agent", sessionKey: "sess-2" }, "custom-harness").agentId).toBe(
			"legacy-agent",
		);
		expect(
			buildSessionEndBody(
				{ agentId: "legacy-agent", signetAgentId: "explicit-agent", sessionKey: "sess-3" },
				"claude-code",
			).agentId,
		).toBe("explicit-agent");
	});

	test("keeps Claude Code session-end agent_id out of Signet scope", () => {
		expect(buildSessionEndBody({ agent_id: "claude-subagent", sessionKey: "sess-4" }, "claude-code").agentId).toBe(
			undefined,
		);
		expect(
			buildSessionEndBody(
				{ agent_id: "claude-subagent", signet_agent_id: "research-agent", sessionKey: "sess-5" },
				"claude-code",
			).agentId,
		).toBe("research-agent");
	});
});

describe("buildSessionStartBody", () => {
	test("keeps harness agent ids separate from Signet agent scope", () => {
		expect(
			buildSessionStartBody(
				{
					agent_id: "claude-subagent",
					parentID: "parent-session",
					sessionKey: "child-session",
					cwd: "/tmp/project",
					signetAgentId: "research-agent",
				},
				{ harness: "claude-code", context: "extra context" },
			),
		).toEqual({
			harness: "claude-code",
			project: "/tmp/project",
			agentId: "research-agent",
			harnessAgentId: "claude-subagent",
			parentSessionKey: "parent-session",
			context: "extra context",
			sessionKey: "child-session",
			runtimePath: "legacy",
		});
	});

	test("preserves legacy agentId input as Signet scope", () => {
		expect(
			buildSessionStartBody(
				{
					agentId: "research-agent",
					sessionKey: "sess-1",
					cwd: "/tmp/project",
				},
				{ harness: "custom-harness" },
			),
		).toEqual({
			harness: "custom-harness",
			project: "/tmp/project",
			agentId: "research-agent",
			sessionKey: "sess-1",
			runtimePath: "legacy",
		});
	});

	test("preserves legacy agent_id input as Signet scope when it is not a native sub-agent payload", () => {
		expect(
			buildSessionStartBody(
				{
					agent_id: "research-agent",
					sessionKey: "sess-1",
					cwd: "/tmp/project",
				},
				{ harness: "custom-harness" },
			),
		).toEqual({
			harness: "custom-harness",
			project: "/tmp/project",
			agentId: "research-agent",
			sessionKey: "sess-1",
			runtimePath: "legacy",
		});
	});

	test("prefers explicit CLI agent id for Signet scope", () => {
		expect(
			buildSessionStartBody(
				{
					agent_id: "claude-subagent",
					signet_agent_id: "stdin-signet-agent",
					session_id: "sess-1",
				},
				{ harness: "claude-code", project: "/tmp/explicit", agentId: "cli-signet-agent" },
			),
		).toEqual({
			harness: "claude-code",
			project: "/tmp/explicit",
			agentId: "cli-signet-agent",
			harnessAgentId: "claude-subagent",
			sessionKey: "sess-1",
			runtimePath: "legacy",
		});
	});

	test("keeps Claude Code session-start agent_id out of Signet scope without an explicit parent", () => {
		expect(
			buildSessionStartBody(
				{
					agent_id: "claude-subagent",
					sessionKey: "child-session",
					cwd: "/tmp/project",
				},
				{ harness: "claude-code" },
			),
		).toEqual({
			harness: "claude-code",
			project: "/tmp/project",
			harnessAgentId: "claude-subagent",
			sessionKey: "child-session",
			runtimePath: "legacy",
		});
	});

	test("forwards Claude Code clear source on session start", () => {
		expect(
			buildSessionStartBody(
				{
					source: "clear",
					sessionKey: "after-clear-session",
					cwd: "/tmp/project",
				},
				{ harness: "claude-code" },
			),
		).toEqual({
			harness: "claude-code",
			project: "/tmp/project",
			source: "clear",
			sessionKey: "after-clear-session",
			runtimePath: "legacy",
		});
	});

	test("forwards parent_key aliases for explicit parent context", () => {
		expect(
			buildSessionStartBody(
				{ parent_key: "parent-from-snake", sessionKey: "child-session", cwd: "/tmp/project" },
				{ harness: "custom-harness" },
			),
		).toMatchObject({
			parentSessionKey: "parent-from-snake",
			sessionKey: "child-session",
		});

		expect(
			buildSessionStartBody(
				{ parentKey: "parent-from-camel", sessionKey: "child-session", cwd: "/tmp/project" },
				{ harness: "custom-harness" },
			),
		).toMatchObject({
			parentSessionKey: "parent-from-camel",
			sessionKey: "child-session",
		});
	});
});

describe("buildUserPromptSubmitBody", () => {
	test("forwards the preferred userMessage field alongside legacy userPrompt compatibility", () => {
		expect(
			buildUserPromptSubmitBody(
				{
					userMessage: "clean prompt",
					prompt: "raw prompt",
					sessionKey: "sess-2",
					transcript: "user: hi",
					lastAssistantMessage: "prior answer",
				},
				"claude-code",
				"/tmp/project",
			),
		).toEqual({
			harness: "claude-code",
			project: "/tmp/project",
			userMessage: "clean prompt",
			userPrompt: "raw prompt",
			sessionKey: "sess-2",
			transcript: "user: hi",
			runtimePath: "legacy",
			lastAssistantMessage: "prior answer",
		});
	});

	test("does not treat harness agent_id as Signet scope on prompt submit", () => {
		expect(
			buildUserPromptSubmitBody(
				{
					userMessage: "inspect this",
					sessionKey: "child-session",
					harness_agent_id: "claude-subagent",
					signet_agent_id: "research-agent",
				},
				"claude-code",
				"/tmp/project",
			),
		).toEqual({
			harness: "claude-code",
			project: "/tmp/project",
			userMessage: "inspect this",
			userPrompt: "",
			sessionKey: "child-session",
			transcript: "",
			agentId: "research-agent",
			harnessAgentId: "claude-subagent",
			runtimePath: "legacy",
		});
	});

	test("preserves existing agentId prompt-submit input as Signet scope", () => {
		expect(
			buildUserPromptSubmitBody(
				{
					userMessage: "inspect this",
					sessionKey: "child-session",
					agentId: "research-agent",
				},
				"custom-harness",
				"/tmp/project",
			),
		).toEqual({
			harness: "custom-harness",
			project: "/tmp/project",
			userMessage: "inspect this",
			userPrompt: "",
			sessionKey: "child-session",
			transcript: "",
			agentId: "research-agent",
			runtimePath: "legacy",
		});
	});

	test("preserves existing agent_id prompt-submit input as Signet scope", () => {
		expect(
			buildUserPromptSubmitBody(
				{
					userMessage: "inspect this",
					sessionKey: "child-session",
					agent_id: "research-agent",
				},
				"custom-harness",
				"/tmp/project",
			),
		).toEqual({
			harness: "custom-harness",
			project: "/tmp/project",
			userMessage: "inspect this",
			userPrompt: "",
			sessionKey: "child-session",
			transcript: "",
			agentId: "research-agent",
			runtimePath: "legacy",
		});
	});

	test("keeps Claude Code prompt-submit agent_id out of Signet scope", () => {
		expect(
			buildUserPromptSubmitBody(
				{
					userMessage: "inspect this",
					sessionKey: "child-session",
					agent_id: "claude-subagent",
				},
				"claude-code",
				"/tmp/project",
			),
		).toEqual({
			harness: "claude-code",
			project: "/tmp/project",
			userMessage: "inspect this",
			userPrompt: "",
			sessionKey: "child-session",
			transcript: "",
			harnessAgentId: "claude-subagent",
			runtimePath: "legacy",
		});
	});

	test("hook command uses daemon result transport for user-prompt-submit", async () => {
		const seen: Array<{ path: string; body: string; runtimePath: string | null; timeout?: number }> = [];
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerHookCommands(program, {
			AGENTS_DIR: "/tmp/agents",
			uploadTranscriptFile: noUpload,
			fetchDaemonResult: async (path, opts) => {
				seen.push({
					path,
					body: typeof opts?.body === "string" ? opts.body : "",
					runtimePath: new Headers(opts?.headers).get("x-signet-runtime-path"),
					timeout: opts?.timeout,
				});
				return {
					ok: true,
					data: {
						inject: "recalled context",
						dynamicContext: "recalled context",
					},
				};
			},
			readStaticIdentity: () => null,
		});

		await program.parseAsync(["node", "test", "hook", "user-prompt-submit", "-H", "claude-code"]);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.path).toBe("/api/hooks/user-prompt-submit");
		expect(seen[0]?.body).toContain('"harness":"claude-code"');
		expect(seen[0]?.body).toContain('"runtimePath":"legacy"');
		expect(seen[0]?.runtimePath).toBe("legacy");
		expect(seen[0]?.timeout).toBe(5000);
		expect(lines).toContain("recalled context");
	});

	test("combines split session-start context for Codex hook output", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerHookCommands(program, {
			AGENTS_DIR: "/tmp/agents",
			uploadTranscriptFile: noUpload,
			fetchDaemonResult: async () => ({
				ok: true,
				data: { stableSystemPrompt: "stable prefix", dynamicContext: "initial context" },
			}),
			readStaticIdentity: () => null,
		});

		await program.parseAsync(["node", "test", "hook", "session-start", "-H", "codex", "--codex-json"]);

		expect(JSON.parse(lines[0] ?? "{}").hookSpecificOutput.additionalContext).toBe("stable prefix\ninitial context");
	});

	test("notification hook emits native PreToolUse context", async () => {
		const seen: Array<{ path: string; body: string }> = [];
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerHookCommands(program, {
			AGENTS_DIR: "/tmp/agents",
			uploadTranscriptFile: noUpload,
			fetchDaemonResult: async (path, opts) => {
				seen.push({ path, body: typeof opts?.body === "string" ? opts.body : "" });
				return { ok: true, data: { inject: "peer context" } };
			},
			readStaticIdentity: () => null,
		});

		await program.parseAsync([
			"node",
			"test",
			"hook",
			"notifications",
			"-H",
			"codex",
			"--hook",
			"PreToolUse",
			"--hook-json",
		]);

		expect(seen[0]?.path).toBe("/api/hooks/notifications");
		expect(seen[0]?.body).toContain('"hook":"PreToolUse"');
		expect(JSON.parse(lines[0] ?? "{}")).toEqual({
			continue: true,
			suppressOutput: true,
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				additionalContext: "peer context",
			},
		});
	});

	test("hook command can emit Codex user-prompt-submit JSON", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerHookCommands(program, {
			AGENTS_DIR: "/tmp/agents",
			uploadTranscriptFile: noUpload,
			fetchDaemonResult: async () => ({
				ok: true,
				data: { inject: "recalled context" },
			}),
			readStaticIdentity: () => null,
		});

		await program.parseAsync(["node", "test", "hook", "user-prompt-submit", "-H", "codex", "--codex-json"]);

		expect(JSON.parse(lines[0] ?? "{}")).toEqual({
			continue: true,
			suppressOutput: true,
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: "recalled context",
			},
		});
	});
});

describe("buildCompactionCompleteBody", () => {
	test("prefers explicit project input over cwd fallback for compaction lineage", () => {
		expect(
			buildCompactionCompleteBody(
				{
					signetAgentId: "agent-7",
					sessionKey: "sess-3",
					project: "/tmp/explicit-project",
					cwd: "/tmp/cwd-project",
				},
				"claude-code",
				"summary text",
			),
		).toEqual({
			harness: "claude-code",
			summary: "summary text",
			agentId: "agent-7",
			sessionKey: "sess-3",
			project: "/tmp/explicit-project",
			runtimePath: "legacy",
		});
	});

	test("preserves legacy session_id aliases for compaction lineage", () => {
		expect(
			buildCompactionCompleteBody(
				{
					signet_agent_id: "agent-8",
					project: "/tmp/legacy-project",
					sessionId: "sess-legacy-id",
				},
				"claude-code",
				"summary text",
			),
		).toEqual({
			agentId: "agent-8",
			harness: "claude-code",
			project: "/tmp/legacy-project",
			sessionKey: "sess-legacy-id",
			summary: "summary text",
			runtimePath: "legacy",
		});
	});

	test("preserves existing agentId and agent_id compaction input as Signet scope", () => {
		expect(
			buildCompactionCompleteBody(
				{
					agentId: "agent-9",
					agent_id: "agent-snake",
					sessionKey: "sess-5",
				},
				"custom-harness",
				"summary text",
			),
		).toEqual({
			agentId: "agent-9",
			harness: "custom-harness",
			sessionKey: "sess-5",
			summary: "summary text",
			runtimePath: "legacy",
		});
	});

	test("omits unset optional lineage fields instead of serializing blank strings", () => {
		expect(buildCompactionCompleteBody(null, "claude-code", "summary text")).toEqual({
			harness: "claude-code",
			summary: "summary text",
			runtimePath: "legacy",
		});
	});

	test("uses legacy agent_id values for compaction Signet scope outside Claude Code", () => {
		expect(
			buildCompactionCompleteBody(
				{
					agent_id: "research-agent",
					sessionKey: "sess-4",
				},
				"custom-harness",
				"summary text",
			),
		).toEqual({
			harness: "custom-harness",
			summary: "summary text",
			agentId: "research-agent",
			sessionKey: "sess-4",
			runtimePath: "legacy",
		});
	});

	test("does not scope compaction by a Claude Code native sub-agent id", () => {
		expect(
			buildCompactionCompleteBody({ agent_id: "claude-subagent", sessionKey: "sess-5" }, "claude-code", "summary")
				.agentId,
		).toBeFalsy();
	});
});

describe("shouldReadCompactionInput", () => {
	test("skips stdin when compaction lineage is fully provided on flags", () => {
		expect(
			shouldReadCompactionInput(false, {
				agentId: "agent-1",
				project: "/tmp/project",
				sessionKey: "sess-1",
			}),
		).toBeFalse();
	});
});

describe("readJson cleanup", () => {
	test("closes stdin after the timeout so an abandoned hook cannot keep running", async () => {
		const input = new Readable({ read() {} });

		expect(await readJson(input)).toBeNull();
		expect(input.destroyed).toBe(true);
		expect(input.listenerCount("end")).toBe(0);
	});
});

describe("postAction exit behavior", () => {
	test("calls process.exit(0) after a successful hook command", async () => {
		const program = new Command();
		registerHookCommands(program, {
			AGENTS_DIR: "/tmp/agents",
			uploadTranscriptFile: noUpload,
			fetchDaemonResult: async () => ({ ok: true, data: {} }),
			readStaticIdentity: () => null,
		});

		await program.parseAsync(["node", "test", "hook", "session-end", "-H", "test-harness"]);

		expect(hookExitCodes).toEqual([0]);
	});

	test("calls process.exit(0) after a hook command with output", async () => {
		const lines: string[] = [];
		const prevLog = console.log;
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerHookCommands(program, {
			AGENTS_DIR: "/tmp/agents",
			uploadTranscriptFile: noUpload,
			fetchDaemonResult: async () => ({
				ok: true,
				data: { inject: "recalled context" },
			}),
			readStaticIdentity: () => null,
		});

		await program.parseAsync(["node", "test", "hook", "user-prompt-submit", "-H", "test-harness"]);

		expect(hookExitCodes).toEqual([0]);
		expect(lines).toContain("recalled context");

		console.log = prevLog;
	});

	test("preAction bypass via SIGNET_NO_HOOKS exits with code 0", async () => {
		const prev = process.env.SIGNET_NO_HOOKS;
		process.env.SIGNET_NO_HOOKS = "1";

		const program = new Command();
		registerHookCommands(program, {
			AGENTS_DIR: "/tmp/agents",
			uploadTranscriptFile: noUpload,
			fetchDaemonResult: async () => ({ ok: true, data: { memoriesSaved: 0 } }),
			readStaticIdentity: () => null,
		});

		await program.parseAsync(["node", "test", "hook", "session-end", "-H", "test-harness"]);
		expect(hookExitCodes.length).toBeGreaterThanOrEqual(1);
		for (const code of hookExitCodes) {
			expect(code).toBe(0);
		}

		if (prev === undefined) delete process.env.SIGNET_NO_HOOKS;
		else process.env.SIGNET_NO_HOOKS = prev;
	});

	test("error path calls process.exit(1) before postAction fires", async () => {
		const program = new Command();
		registerHookCommands(program, {
			AGENTS_DIR: "/tmp/agents",
			uploadTranscriptFile: noUpload,
			fetchDaemonResult: async () => ({
				ok: true,
				data: { error: "something went wrong" },
			}),
			readStaticIdentity: () => null,
		});

		await program.parseAsync(["node", "test", "hook", "session-start", "-H", "test-harness"]);
		expect(hookExitCodes.length).toBeGreaterThanOrEqual(1);
		expect(hookExitCodes[0]).toBe(1);
	});
});

describe("hook wake", () => {
	interface WakeHarness {
		readonly bodies: Record<string, unknown>[];
		readonly timeouts: Array<number | undefined>;
		readonly sleeps: number[];
		readonly lines: string[];
		readonly stderr: string[];
		run: (args: string[], stdin?: Record<string, unknown>) => Promise<void>;
	}

	type Step = { ok: true; data: Record<string, unknown> } | { ok: false; reason: "offline" | "http" };

	function setup(steps: Step[], clockStepMs = 0): WakeHarness {
		const bodies: Record<string, unknown>[] = [];
		const timeouts: Array<number | undefined> = [];
		const sleeps: number[] = [];
		const lines: string[] = [];
		const stderr: string[] = [];
		let clock = 0;
		let idx = 0;
		return {
			bodies,
			timeouts,
			sleeps,
			lines,
			stderr,
			run: async (args, stdin) => {
				console.log = (line?: unknown) => {
					lines.push(String(line ?? ""));
				};
				const origWrite = process.stderr.write;
				process.stderr.write = ((chunk: unknown) => {
					stderr.push(String(chunk));
					return true;
				}) as typeof process.stderr.write;
				try {
					const program = new Command();
					registerHookCommands(program, {
						AGENTS_DIR: "/tmp/agents",
						uploadTranscriptFile: noUpload,
						fetchDaemonResult: (async (_path: string, opts?: RequestInit & { timeout?: number }) => {
							bodies.push(JSON.parse(typeof opts?.body === "string" ? opts.body : "{}"));
							timeouts.push(opts?.timeout);
							clock += clockStepMs;
							const step = steps[Math.min(idx, steps.length - 1)];
							idx++;
							return step;
						}) as never,
						readStaticIdentity: () => null,
						sleep: async (ms) => {
							sleeps.push(ms);
							clock += ms;
						},
						now: () => clock,
						stdin: Readable.from(stdin ? [Buffer.from(JSON.stringify(stdin))] : []),
					});
					await program.parseAsync(["node", "test", "hook", "wake", ...args]);
				} finally {
					process.stderr.write = origWrite;
				}
			},
		};
	}

	const session = { session_id: "sess-1", cwd: "/tmp/proj" };

	test("wake writes inject to stderr and exits 2", async () => {
		const h = setup([{ ok: true, data: { wake: true, inject: "peer says hi", messageIds: ["m1"] } }]);
		await h.run(["-H", "claude-code"], session);
		expect(h.stderr.join("")).toContain("peer says hi");
		expect(hookExitCodes[0]).toBe(2);
		expect(h.bodies[0]).toMatchObject({
			harness: "claude-code",
			sessionKey: "sess-1",
			project: "/tmp/proj",
			waitMs: 25000,
		});
		expect(h.timeouts[0]).toBe(35000);
	});

	test("timeout loops until the deadline then exits 0", async () => {
		const h = setup([{ ok: true, data: { wake: false, reason: "timeout" } }], 25000);
		await h.run(["-H", "claude-code", "--max-wait-seconds", "100"], session);
		expect(h.bodies.length).toBe(4);
		expect(h.sleeps).toEqual([]);
		expect(hookExitCodes[0]).toBe(0);
		expect(h.stderr.join("")).toBe("");
	});

	test("superseded exits 0 after one request", async () => {
		const h = setup([{ ok: true, data: { wake: false, reason: "superseded" } }]);
		await h.run(["-H", "claude-code"], session);
		expect(h.bodies.length).toBe(1);
		expect(hookExitCodes[0]).toBe(0);
	});

	test("rate_limited sleeps retryAfterMs then retries", async () => {
		const h = setup([
			{ ok: true, data: { wake: false, reason: "rate_limited", retryAfterMs: 4000 } },
			{ ok: true, data: { wake: true, inject: "later", messageIds: [] } },
		]);
		await h.run(["-H", "claude-code"], session);
		expect(h.sleeps).toEqual([4000]);
		expect(h.bodies.length).toBe(2);
		expect(hookExitCodes[0]).toBe(2);
	});

	test("daemon unreachable backs off and caps at remaining time", async () => {
		const h = setup([{ ok: false, reason: "offline" }]);
		await h.run(["-H", "claude-code", "--max-wait-seconds", "20"], session);
		expect(h.sleeps).toEqual([15000, 5000]);
		expect(h.bodies.length).toBe(2);
		expect(hookExitCodes[0]).toBe(0);
	});

	test("--no-wait sends waitMs 0 once", async () => {
		const h = setup([{ ok: true, data: { wake: false, reason: "timeout" } }]);
		await h.run(["-H", "codex", "--no-wait"], session);
		expect(h.bodies.length).toBe(1);
		expect(h.bodies[0]?.waitMs).toBe(0);
		expect(h.sleeps).toEqual([]);
		expect(hookExitCodes[0]).toBe(0);
	});

	test("--hook-json prints block decision when woken", async () => {
		const h = setup([{ ok: true, data: { wake: true, inject: "continue with this", messageIds: ["m"] } }]);
		await h.run(["-H", "codex", "--no-wait", "--hook-json"], session);
		expect(JSON.parse(h.lines[0] ?? "{}")).toEqual({ decision: "block", reason: "continue with this" });
		expect(hookExitCodes[0]).toBe(0);
	});

	test("--hook-json prints {} when not woken or on error", async () => {
		const h = setup([{ ok: false, reason: "offline" }]);
		await h.run(["-H", "codex", "--no-wait", "--hook-json"], session);
		expect(h.lines).toEqual(["{}"]);
		expect(hookExitCodes[0]).toBe(0);
	});

	test("missing session key is silent", async () => {
		const h = setup([{ ok: true, data: { wake: true, inject: "x", messageIds: [] } }]);
		await h.run(["-H", "claude-code"], {});
		expect(h.bodies.length).toBe(0);
		expect(h.stderr.join("")).toBe("");
		expect(hookExitCodes[0]).toBe(0);

		const j = setup([]);
		await j.run(["-H", "codex", "--hook-json"], {});
		expect(j.lines).toEqual(["{}"]);
	});
});

describe("hook stop", () => {
	type StopResult =
		| { ok: true; data: Record<string, unknown> }
		| { ok: false; reason: "offline" | "http" | "timeout"; status?: number };

	async function runStop(
		stdin: Record<string, unknown>,
		replies: StopResult | StopResult[] = { ok: true, data: { recorded: true } },
		attemptMs = 0,
		sleepAdvanceMs?: number,
		now?: () => number,
	) {
		const queue = Array.isArray(replies) ? [...replies] : [replies];
		let clock = 1_000_000;
		const sleeps: number[] = [];
		const calls: Array<{ path: string; body: Record<string, unknown>; runtimePath: string | null; timeout?: number }> =
			[];
		const lines: string[] = [];
		const stderr: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};
		const origWrite = process.stderr.write;
		process.stderr.write = ((chunk: unknown) => {
			stderr.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const program = new Command();
			registerHookCommands(program, {
				AGENTS_DIR: "/tmp/agents",
				uploadTranscriptFile: noUpload,
				fetchDaemonResult: (async (path: string, opts?: RequestInit & { timeout?: number }) => {
					calls.push({
						path,
						body: JSON.parse(typeof opts?.body === "string" ? opts.body : "{}"),
						runtimePath: new Headers(opts?.headers).get("x-signet-runtime-path"),
						timeout: opts?.timeout,
					});
					clock += attemptMs;
					return (queue.length > 1 ? queue.shift() : queue[0]) as never;
				}) as never,
				readStaticIdentity: () => null,
				now: now ?? (() => clock),
				sleep: async (ms: number) => {
					sleeps.push(ms);
					clock += sleepAdvanceMs ?? ms;
				},
				stdin: Readable.from([Buffer.from(JSON.stringify(stdin))]),
			});
			await program.parseAsync(["node", "test", "hook", "stop", "-H", "claude-code"]);
		} finally {
			process.stderr.write = origWrite;
		}
		return { calls, lines, stderr, sleeps };
	}

	const payload = {
		session_id: "sess-stop",
		cwd: "/tmp/proj",
		hook_event_name: "Stop",
		stop_hook_active: false,
		last_assistant_message: "Final paragraph A.\n\nFinal paragraph B.",
	};

	test("sends the turn-end reply to the daemon and prints nothing", async () => {
		const run = await runStop(payload);

		expect(run.calls).toEqual([
			{
				path: "/api/hooks/stop",
				body: {
					harness: "claude-code",
					sessionKey: "sess-stop",
					cwd: "/tmp/proj",
					lastAssistantMessage: "Final paragraph A.\n\nFinal paragraph B.",
					runtimePath: "legacy",
				},
				runtimePath: "legacy",
				timeout: 10_000,
			},
		]);
		expect(run.lines).toEqual([]);
		expect(run.stderr).toEqual([]);
		expect(hookExitCodes).toEqual([0]);
	});

	test("keeps the Claude Code subagent id out of the Signet agent scope", async () => {
		const native = await runStop({ ...payload, agent_id: "claude-subagent" });
		expect(native.calls[0]?.body.agentId).toBeUndefined();

		const signet = await runStop({ ...payload, agent_id: "claude-subagent", signet_agent_id: "research-agent" });
		expect(signet.calls[0]?.body.agentId).toBe("research-agent");
	});

	test("skips the daemon when the payload has no reply or no session", async () => {
		for (const stdin of [
			{ ...payload, last_assistant_message: "   " },
			{ ...payload, session_id: undefined },
		]) {
			const run = await runStop(stdin);
			expect(run.calls).toEqual([]);
			expect(run.stderr).toEqual([]);
		}
		expect(hookExitCodes).toEqual([0, 0]);
	});

	test("exits 0 without output when the daemon is down or rejects the reply", async () => {
		const offline = await runStop(payload, { ok: false, reason: "offline" });
		const busy = await runStop(payload, { ok: false, reason: "http", status: 503 });

		expect(offline.lines).toEqual([]);
		expect(busy.lines).toEqual([]);
		expect(busy.stderr.join("")).toContain("HTTP 503");
		expect(hookExitCodes).toEqual([0, 0]);
	});

	test("retries an HTTP 503 once and records the reply on the second attempt", async () => {
		const run = await runStop(payload, [
			{ ok: false, reason: "http", status: 503 },
			{ ok: true, data: { recorded: true } },
		]);

		expect(run.calls).toHaveLength(2);
		expect(run.calls[1]?.body).toEqual(run.calls[0]?.body);
		expect(run.sleeps).toEqual([1_000]);
		expect(run.lines).toEqual([]);
		expect(run.stderr).toEqual([]);
		expect(hookExitCodes).toEqual([0]);
	});

	test("stops after three attempts when the daemon keeps answering 503", async () => {
		const run = await runStop(payload, { ok: false, reason: "http", status: 503 });

		expect(run.calls).toHaveLength(3);
		expect(run.sleeps).toEqual([1_000, 1_000]);
		expect(run.lines).toEqual([]);
		expect(run.stderr.join("")).toContain("HTTP 503");
		expect(hookExitCodes).toEqual([0]);
	});

	test("does not retry other statuses, timeouts, or an offline daemon", async () => {
		for (const result of [
			{ ok: false, reason: "http", status: 500 },
			{ ok: false, reason: "timeout" },
			{ ok: false, reason: "offline" },
		] as StopResult[]) {
			const run = await runStop(payload, result);
			expect(run.calls).toHaveLength(1);
			expect(run.sleeps).toEqual([]);
		}
	});

	test("gives each attempt only the time left before the 10 second deadline", async () => {
		const run = await runStop(payload, { ok: false, reason: "http", status: 503 }, 3_000);

		expect(run.calls.map((call) => call.timeout)).toEqual([10_000, 6_000, 2_000]);
		expect(run.sleeps).toEqual([1_000, 1_000]);
	});

	test("skips the retry when the sleep would leave no attempt budget", async () => {
		const run = await runStop(payload, { ok: false, reason: "http", status: 503 }, 9_000);

		expect(run.calls).toHaveLength(1);
		expect(run.sleeps).toEqual([]);
	});

	test("checks the same positive budget it passes to each stop request", async () => {
		const ticks = [0, 0, 0, 9_999, 10_000];
		const run = await runStop(
			payload,
			{ ok: false, reason: "http", status: 503 },
			0,
			undefined,
			() => ticks.shift() ?? 10_000,
		);
		expect(run.calls).toHaveLength(1);
		expect(run.calls.every((call) => (call.timeout ?? 0) > 0)).toBe(true);
		expect(run.stderr.join("")).toContain("timed out");
	});

	test("stops without another attempt when the clock passes the deadline during the retry sleep", async () => {
		const run = await runStop(
			payload,
			[
				{ ok: false, reason: "http", status: 503 },
				{ ok: true, data: { recorded: true } },
			],
			0,
			20_000,
		);

		expect(run.calls).toHaveLength(1);
		expect(run.stderr.join("")).not.toBe("");
	});
});

describe("hook transcript upload", () => {
	interface Upload {
		readonly target: TranscriptUploadTarget;
		readonly path: string;
		readonly timeoutMs: number;
		readonly runtimePath: string;
	}

	type Uploader = (events: readonly string[]) => Promise<TranscriptUploadOutcome>;

	const uploaded: Uploader = async () => ({ status: "uploaded", committedOffset: 2, generation: 0 });
	const unsupported: Uploader = async () => ({ status: "unsupported" });

	const AGENT_ENV = ["SIGNET_AGENT_ID", "SIGNET_API_KEY", "SIGNET_TOKEN"] as const;

	async function runHook(
		args: string[],
		stdin: Record<string, unknown>,
		upload: Uploader,
		env: Partial<Record<(typeof AGENT_ENV)[number], string>> = {},
	) {
		const saved = AGENT_ENV.map((name) => [name, process.env[name]] as const);
		for (const name of AGENT_ENV) {
			const value = env[name];
			if (value === undefined) Reflect.deleteProperty(process.env, name);
			else process.env[name] = value;
		}
		const events: string[] = [];
		const uploads: Upload[] = [];
		const bodies: Record<string, unknown>[] = [];
		const stderr: string[] = [];
		console.log = () => undefined;
		const origWrite = process.stderr.write;
		process.stderr.write = ((chunk: unknown) => {
			stderr.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const program = new Command();
			registerHookCommands(program, {
				AGENTS_DIR: "/tmp/agents",
				fetchDaemonResult: async (path, opts) => {
					events.push(`request ${path}`);
					bodies.push(JSON.parse(typeof opts?.body === "string" ? opts.body : "{}"));
					return { ok: true, data: {} };
				},
				uploadTranscriptFile: async (target, path, timeoutMs, runtimePath) => {
					events.push("upload");
					uploads.push({ target, path, timeoutMs, runtimePath });
					return await upload(events);
				},
				readStaticIdentity: () => null,
				stdin: Readable.from([Buffer.from(JSON.stringify(stdin))]),
			});
			await program.parseAsync(["node", "test", "hook", ...args]);
		} finally {
			process.stderr.write = origWrite;
			for (const [name, value] of saved) {
				if (value === undefined) Reflect.deleteProperty(process.env, name);
				else process.env[name] = value;
			}
		}
		return { events, uploads, bodies, stderr };
	}

	const ending = {
		session_id: "sess-1",
		transcript_path: "/tmp/session.jsonl",
		cwd: "/repo",
		reason: "exit",
		signet_agent_id: "agent-7",
	};

	test("session-end uploads the transcript before it ends the session and sends no path", async () => {
		const run = await runHook(["session-end", "-H", "claude-code"], ending, uploaded);
		expect(run.events).toEqual(["upload", "request /api/hooks/session-end"]);
		expect(run.uploads).toEqual([
			{
				target: { harness: "claude-code", sessionKey: "sess-1", agentId: "agent-7", cwd: "/repo" },
				path: "/tmp/session.jsonl",
				timeoutMs: 8000,
				runtimePath: "legacy",
			},
		]);
		expect(run.bodies[0]).not.toHaveProperty("transcriptPath");
		expect(run.bodies[0]?.agentId).toBe("agent-7");
	});

	const anonymous = { session_id: "sess-1", transcript_path: "/tmp/session.jsonl", cwd: "/repo" };

	test("session-end leaves the agent to the daemon when nothing names one", async () => {
		const run = await runHook(["session-end", "-H", "claude-code"], anonymous, uploaded);
		expect(run.uploads[0]?.target).not.toHaveProperty("agentId");
		expect(run.bodies[0]).not.toHaveProperty("agentId");
	});

	test("session-end ignores the hook's SIGNET_AGENT_ID and leaves the agent to the daemon", async () => {
		const run = await runHook(["session-end", "-H", "claude-code"], anonymous, uploaded, {
			SIGNET_AGENT_ID: "env-agent",
		});
		expect(run.uploads[0]?.target).not.toHaveProperty("agentId");
		expect(run.bodies[0]).not.toHaveProperty("agentId");
	});

	test("session-end leaves the agent to the token scope when an API key is set", async () => {
		const run = await runHook(["session-end", "-H", "claude-code"], anonymous, uploaded, {
			SIGNET_API_KEY: "sig_sk_test",
		});
		expect(run.uploads[0]?.target).not.toHaveProperty("agentId");
		expect(run.bodies[0]).not.toHaveProperty("agentId");
	});

	test("session-end leaves the agent to an agent session key", async () => {
		const run = await runHook(
			["session-end", "-H", "claude-code"],
			{ session_key: "agent:keyed:main", transcript_path: "/tmp/session.jsonl", cwd: "/repo" },
			uploaded,
		);
		expect(run.uploads[0]?.target).not.toHaveProperty("agentId");
		expect(run.bodies[0]).not.toHaveProperty("agentId");
	});

	test("session-end sends the path to a daemon without the upload route", async () => {
		const run = await runHook(["session-end", "-H", "claude-code"], ending, unsupported);
		expect(run.bodies[0]?.transcriptPath).toBe("/tmp/session.jsonl");
	});

	test("session-end warns and still ends the session when the upload fails", async () => {
		const run = await runHook(["session-end", "-H", "claude-code"], ending, async () => {
			throw new Error("daemon busy");
		});
		expect(run.events).toEqual(["upload", "request /api/hooks/session-end"]);
		expect(run.bodies[0]).not.toHaveProperty("transcriptPath");
		expect(run.stderr.join("")).toContain(
			"[signet] transcript upload failed (daemon busy); the daemon keeps the lines it already has",
		);
	});

	test("session-end skips the upload when the harness gives no transcript file", async () => {
		const run = await runHook(["session-end", "-H", "codex"], { session_id: "sess-1", cwd: "/repo" }, uploaded);
		expect(run.events).toEqual(["request /api/hooks/session-end"]);
	});

	test("user-prompt-submit uploads the transcript while it asks for context", async () => {
		let during: string[] = [];
		const run = await runHook(
			["user-prompt-submit", "-H", "claude-code", "--project", "/repo"],
			{ session_id: "sess-1", transcript_path: "/tmp/session.jsonl", cwd: "/repo", prompt: "hi" },
			async (events) => {
				await Bun.sleep(50);
				during = [...events];
				return { status: "uploaded", committedOffset: 2, generation: 0 };
			},
		);
		expect(during).toContain("request /api/hooks/user-prompt-submit");
		expect(run.uploads[0]?.timeoutMs).toBe(5000);
		expect(run.uploads[0]?.target).toEqual({
			harness: "claude-code",
			sessionKey: "sess-1",
			cwd: "/repo",
		});
		expect(run.bodies[0]).not.toHaveProperty("transcriptPath");
	});

	test("user-prompt-submit leaves the agent to the daemon in the upload and the prompt request", async () => {
		const run = await runHook(
			["user-prompt-submit", "-H", "claude-code", "--project", "/repo"],
			{ session_id: "sess-1", transcript_path: "/tmp/session.jsonl", cwd: "/repo", prompt: "hi" },
			uploaded,
			{ SIGNET_AGENT_ID: "agent-x" },
		);
		expect(run.uploads[0]?.target).not.toHaveProperty("agentId");
		expect(run.bodies[0]).not.toHaveProperty("agentId");
	});

	test("user-prompt-submit names the payload agent in the upload and the prompt request", async () => {
		const run = await runHook(
			["user-prompt-submit", "-H", "claude-code", "--project", "/repo"],
			{
				session_id: "sess-1",
				transcript_path: "/tmp/session.jsonl",
				cwd: "/repo",
				prompt: "hi",
				signet_agent_id: "agent-7",
			},
			uploaded,
			{ SIGNET_AGENT_ID: "agent-x" },
		);
		expect(run.uploads[0]?.target.agentId).toBe("agent-7");
		expect(run.bodies[0]?.agentId).toBe("agent-7");
	});

	test("pre-compaction uploads the transcript before it asks for the summary prompt", async () => {
		const stdin = { session_id: "sess-1", transcript_path: "/tmp/session.jsonl", cwd: "/repo" };
		const run = await runHook(["pre-compaction", "-H", "claude-code", "--project", "/repo"], stdin, uploaded);
		expect(run.events).toEqual(["upload", "request /api/hooks/pre-compaction"]);
		expect(run.uploads[0]?.timeoutMs).toBe(3000);
		expect(run.uploads[0]?.target).not.toHaveProperty("agentId");
		expect(run.bodies[0]).not.toHaveProperty("agentId");
		expect(run.bodies[0]).not.toHaveProperty("transcriptPath");
		const old = await runHook(["pre-compaction", "-H", "claude-code", "--project", "/repo"], stdin, unsupported);
		expect(old.bodies[0]?.transcriptPath).toBe("/tmp/session.jsonl");
	});
});
