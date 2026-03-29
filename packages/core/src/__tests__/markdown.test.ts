import { describe, expect, test } from "bun:test";
import { buildArchitectureDoc, buildSignetBlock } from "../markdown";

describe("buildSignetBlock", () => {
	test("uses workspace-relative file references by default", () => {
		const block = buildSignetBlock();

		expect(block).toContain("`$SIGNET_WORKSPACE/AGENTS.md`");
		expect(block).toContain("`$SIGNET_WORKSPACE/MEMORY.md`");
		expect(block).toContain("Do not edit `MEMORY.md` manually");
		expect(block).toContain("maintain `AGENTS.md`,");
	});

	test("renders a custom workspace path when provided", () => {
		const block = buildSignetBlock("/tmp/signet-agent");

		expect(block).toContain("`/tmp/signet-agent/AGENTS.md`");
		expect(block).toContain("`/tmp/signet-agent/SIGNET-ARCHITECTURE.md`");
		expect(block).not.toContain("`~/.agents/AGENTS.md`");
	});

	test("references namespaced MCP tool IDs for secrets and knowledge graph", () => {
		const block = buildSignetBlock();

		expect(block).toContain("`mcp__signet__secret_list`");
		expect(block).toContain("`mcp__signet__secret_exec`");
		expect(block).toContain("`mcp__signet__knowledge_expand`");
		expect(block).toContain("`mcp__signet__knowledge_expand_session`");
		// bare names must not appear as tool references
		expect(block).not.toContain("`secret_list`");
		expect(block).not.toContain("`secret_exec`");
		expect(block).not.toContain("`knowledge_expand`");
		expect(block).not.toContain("`knowledge_expand_session`");
	});

	test("strips backticks and newlines from workspace path to prevent markdown injection", () => {
		const block = buildSignetBlock("/home/user/`rm -rf`/.agents");
		// backtick stripped — path should not break surrounding code spans
		expect(block).not.toContain("`rm -rf`");

		const withNewline = buildSignetBlock("/home/user\n/.agents");
		expect(withNewline).not.toContain("\n/");
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
