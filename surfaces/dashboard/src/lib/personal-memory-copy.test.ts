import { expect, test } from "bun:test";
import { parsePersonalMemories, personalMemoryCopy } from "./personal-memory-copy";

const first = {
	id: "first",
	content: "Keep runnable examples",
	agent_id: "personal",
	created_at: "2026-01-01",
	source_type: "manual",
	who: "Alice",
	project: "atlas",
};
const second = { id: "second", content: "Do not share this", agent_id: "personal" };

test("selected personal evidence keeps provenance without modifying its export", async () => {
	const original = `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`;
	const rows = parsePersonalMemories(original);
	const file = personalMemoryCopy(rows, ["first"], "personal");
	const copied = JSON.parse(await file.text());
	expect(copied).toEqual({ format: "signet-personal-evidence-v1", originalAgentId: "personal", memories: [first] });
	expect(original).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
	expect(rows).toHaveLength(2);
	expect(file.type).toBe("application/json;charset=utf-8");
	expect(await file.text()).not.toContain(second.content);
});

test("copy defaults to nothing and rejects foreign or ambiguous selections", () => {
	const rows = parsePersonalMemories(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
	expect(() => personalMemoryCopy(rows, [], "personal")).toThrow("Select at least one memory");
	expect(() => personalMemoryCopy(rows, ["missing"], "personal")).toThrow("Selection is unavailable");
	expect(() => personalMemoryCopy(rows, ["first"], "another")).toThrow("Selection is unavailable");
	expect(() => parsePersonalMemories(`${JSON.stringify(first)}\n${JSON.stringify(first)}`)).toThrow(
		"Duplicate memory identity",
	);
});

test("invalid, excessive and non-memory exports fail closed", () => {
	for (const value of [
		"{}",
		"null",
		'{"kind":"error","reason":"truncated"}',
		'{"id":"x","content":"hello"}',
		'{"id":"x","content":"","agent_id":"personal"}',
	])
		expect(() => parsePersonalMemories(value)).toThrow();
	expect(() => parsePersonalMemories("x".repeat(4 * 1024 * 1024 + 1))).toThrow("4 MiB");
});
