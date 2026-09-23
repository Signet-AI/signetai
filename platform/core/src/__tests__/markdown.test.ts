import { describe, expect, test } from "bun:test";
import { buildArchitectureDoc, buildSignetBlock, stripSignetBlock } from "../markdown";

describe("buildSignetBlock", () => {
	test("returns empty string for compatibility", () => {
		const block = buildSignetBlock();
		expect(block).toBe("");
	});
});

describe("stripSignetBlock", () => {
	const start = "<!-- SIGNET:START -->";
	const end = "<!-- SIGNET:END -->";

	test("removes block from content", () => {
		const input = `before\n${start}\nsome content\n${end}\nafter`;
		expect(stripSignetBlock(input)).toBe("before\nafter");
	});

	test("removes trailing newline after end marker", () => {
		const input = `before\n${start}\ncontent\n${end}\n`;
		expect(stripSignetBlock(input)).toBe("before\n");
	});

	test("leaves content without block unchanged", () => {
		const input = "just regular content\nno markers here";
		expect(stripSignetBlock(input)).toBe(input);
	});

	test("removes multiple blocks", () => {
		const input = `a\n${start}\nb\n${end}\nc\n${start}\nd\n${end}\ne`;
		expect(stripSignetBlock(input)).toBe("a\nc\ne");
	});

	test("sync path invariant: buildSignetBlock never injects a new block", () => {
		// Regression guard: if buildSignetBlock were re-introduced in syncHarnessConfigs,
		// the synced output would contain a block. This asserts it cannot happen.
		const block = buildSignetBlock("/any/path");
		expect(block).toBe("");
		expect(stripSignetBlock(block)).toBe("");
	});
});

describe("buildArchitectureDoc", () => {
	test("explains identity stewardship and MEMORY.md ownership", () => {
		const doc = buildArchitectureDoc("/tmp/signet-agent");

		expect(doc).toContain("`/tmp/signet-agent/AGENTS.md`");
		expect(doc).toContain("Do not edit `/tmp/signet-agent/MEMORY.md` manually");
		expect(doc).toContain("Identity files are your durable substrate");
	});
});
