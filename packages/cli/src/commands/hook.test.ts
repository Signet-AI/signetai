import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
	buildCompactionCompleteBody,
	buildSessionEndBody,
	buildSessionStartFallback,
	buildUserPromptSubmitBody,
	pickSessionKey,
	registerHookCommands,
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

	test("hook command uses daemon result transport for user-prompt-submit", async () => {
		const seen: Array<{ path: string; body: string; runtimePath: string | null }> = [];
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
		expect(lines).toContain("recalled context");
	});
});

describe("buildCompactionCompleteBody", () => {
	test("prefers explicit project input over cwd fallback for compaction lineage", () => {
		expect(
			buildCompactionCompleteBody(
				{
					agentId: "agent-7",
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
					agentId: "agent-8",
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

	test("omits unset optional lineage fields instead of serializing blank strings", () => {
		expect(buildCompactionCompleteBody(null, "claude-code", "summary text")).toEqual({
			harness: "claude-code",
			summary: "summary text",
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
