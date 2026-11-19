import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "signet-hermes-recall-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function py(lines: readonly string[]): unknown {
	const dir = mkdtempSync(join(root, "fx-"));
	cpSync(join(import.meta.dir, "hermes-plugin"), join(dir, "plugins", "memory", "signet"), { recursive: true });
	mkdirSync(join(dir, "agent"), { recursive: true });
	for (const file of [
		join("agent", "__init__.py"),
		join("plugins", "__init__.py"),
		join("plugins", "memory", "__init__.py"),
	]) {
		writeFileSync(join(dir, file), "");
	}
	writeFileSync(join(dir, "agent", "memory_provider.py"), "class MemoryProvider:\n    pass\n");
	const result = spawnSync(process.env.PYTHON?.trim() || "python3", ["-c", [...PRELUDE, ...lines].join("\n")], {
		cwd: dir,
		env: { ...process.env, PYTHONPATH: dir, SIGNET_DAEMON_URL: "", SIGNET_PATH: join(dir, "no-agents") },
		encoding: "utf-8",
		timeout: 20_000,
	});
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout);
}

const PRELUDE = [
	"import json, time",
	"import plugins.memory.signet as sig",
	"submitted = []",
	"class FakeClient:",
	"    delays = {}",
	"    def user_prompt_submit(self, key, msg, **kw):",
	"        submitted.append([key, msg, kw.get('last_assistant_message')])",
	"        time.sleep(self.delays.get(msg, 0))",
	"        return {'inject': 'recall for ' + msg}",
	"    def session_start(self, key, **kw): return {}",
	"    def notifications(self, key, hook, **kw): return {}",
	"p = sig.SignetMemoryProvider()",
	"p._client = FakeClient()",
	"p._session_key = 'sess-1'",
	"p._session_initialized = True",
	"def turn(message, reply):",
	"    p.on_turn_start(1, message)",
	"    started = time.monotonic()",
	"    context = p.prefetch(message, session_id='sess-1')",
	"    waited = time.monotonic() - started",
	"    p.sync_turn(message, reply, session_id='sess-1')",
	"    p.queue_prefetch(message, session_id='sess-1')",
	"    return context, waited",
];

describe("Hermes prompt recall timing", () => {
	it("returns each message's recall on the same turn and submits it once", () => {
		const out = py([
			"first = turn('who produced SXRS?', 'Franco Picache.')",
			"second = turn('what about KNL?', 'Nick Mays.')",
			"print(json.dumps({'contexts': [first[0], second[0]], 'submitted': submitted}))",
		]) as { contexts: string[]; submitted: Array<[string, string, string]> };

		expect(out.contexts).toEqual(["recall for who produced SXRS?", "recall for what about KNL?"]);
		expect(out.submitted).toEqual([
			["sess-1", "who produced SXRS?", ""],
			["sess-1", "what about KNL?", "Franco Picache."],
		]);
	});

	it("bounds the wait and delivers a slow answer with the next turn", () => {
		const out = py([
			"FakeClient.delays = {'slow question': 4}",
			"slow = turn('slow question', 'ok')",
			"time.sleep(1.5)",
			"fast = turn('fast question', 'ok')",
			"print(json.dumps({'slow': slow[0], 'waited': slow[1], 'fast': fast[0]}))",
		]) as { slow: string; waited: number; fast: string };

		expect(out.slow).toBe("");
		expect(out.waited).toBeLessThan(3.5);
		expect(out.fast).toBe("recall for slow question\nrecall for fast question");
	}, 20_000);

	it("drops a slow answer when the session changes before it arrives", () => {
		const out = py([
			"FakeClient.delays = {'slow question': 3.5}",
			"turn('slow question', 'ok')",
			"p.on_session_switch('sess-2', reset=True)",
			"time.sleep(1)",
			"p._session_initialized = True",
			"context = p.prefetch('next question', session_id='sess-2')",
			"print(json.dumps({'context': context, 'keys': [s[0] for s in submitted]}))",
		]) as { context: string; keys: string[] };

		expect(out.context).toBe("recall for next question");
		expect(out.keys).toEqual(["sess-1", "sess-2"]);
	}, 20_000);
});
