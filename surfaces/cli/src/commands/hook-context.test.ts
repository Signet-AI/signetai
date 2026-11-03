import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { buildPeerContext, extractMutatedPaths, registerHookCommands } from "./hook";

const originalExit = process.exit;
const originalLog = console.log;
const dirs: string[] = [];

beforeAll(() => {
	process.exit = (() => undefined) as typeof process.exit;
});
afterAll(() => {
	process.exit = originalExit;
});
afterEach(() => {
	console.log = originalLog;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function transcript(lines: unknown[]): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-hook-ctx-"));
	dirs.push(dir);
	const path = join(dir, "t.jsonl");
	writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
	return path;
}

async function run(args: string[], stdin: Record<string, unknown>) {
	const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
	console.log = () => undefined;
	const program = new Command();
	registerHookCommands(program, {
		AGENTS_DIR: "/tmp/agents",
		fetchDaemonResult: async (path, opts) => {
			seen.push({ path, body: JSON.parse(String(opts?.body ?? "{}")) });
			return { ok: true, data: { wake: false, reason: "timeout", inject: "" } } as never;
		},
		readStaticIdentity: () => null,
		stdin: Readable.from([Buffer.from(JSON.stringify(stdin))]),
	});
	await program.parseAsync(["node", "test", "hook", ...args]);
	return seen;
}

describe("extractMutatedPaths", () => {
	test("reads only known mutating tools", () => {
		expect(extractMutatedPaths("Write", { file_path: "/a.ts" })).toEqual(["/a.ts"]);
		expect(extractMutatedPaths("NotebookEdit", { notebook_path: "/n.ipynb" })).toEqual(["/n.ipynb"]);
		expect(
			extractMutatedPaths("apply_patch", {
				command: "*** Begin Patch\n*** Update File: src/x.ts\n*** Add File: y.ts\n",
			}),
		).toEqual(["src/x.ts", "y.ts"]);
		expect(extractMutatedPaths("Bash", { command: "echo hi > /a.ts" })).toEqual([]);
		expect(extractMutatedPaths("Read", { file_path: "/a.ts" })).toEqual([]);
	});
});

describe("hook peer context", () => {
	test("user-prompt-submit sends cwd, hostname and no raw-prompt task, with transcript-observed edits/title", async () => {
		const t = transcript([
			{
				type: "assistant",
				message: {
					content: [
						{ type: "tool_use", id: "ok1", name: "Edit", input: { file_path: "src/a.ts" } },
						{ type: "tool_use", id: "bad", name: "Write", input: { file_path: "src/failed.ts" } },
						{ type: "tool_use", id: "pending", name: "Write", input: { file_path: "src/pending.ts" } },
					],
				},
			},
			{
				type: "user",
				message: {
					content: [
						{ type: "tool_result", tool_use_id: "ok1", content: "ok" },
						{ type: "tool_result", tool_use_id: "bad", is_error: true, content: "denied" },
					],
				},
			},
			{ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "touch z" } }] } },
			{ customTitle: "GPU debugging" },
		]);
		const seen = await run(["user-prompt-submit", "-H", "claude-code"], {
			session_id: "s1",
			cwd: "/work/p",
			prompt: `fix ${"it ".repeat(300)}`,
			transcript_path: t,
		});
		const context = seen[0]?.body.context as Record<string, unknown>;
		expect(context).toMatchObject({
			cwd: "/work/p",
			hostname: hostname(),
			title: "GPU debugging",
			modifiedFiles: ["/work/p/src/a.ts"],
		});
		expect(Object.keys(context).sort()).toEqual(["cwd", "hostname", "modifiedFiles", "title"]);
		expect(seen[0]?.body.userMessage ?? seen[0]?.body.prompt).toContain("fix it it");
		expect(JSON.stringify(context)).not.toContain("fix it");
	});

	test("does not fabricate title or files when the harness exposes none", async () => {
		const context = await buildPeerContext({ cwd: "/p" }, {});
		expect(context).toEqual({ cwd: "/p", hostname: hostname() });
	});

	test("session-start omits task and PreToolUse intent is not advertised as a modification", async () => {
		const start = await run(["session-start", "-H", "codex"], { session_id: "s2", cwd: "/w", prompt: "ignored" });
		expect(start[0]?.body.context).toEqual({ cwd: "/w", hostname: hostname() });
		const notif = await run(["notifications", "-H", "codex", "--hook", "PreToolUse"], {
			session_id: "s2",
			cwd: "/w",
			tool_name: "apply_patch",
			tool_input: { command: "*** Begin Patch\n*** Update File: a.rs\n*** End Patch" },
		});
		expect(notif[0]?.body.context).toEqual({ cwd: "/w", hostname: hostname() });
	});

	test("wake loop advertises context so a waiting session carries it", async () => {
		const seen = await run(["wake", "-H", "codex", "--no-wait"], { session_id: "s3", cwd: "/w" });
		expect(seen[0]?.path).toBe("/api/cross-agent/wake");
		expect(seen[0]?.body.context).toEqual({ cwd: "/w", hostname: hostname() });
	});
});

describe("hook peer context hardening", () => {
	test("confirms codex call_id results", async () => {
		const t = transcript([
			{ payload: { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "*** Update File: a.rs\n" } },
			{
				payload: {
					type: "custom_tool_call_output",
					call_id: "c1",
					output: JSON.stringify({ metadata: { exit_code: 1 } }),
				},
			},
			{
				payload: {
					type: "function_call",
					call_id: "c2",
					name: "Write",
					arguments: JSON.stringify({ file_path: "/b.rs" }),
				},
			},
			{ payload: { type: "function_call_output", call_id: "c2", output: "done" } },
		]);
		const ctx = await buildPeerContext(
			{ cwd: "/w", transcript_path: t },
			{ task: "deploy with sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF" },
		);
		expect(ctx?.modifiedFiles).toEqual(["/b.rs"]);
		expect(ctx).not.toHaveProperty("task");
		expect(JSON.stringify(ctx)).not.toContain("sk-secret");
	});

	test("omits over-limit paths instead of truncating identity", async () => {
		const long = `/w/${"d/".repeat(200)}file.ts`;
		const t = transcript([
			{
				type: "assistant",
				message: {
					content: [
						{ type: "tool_use", id: "a", name: "Edit", input: { file_path: long } },
						{ type: "tool_use", id: "b", name: "Edit", input: { file_path: "/w/ok.ts" } },
					],
				},
			},
			{
				type: "user",
				message: {
					content: [
						{ type: "tool_result", tool_use_id: "a", content: "ok" },
						{ type: "tool_result", tool_use_id: "b", content: "ok" },
					],
				},
			},
			{ customTitle: "T" },
		]);
		const ctx = await buildPeerContext({ cwd: "/w", transcript_path: t }, {});
		expect(ctx?.modifiedFiles).toEqual(["/w/ok.ts"]);
		expect(ctx?.title).toBe("T");
		expect(ctx?.cwd).toBe("/w");
	});

	test("unreadable transcript yields no files and does not throw", async () => {
		expect(await buildPeerContext({ cwd: "/w", transcript_path: "/nonexistent/x.jsonl" }, {})).toEqual({
			cwd: "/w",
			hostname: hostname(),
		});
	});
});
