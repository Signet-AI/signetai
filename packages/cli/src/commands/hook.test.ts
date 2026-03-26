import { describe, expect, test } from "bun:test";
import {
	buildCompactionCompleteBody,
	buildSessionEndBody,
	buildUserPromptSubmitBody,
	pickSessionKey,
	shouldReadCompactionInput,
} from "./hook";

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
			lastAssistantMessage: "prior answer",
		});
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
		});
	});

	test("omits unset optional lineage fields instead of serializing blank strings", () => {
		expect(buildCompactionCompleteBody(null, "claude-code", "summary text")).toEqual({
			harness: "claude-code",
			summary: "summary text",
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
