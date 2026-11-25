import "../../../tests/support/connector-safety.js";
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
	"stopped = []",
	"class FakeClient:",
	"    agent_id = 'fixture-agent'",
	"    delays = {}",
	"    responses = {}",
	"    def user_prompt_submit(self, key, msg, **kw):",
	"        submitted.append([key, msg, kw.get('last_assistant_message', '')])",
	"        time.sleep(self.delays.get(msg, 0))",
	"        return {'inject': 'recall for ' + msg, **self.responses.get(msg, {})}",
	"    start_delay = 0",
	"    def session_start(self, key, **kw):",
	"        time.sleep(self.start_delay)",
	"        submitted.append(['session_start', key] + (['claim'] if kw.get('claim_only') else []))",
	"        return {'dynamicContext': 'start for ' + key}",
	"    def stop(self, key, reply, **kw): stopped.append([key, reply])",
	"    notes = {}",
	"    def notifications(self, key, hook, **kw):",
	"        time.sleep(self.notes.get('delay', 0))",
	"        return None if self.notes.get('fail') else {'inject': self.notes.get('inject', '')}",
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
			"print(json.dumps({'contexts': [first[0], second[0]], 'submitted': submitted, 'stopped': stopped}))",
		]) as { contexts: string[]; submitted: Array<[string, string, string]>; stopped: Array<[string, string]> };

		expect(out.contexts).toEqual(["recall for who produced SXRS?", "recall for what about KNL?"]);
		expect(out.submitted).toEqual([
			["sess-1", "who produced SXRS?", ""],
			["sess-1", "what about KNL?", ""],
		]);
		expect(out.stopped).toEqual([
			["sess-1", "Franco Picache."],
			["sess-1", "Nick Mays."],
		]);
	});

	it("bounds the wait and delivers a slow answer with the next turn", () => {
		const out = py([
			"FakeClient.delays = {'slow question': 4}",
			"slow = turn('slow question', 'ok')",
			"p._prefetch_thread.join(5)",
			"assert not p._prefetch_thread.is_alive()",
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
			"old = p._prefetch_thread",
			"p.on_session_switch('sess-2', reset=True)",
			"old.join(5)",
			"assert not old.is_alive()",
			"p._session_initialized = True",
			"context = p.prefetch('next question', session_id='sess-2')",
			"print(json.dumps({'context': context, 'keys': [s[1] if s[0] == 'session_start' else s[0] for s in submitted]}))",
		]) as { context: string; keys: string[] };

		expect(out.context).toBe("start for sess-2\nrecall for next question");
		expect(out.keys).toEqual(["sess-1", "sess-2", "sess-2"]);
	}, 20_000);

	it("submits a new session's first prompt only after its session start completes", () => {
		const out = py([
			"import threading",
			"turn('old question', 'old answer')",
			"FakeClient.start_delay = 0.5",
			"def boundary():",
			"    time.sleep(0.5)",
			"    p.on_session_switch('sess-2', reset=True)",
			"threading.Thread(target=boundary).start()",
			"context = p.prefetch('new private question', session_id='sess-2')",
			"print(json.dumps({'context': context, 'calls': submitted[1:]}))",
		]) as { context: string; calls: Array<string[]> };

		expect(out.calls).toEqual([
			["session_start", "sess-2"],
			["sess-2", "new private question", ""],
		]);
		expect(out.context).toBe("start for sess-2\nrecall for new private question");
	});

	it("waits for every running submit on shutdown and publishes nothing after it", () => {
		const out = py([
			"import threading",
			"FakeClient.delays = {'slow question': 4}",
			"turn('slow question', 'ok')",
			"turn('fast question', 'ok')",
			"p.shutdown()",
			"alive = [t.name for t in threading.enumerate() if t.name == 'signet-prompt-submit' and t.is_alive()]",
			"time.sleep(1.5)",
			"print(json.dumps({'alive': alive, 'leftover': p._prefetch_result}))",
		]) as { alive: string[]; leftover: string };

		expect(out.alive).toEqual([]);
		expect(out.leftover).toBe("");
	}, 20_000);

	it("does not submit a prompt when the session switch is still unfinished at the deadline", () => {
		const out = py([
			"import threading",
			"turn('old question', 'old private answer')",
			"def boundary():",
			"    time.sleep(3)",
			"    p.on_session_switch('sess-2', reset=True)",
			"threading.Thread(target=boundary).start()",
			"context = p.prefetch('new private question', session_id='sess-2')",
			"print(json.dumps({'context': context, 'calls': submitted[1:]}))",
		]) as { context: string; calls: unknown[] };

		expect(out.calls).toEqual([]);
		expect(out.context).toBe("");
	}, 20_000);

	it("does not submit a prompt that races shutdown", () => {
		const out = py([
			"import threading",
			"original = threading.Thread",
			"class Racing(original):",
			"    def __init__(self, *args, **kwargs):",
			"        super().__init__(*args, **kwargs)",
			"        if kwargs.get('name') == 'signet-prompt-submit':",
			"            closer = original(target=p.shutdown)",
			"            closer.start()",
			"            closer.join()",
			"sig.threading.Thread = Racing",
			"context = p.prefetch('racing question', session_id='sess-1')",
			"time.sleep(0.5)",
			"print(json.dumps({'context': context, 'calls': submitted}))",
		]) as { context: string; calls: unknown[] };

		expect(out.calls).toEqual([]);
		expect(out.context).toBe("");
	});

	it("returns no context, old or new, for a prompt it did not submit", () => {
		const out = py([
			"import threading",
			"FakeClient.delays = {'old question': 4}",
			"turn('old question', 'ok')",
			"def boundary():",
			"    time.sleep(3)",
			"    p.on_session_switch('sess-2', reset=True)",
			"threading.Thread(target=boundary).start()",
			"context = p.prefetch('new private question', session_id='sess-2')",
			"print(json.dumps({'context': context, 'prompts': [s[1] for s in submitted if s[0] != 'session_start']}))",
		]) as { context: string; prompts: string[] };

		expect(out.prompts).toEqual(["old question"]);
		expect(out.context).toBe("");
	}, 20_000);

	it("keeps submitting prompts after session start raises during initialize", () => {
		const out = py([
			"class Broken(FakeClient):",
			"    def is_available(self): return True",
			"    def session_start(self, key, **kw): raise RuntimeError('transport failed')",
			"sig.SignetClient = lambda **kw: Broken()",
			"try:",
			"    p.initialize('sess-3', agent_context='subagent')",
			"except RuntimeError:",
			"    pass",
			"started = time.monotonic()",
			"context = p.prefetch('after failure', session_id='sess-3')",
			"waited = time.monotonic() - started",
			"print(json.dumps({'context': context, 'waited': waited, 'calls': submitted}))",
		]) as { context: string; waited: number; calls: Array<string[]> };

		expect(out.calls).toEqual([["sess-3", "after failure", ""]]);
		expect(out.context).toBe("recall for after failure");
		expect(out.waited).toBeLessThan(1);
	});

	it("keeps a prompt's recall when the daemon reports a restarted session", () => {
		const out = py([
			"FakeClient.responses = {'after restart': {'sessionKnown': False}}",
			"context = p.prefetch('after restart', session_id='sess-1')",
			"print(json.dumps({'context': context, 'calls': submitted}))",
		]) as { context: string; calls: Array<string[]> };

		expect(out.calls).toEqual([
			["sess-1", "after restart", ""],
			["session_start", "sess-1", "claim"],
		]);
		expect(out.context).toBe("recall for after restart");
	});

	it("keeps the newest notification snapshot when an older submit answers last", () => {
		const out = py([
			"FakeClient.responses = {'newer': {'notifications': {'inject': 'board note'}}}",
			"older = p._await_session('sess-1')",
			"newer = p._await_session('sess-1')",
			"p._submit_prompt('newer', newer).join(5)",
			"p._submit_prompt('older', older).join(5)",
			"print(json.dumps(p.prefetch('', session_id='sess-1')))",
		]) as string;

		expect(out.split("\n")).toContain("board note");
	});

	it("leaves a new session's context for that session when it starts during a submit", () => {
		const out = py([
			"import threading",
			"FakeClient.delays = {'old question': 1.5}",
			"def boundary():",
			"    time.sleep(0.5)",
			"    p.on_session_switch('sess-2', reset=True)",
			"threading.Thread(target=boundary).start()",
			"old = p.prefetch('old question', session_id='sess-1')",
			"new = p.prefetch('', session_id='sess-2')",
			"print(json.dumps({'old': old, 'new': new}))",
		]) as { old: string; new: string };

		expect(out.old).toBe("");
		expect(out.new).toBe("start for sess-2");
	}, 20_000);

	it("does not reclaim or clear an old session when its restart response arrives late", () => {
		const out = py([
			"import threading",
			"FakeClient.delays = {'old question': 1.5}",
			"FakeClient.responses = {'old question': {'sessionKnown': False}}",
			"def boundary():",
			"    time.sleep(0.5)",
			"    p.on_session_switch('sess-2', reset=True)",
			"threading.Thread(target=boundary).start()",
			"old = p.prefetch('old question', session_id='sess-1')",
			"new = p.prefetch('', session_id='sess-2')",
			"print(json.dumps({'old': old, 'new': new, 'starts': [s for s in submitted if s[0] == 'session_start']}))",
		]) as { old: string; new: string; starts: Array<string[]> };

		expect(out.starts).toEqual([["session_start", "sess-2"]]);
		expect(out.old).toBe("");
		expect(out.new).toBe("start for sess-2");
	}, 20_000);

	it("does not wait for a turn that Hermes never synced", () => {
		const out = py([
			"p.prefetch('interrupted question', session_id='sess-1')",
			"started = time.monotonic()",
			"context = p.prefetch('next question', session_id='sess-1')",
			"waited = time.monotonic() - started",
			"print(json.dumps({'context': context, 'waited': waited, 'stopped': stopped}))",
		]) as { context: string; waited: number; stopped: unknown[] };

		expect(out.waited).toBeLessThan(0.5);
		expect(out.context).toBe("recall for next question");
		expect(out.stopped).toEqual([]);
	});

	it("records the reply under the session the turn ran in, before a /new switch", () => {
		const out = py([
			"turn('old question', 'old answer')",
			"p.on_session_end([])",
			"p.on_session_switch('sess-2', reset=True)",
			"p.prefetch('new question', session_id='sess-2')",
			"p.sync_turn('new question', 'new answer', session_id='sess-2')",
			"print(json.dumps(stopped))",
		]) as Array<[string, string]>;

		expect(out).toEqual([
			["sess-1", "old answer"],
			["sess-2", "new answer"],
		]);
	});

	it("ignores a refresh that answers after a newer snapshot or fails", () => {
		const out = py([
			"import threading",
			"FakeClient.notes = {'delay': 0.5, 'inject': 'message A'}",
			"p._queue_notification_refresh('on_delegation')",
			"FakeClient.responses = {'next question': {'notifications': {'inject': 'message A\\nmessage B'}}}",
			"first = p.prefetch('next question', session_id='sess-1')",
			"for t in threading.enumerate():",
			"    if t.name == 'signet-notify-on_delegation': t.join(5)",
			"FakeClient.notes = {'fail': True}",
			"FakeClient.responses = {'later question': {'notifications': {'inject': 'message C'}}}",
			"later = p._await_session('sess-1')",
			"p._submit_prompt('later question', later).join(5)",
			"p._queue_notification_refresh('on_delegation')",
			"for t in threading.enumerate():",
			"    if t.name == 'signet-notify-on_delegation': t.join(5)",
			"second = p.prefetch('', session_id='sess-1')",
			"print(json.dumps({'first': first, 'second': second}))",
		]) as { first: string; second: string };

		expect(out.first).toBe("recall for next question\nmessage A\nmessage B");
		expect(out.second).toBe("recall for later question\nmessage C");
	});

	it("keeps a claimed board notice when a newer response carries none", () => {
		const out = py([
			"board = {'notifications': {'inject': 'board notice', 'boardNotices': [{'threadId': 't'}]}}",
			"FakeClient.responses = {'older': board}",
			"older = p._await_session('sess-1')",
			"newer = p._await_session('sess-1')",
			"p._submit_prompt('newer', newer).join(5)",
			"p._submit_prompt('older', older).join(5)",
			"late = p.prefetch('', session_id='sess-1')",
			"FakeClient.responses = {'first': board}",
			"first = p._await_session('sess-1')",
			"second = p._await_session('sess-1')",
			"p._submit_prompt('first', first).join(5)",
			"p._submit_prompt('second', second).join(5)",
			"kept = p.prefetch('', session_id='sess-1')",
			"print(json.dumps({'late': late.split('\\n'), 'kept': kept.split('\\n')}))",
		]) as { late: string[]; kept: string[] };

		expect(out.late).toContain("board notice");
		expect(out.kept).toContain("board notice");
	});

	it("records a reply under the session Hermes synced it for after a compression switch", () => {
		const out = py([
			"p.prefetch('question one', session_id='sess-1')",
			"p.on_session_end([])",
			"p.on_session_switch('sess-child', parent_session_id='sess-1', reason='compression')",
			"p.sync_turn('question one', 'answer one', session_id='sess-1')",
			"print(json.dumps(stopped))",
		]) as Array<[string, string]>;

		expect(out).toEqual([["sess-1", "answer one"]]);
	});
});
