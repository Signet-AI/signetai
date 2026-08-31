import { describe, expect, test } from "bun:test";
import {
	buildCompletedTranscriptCommit,
	canonicalTranscriptLine,
	serializeCompletedTranscriptMessages,
} from "./transcript-import-commit";
import { signetExportV1Adapter } from "./transcript-import-adapter";

const record = (agent_id: string, content = "  exact\n\ntext  ") =>
	signetExportV1Adapter.parse({
		source: "signet",
		id: "conversation-1",
		harness: "claude",
		agent_id,
		session_key: "same-session",
		project: null,
		timestamp: "2024-01-01T00:00:00.000Z",
		message_count: 3,
		messages: [
			{ role: "system", content: "system\nline" },
			{ role: "tool", content: '{"x":1}' },
			{ role: "user", content },
		],
	});

describe("transcript import invariants", () => {
	test("lossless roles and whitespace are retained without role-prefixed text", () => {
		const commit = buildCompletedTranscriptCommit(record("agent-a"), {
			agentId: "agent-a",
			sourceId: "source-a",
			sourceRecordId: "record-a",
		});
		expect(commit.messages[0]).toEqual({ role: "system", content: "system\nline" });
		expect(serializeCompletedTranscriptMessages(commit.messages)).toContain("  exact\\n\\ntext  ");
		expect(canonicalTranscriptLine(commit)).toContain('"role":"tool"');
	});
	test("agent scope is part of deterministic identity", () => {
		const a = buildCompletedTranscriptCommit(record("agent-a"), {
			agentId: "agent-a",
			sourceId: "source-a",
			sourceRecordId: "record-a",
		});
		const b = buildCompletedTranscriptCommit(record("agent-b"), {
			agentId: "agent-b",
			sourceId: "source-a",
			sourceRecordId: "record-a",
		});
		expect(a.recordId).not.toBe(b.recordId);
		expect(a.canonicalId).not.toBe(b.canonicalId);
	});
	test("replay uses the same record id and canonical revision", () => {
		const input = { agentId: "agent-a", sourceId: "source-a", sourceRecordId: "record-a" } as const;
		expect(buildCompletedTranscriptCommit(record("agent-a"), input)).toEqual(
			buildCompletedTranscriptCommit(record("agent-a"), input),
		);
	});
});
