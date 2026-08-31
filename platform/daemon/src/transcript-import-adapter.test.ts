import { describe, expect, test } from "bun:test";
import {
	validateSignetExport,
	conversationFingerprint,
	canonicalTranscriptIdentity,
} from "./transcript-import-adapter";

describe("signet-export-v1 adapter", () => {
	const record = {
		id: "r1",
		source: "signet",
		harness: "hermes",
		agent_id: "a",
		session_key: "s",
		project: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message_count: 2,
		messages: [
			{ role: "user", content: "  hello\nworld  " },
			{ role: "tool", content: "" },
		],
	};
	test("preserves lossless message content and deterministic identities", () => {
		const parsed = validateSignetExport(record);
		expect(parsed.messages[0]?.content).toBe("  hello\nworld  ");
		expect(conversationFingerprint(parsed)).toBe(conversationFingerprint(validateSignetExport({ ...record })));
		expect(canonicalTranscriptIdentity(parsed).canonicalId).toMatch(/^import:[0-9a-f]{64}$/);
	});
	test("rejects unknown roles and count mismatches", () => {
		expect(() => validateSignetExport({ ...record, messages: [{ role: "bogus", content: "x" }] })).toThrow();
		expect(() => validateSignetExport({ ...record, message_count: 1 })).toThrow();
	});
});
