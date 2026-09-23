import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { parseTranscriptMessages, registerExportTranscriptsCommand } from "./export-transcripts";
import { registerPortableCommands } from "./portable";

describe("parseTranscriptMessages", () => {
	test("parses role-prefixed text with multi-line accumulation", () => {
		const content = "User: first line\nsecond line\nAssistant: reply one\nAssistant: reply two";
		expect(parseTranscriptMessages(content)).toEqual([
			{ role: "user", content: "first line\nsecond line" },
			{ role: "assistant", content: "reply one" },
			{ role: "assistant", content: "reply two" },
		]);
	});

	test("normalizes human and tool_result prefixes", () => {
		expect(parseTranscriptMessages("Human: hi\ntool_result: exit 0\nAssistant: done")).toEqual([
			{ role: "user", content: "hi" },
			{ role: "tool", content: "exit 0" },
			{ role: "assistant", content: "done" },
		]);
	});

	test("parses JSONL content when it has at least two messages", () => {
		const content = '{"role":"user","content":"hi"}\n{"role":"assistant","content":"hey"}';
		expect(parseTranscriptMessages(content)).toEqual([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hey" },
		]);
	});

	test("falls back to prefix parsing when JSONL has fewer than two messages", () => {
		const content = '{"role":"user","content":"hi"}\nAssistant: hey';
		expect(parseTranscriptMessages(content)).toEqual([{ role: "assistant", content: "hey" }]);
	});

	test("splits role-prefix lines containing literal carriage returns", () => {
		// Regression: git output embeds \r separators (e.g. "Rebasing (1/1)\rDone").
		// JS regex `.` does not match \r, so a "Tool:" line with an interior \r
		// failed the whole prefix match and was absorbed into the previous
		// message; the Python aggregator's splitlines() splits on \r. The parser
		// must match splitlines() or export output drifts from the pipeline it
		// replaces.
		const content = "Assistant: rebase it\nTool: Rebasing (1/1)\rSuccessfully rebased\nAssistant: done";
		expect(parseTranscriptMessages(content)).toEqual([
			{ role: "assistant", content: "rebase it" },
			{ role: "tool", content: "Rebasing (1/1)\nSuccessfully rebased" },
			{ role: "assistant", content: "done" },
		]);
	});

	test("returns an empty list for content with no role markers", () => {
		expect(parseTranscriptMessages("plain text without roles")).toEqual([]);
	});
});

test("CLI streams the daemon export with all filters through the real command tree", async () => {
	const directory = await mkdtemp(join(tmpdir(), "signet-export-client-"));
	const output = join(directory, "export.jsonl");
	let requested = "";
	const program = new Command();
	registerPortableCommands(program, {
		AGENTS_DIR: directory,
		fetchDaemonStream: async (path) => {
			requested = path;
			return {
				ok: true,
				response: new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"messages":'));
							controller.enqueue(new TextEncoder().encode("[]}\n"));
							controller.close();
						},
					}),
				),
			};
		},
	});
	try {
		await program.parseAsync([
			"node",
			"test",
			"export",
			"transcripts",
			"--output",
			output,
			"--harness",
			"claude",
			"--agent",
			"a",
			"--since",
			"2026-01-01",
			"--until",
			"2026-01-02",
			"--offset",
			"2",
			"--limit",
			"3",
			"--messages-only",
		]);
		expect(await readFile(output, "utf8")).toBe('{"messages":[]}\n');
		const query = new URL(requested, "http://localhost").searchParams;
		expect(Object.fromEntries(query)).toMatchObject({
			harness: "claude",
			agentId: "a",
			since: "2026-01-01",
			until: "2026-01-02",
			offset: "2",
			limit: "3",
			messagesOnly: "true",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("CLI fails explicitly when the owner service is unavailable", async () => {
	const program = new Command();
	registerExportTranscriptsCommand(program.command("export"), {
		AGENTS_DIR: "unused",
		fetchDaemonStream: async () => ({ ok: false, reason: "offline" }),
	});
	let error: unknown;
	try {
		await program.parseAsync(["node", "test", "export", "transcripts"]);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(Error);
	expect(String(error)).toContain("offline");
});
