import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
	buildCodexHookOutput,
	buildCompactionCompleteBody,
	buildSessionEndBody,
	buildSessionStartBody,
	buildSessionStartFallback,
	buildUserPromptSubmitBody,
	pickSessionKey,
	registerHookCommands,
	resolvePromptSubmitTimeout,
	resolveSessionStartTimeout,
	shouldReadCompactionInput,
} from "./hook";

const prevLog = console.log;

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
		process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT = prev;
	});

	test("falls back to the default when env is invalid or too small", () => {
		const prev = process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT;
		process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT = "200";
		expect(resolvePromptSubmitTimeout()).toBe(5000);
		process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT = prev;
	});
});

describe("resolveSessionStartTimeout", () => {
	test("uses the dedicated session-start timeout env when valid", () => {
		const prev = process.env.SIGNET_SESSION_START_TIMEOUT;
		process.env.SIGNET_SESSION_START_TIMEOUT = "18000";
		expect(resolveSessionStartTimeout()).toBe(18000);
		process.env.SIGNET_SESSION_START_TIMEOUT = prev;
	});

	test("falls back to the default when env is invalid or too small", () => {
		const prev = process.env.SIGNET_SESSION_START_TIMEOUT;
		process.env.SIGNET_SESSION_START_TIMEOUT = "200";
		expect(resolveSessionStartTimeout()).toBe(15000);
		process.env.SIGNET_SESSION_START_TIMEOUT = prev;
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
			transcriptPath: "/tmp/session.txt",
			transcript: "user: hi\nassistant: hello",
			sessionId: "sess-1",
			sessionKey: "sess-1",
			cwd: "/tmp/project",
			reason: "shutdown",
			runtimePath: "legacy",
		});
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
			transcriptPath: "/tmp/session.txt",
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
			transcriptPath: "",
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
			transcriptPath: "",
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
			transcriptPath: "",
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
			transcriptPath: "",
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
			transcriptPath: "",
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

	test("hook command can emit Codex user-prompt-submit JSON", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerHookCommands(program, {
			AGENTS_DIR: "/tmp/agents",
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

	test("uses legacy agent_id values for compaction Signet scope", () => {
		expect(
			buildCompactionCompleteBody(
				{
					agent_id: "research-agent",
					sessionKey: "sess-4",
				},
				"claude-code",
				"summary text",
			),
		).toEqual({
			harness: "claude-code",
			summary: "summary text",
			agentId: "research-agent",
			sessionKey: "sess-4",
			runtimePath: "legacy",
		});
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
