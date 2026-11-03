import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "signet-hermes-peer-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(): string {
	const dir = mkdtempSync(join(root, "fx-"));
	cpSync(join(import.meta.dir, "hermes-plugin"), join(dir, "plugins", "memory", "signet"), { recursive: true });
	mkdirSync(join(dir, "agent"), { recursive: true });
	for (const f of [
		join("agent", "__init__.py"),
		join("plugins", "__init__.py"),
		join("plugins", "memory", "__init__.py"),
	]) {
		writeFileSync(join(dir, f), "");
	}
	writeFileSync(join(dir, "agent", "memory_provider.py"), "class MemoryProvider:\n    pass\n");
	return dir;
}

function py(script: string): unknown {
	const dir = fixture();
	const result = spawnSync(process.env.PYTHON?.trim() || "python3", ["-c", script], {
		cwd: dir,
		env: { ...process.env, PYTHONPATH: dir, SIGNET_DAEMON_URL: "", SIGNET_PATH: join(dir, "no-agents") },
		encoding: "utf-8",
		timeout: 8_000,
	});
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout);
}

const PRELUDE = [
	"import json, os",
	"import plugins.memory.signet as sig",
	"calls = []",
	"class FakeClient:",
	"    _agent_id = 'agent-a'",
	"    def request_result(self, method, path, body=None, **kw):",
	"        calls.append(['http', method, path, body])",
	"        return {'ok': True, 'data': {'ok': True}}",
	"    def session_start(self, key, **kw):",
	"        calls.append(['session_start', kw.get('context')]); return {}",
	"    def user_prompt_submit(self, key, msg, **kw):",
	"        calls.append(['prompt', kw.get('context')]); return {}",
	"    def notifications(self, key, hook, **kw):",
	"        calls.append(['notify', kw.get('context')]); return {}",
	"    def is_available(self): return True",
	"p = sig.SignetMemoryProvider()",
	"p._client = FakeClient()",
	"p._agent_id = 'agent-a'",
	"p._session_key = 'sess-1'",
	"def call(name, **a): return json.loads(p.handle_tool_call(name, a))",
];

describe("hermes peer-session context", () => {
	it("registers agent_context_update and agent_session_inspect", () => {
		const out = py([...PRELUDE, "print(json.dumps([s['name'] for s in p.get_tool_schemas()]))"].join("\n")) as string[];
		expect(out).toEqual(expect.arrayContaining(["agent_peers", "agent_context_update", "agent_session_inspect"]));
	});

	it("session-start and prompt hooks carry cwd, hostname, host title and no raw-prompt task", () => {
		const out = py(
			[
				...PRELUDE,
				"p._remember_host_metadata({'session_title': 'Fix GPU bug'})",
				"p._client.session_start('sess-1', context=p._peer_context())",
				"p.queue_prefetch('please ' + 'refactor ' * 200)",
				"p._prefetch_thread.join(3)",
				"print(json.dumps(calls))",
			].join("\n"),
		) as Array<[string, Record<string, unknown>]>;
		const start = out[0]?.[1] as Record<string, unknown>;
		expect(start).toEqual({ cwd: expect.any(String), hostname: hostname(), title: "Fix GPU bug" });
		const prompt = out.find((c) => c[0] === "prompt")?.[1] as Record<string, unknown>;
		expect(prompt).not.toHaveProperty("task");
		expect(JSON.stringify(prompt)).not.toContain("refactor");
		expect(prompt.title).toBe("Fix GPU bug");
		expect(prompt.modifiedFiles).toBeUndefined();
	});

	it("omits title when Hermes exposes none", () => {
		const out = py(
			[...PRELUDE, "p._remember_host_metadata({})", "print(json.dumps(p._peer_context()))"].join("\n"),
		) as Record<string, unknown>;
		expect(out.title).toBeUndefined();
		expect(out.hostname).toBe(hostname());
	});

	it("agent_context_update posts only own session identity and [] clears resources", () => {
		const out = py(
			[
				...PRELUDE,
				"call('agent_context_update', resources=['gpu:0','port:3000'], sessionKey='evil', agent_id='evil')",
				"call('agent_context_update', resources=[])",
				"r = call('agent_context_update')",
				"call('agent_context_update', task='')",
				"print(json.dumps([calls, r]))",
			].join("\n"),
		) as [Array<[string, string, string, Record<string, unknown>]>, { error: string }];
		const [calls, empty] = out;
		expect(calls[0]?.[2]).toBe("/api/cross-agent/presence");
		expect(calls[0]?.[3]).toMatchObject({
			harness: "hermes-agent",
			agentId: "agent-a",
			sessionKey: "sess-1",
			context: { resources: ["gpu:0", "port:3000"] },
		});
		expect((calls[1]?.[3].context as Record<string, unknown>).resources).toEqual([]);
		expect(empty.error).toContain("task and/or resources");
		expect((calls[2]?.[3].context as Record<string, unknown>).task).toBe("");
	});

	it("agent_session_inspect uses the daemon inspect path with caller identity", () => {
		const out = py(
			[
				...PRELUDE,
				"call('agent_session_inspect', session_key='a/b c', session_agent_id='agent-b')",
				"r = call('agent_session_inspect')",
				"print(json.dumps([calls, r]))",
			].join("\n"),
		) as [Array<[string, string, string]>, { error: string }];
		expect(out[0][0]?.[1]).toBe("GET");
		const url = new URL(`http://x${out[0][0]?.[2]}`);
		expect(url.pathname).toBe("/api/cross-agent/sessions/a%2Fb%20c/context");
		expect(url.searchParams.get("target_agent_id")).toBe("agent-b");
		expect(url.searchParams.get("agent_id")).toBe("agent-a");
		expect(url.searchParams.get("caller_session_key")).toBe("sess-1");
		expect(url.searchParams.has("session_key")).toBe(false);
		expect(out[1].error).toContain("session_key");
	});

	it("wake waiter advertises presence before the first long poll and sends context on each poll", () => {
		const out = py(
			[
				...PRELUDE,
				"order = []",
				"class WC:",
				"    def wake(self, key, **kw):",
				"        order.append(['wake', kw.get('context')]); w._stop.set(); return {'wake': False, 'reason': 'timeout'}",
				"w = sig._WakeWaiter(WC(), lambda t: True, 'sess-1', 'sess-1', '/p', lambda: True, context_provider=p._peer_context, advertise=lambda: order.append(['presence']))",
				"w._run()",
				"print(json.dumps(order))",
			].join("\n"),
		) as Array<[string, Record<string, unknown>?]>;
		expect(out[0]?.[0]).toBe("presence");
		expect(out[1]?.[0]).toBe("wake");
		expect(out[1]?.[1]).toMatchObject({ hostname: hostname() });
	});

	it("redacts credentials from an explicit task and keeps it across yes/continue prompts", () => {
		const out = py(
			[
				...PRELUDE,
				"call('agent_context_update', task='use sk-ant...CDEF and password=hunter2hunter2 ok')",
				"p.queue_prefetch('yes'); p._prefetch_thread.join(3)",
				"p.queue_prefetch('continue'); p._prefetch_thread.join(3)",
				"print(json.dumps([p._peer_context(), [c for c in calls if c[0] == 'prompt'][-1][1]]))",
			].join("\n"),
		) as Array<{ task: string }>;
		for (const ctx of out) {
			expect(ctx.task).not.toContain("abcdefghijklmnop");
			expect(ctx.task).not.toContain("hunter2hunter2");
			expect(ctx.task).toContain("[redacted credential]");
		}
	});

	it("resets title, cwd, task and resources on a real session change, via switch or re-initialize", () => {
		const out = py(
			[
				...PRELUDE,
				"sig.SignetClient = lambda **kw: p._client",
				"p.initialize('sess-A', cwd='/work/a', session_title='Title A')",
				"call('agent_context_update', task='task A', resources=['gpu:0'])",
				"p.initialize('sess-A', cwd='/work/a', session_title='Title A')",
				"same = p._peer_context()",
				"p.initialize('sess-B')",
				"reinit = p._peer_context()",
				"call('agent_context_update', task='task B', resources=['port:1'])",
				"p.on_session_switch('sess-C', cwd='/work/c')",
				"switched = p._peer_context()",
				"print(json.dumps([same, reinit, switched]))",
			].join("\n"),
		) as Array<Record<string, unknown>>;
		expect(out[0]).toMatchObject({ task: "task A", resources: ["gpu:0"], title: "Title A", cwd: "/work/a" });
		for (const ctx of [out[1], out[2]]) {
			expect(ctx).not.toHaveProperty("task");
			expect(ctx).not.toHaveProperty("resources");
			expect(ctx).not.toHaveProperty("title");
		}
		expect(out[1]?.cwd).not.toBe("/work/a");
		expect(out[2]?.cwd).toBe("/work/c");
	});

	it.each([
		["same-id refresh", "sess-A", {}, true],
		["compression continuation", "sess-B", { parent_session_id: "sess-A", reason: "compression" }, true],
		[
			"new conversation with parent",
			"sess-B",
			{ parent_session_id: "sess-A", reset: true, reason: "new_session" },
			false,
		],
		["independent branch", "sess-B", { parent_session_id: "sess-A", reason: "branch" }, false],
		["unrelated compression", "sess-B", { parent_session_id: "other", reason: "compression" }, false],
		["explicit same-id reset", "sess-A", { reset: true }, false],
	] as const)("advertises the correct explicit work after %s", (_name, session, options, continues) => {
		const out = py(
			[
				...PRELUDE,
				"sig.SignetClient = lambda **kw: p._client",
				"p.initialize('sess-A', cwd='/work/a', session_title='Title A')",
				"call('agent_context_update', task='render A', resources=['gpu:0'])",
				`p.on_session_switch(${JSON.stringify(session)}, **json.loads(${JSON.stringify(JSON.stringify(options))}))`,
				"print(json.dumps([c[1] for c in calls if c[0] == 'session_start'][-1]))",
			].join("\n"),
		) as Record<string, unknown>;
		if (continues) {
			expect(out).toMatchObject({ task: "render A", resources: ["gpu:0"], cwd: "/work/a", title: "Title A" });
		} else {
			expect(out).not.toHaveProperty("task");
			expect(out).not.toHaveProperty("resources");
			expect(out).not.toHaveProperty("title");
		}
	});
});
