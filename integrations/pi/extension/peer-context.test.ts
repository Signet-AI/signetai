import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import SignetPiExtension from "./src/index.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
interface Req {
	method: string;
	path: string;
	search: string;
	body: Record<string, unknown> | undefined;
}
interface Tool {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: () => void,
		ctx: unknown,
	) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

const servers: Array<{ stop: () => void }> = [];
const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};

afterEach(() => {
	for (const s of servers.splice(0)) s.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

function setup() {
	for (const key of [
		"SIGNET_DAEMON_URL",
		"PI_CODING_AGENT_DIR",
		"SIGNET_ENABLED",
		"SIGNET_AGENT_ID",
		"SIGNET_BYPASS",
	]) {
		saved[key] = process.env[key];
	}
	const dir = mkdtempSync(join(tmpdir(), "signet-pi-peer-"));
	dirs.push(dir);
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.SIGNET_ENABLED = "true";
	process.env.SIGNET_AGENT_ID = "agent-a";
	delete process.env.SIGNET_BYPASS;
	const requests: Req[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "POST" ? ((await req.json().catch(() => undefined)) as Req["body"]) : undefined;
			requests.push({ method: req.method, path: url.pathname, search: url.search, body });
			if (url.pathname === "/health") return new Response(null, { status: 200 });
			if (url.pathname === "/api/hooks/session-start") return Response.json({ inject: "" });
			if (url.pathname === "/api/hooks/user-prompt-submit") return Response.json({});
			if (url.pathname === "/api/cross-agent/presence" && req.method === "POST")
				return Response.json({ presence: { ok: true } });
			if (url.pathname === "/api/cross-agent/wake") {
				await Bun.sleep(30);
				return Response.json({ wake: false, reason: "timeout" });
			}
			if (url.pathname.startsWith("/api/cross-agent/sessions/")) {
				return Response.json({ presence: {}, recentMessages: [], truncated: false, provenance: {} });
			}
			return new Response("nf", { status: 404 });
		},
	});
	servers.push(server);
	process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;
	const handlers: Record<string, Handler[]> = {};
	const tools = new Map<string, Tool>();
	const pi = {
		on(event: string, h: Handler) {
			(handlers[event] ??= []).push(h);
		},
		registerCommand() {},
		registerTool(t: Tool) {
			tools.set(t.name, t);
		},
		sendUserMessage() {},
	};
	SignetPiExtension(pi as never);
	const ctx = (mode = "tui", name: string | null = "Fix the GPU bug") => ({
		mode,
		cwd: "/work/proj",
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getHeader: () => ({ id: "sess-1", cwd: "/work/proj" }),
			getSessionFile: () => undefined,
			getSessionId: () => "sess-1",
			getSessionName: () => name ?? undefined,
		},
		ui: { notify() {}, setStatus() {}, theme: { fg: (_c: string, t: string) => t } },
	});
	return { requests, handlers, tools, ctx };
}

const wait = async (check: () => boolean) => {
	for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10);
	expect(check()).toBe(true);
};

describe("pi peer-session context", () => {
	it("registers context and inspect tools next to the existing collab tools", () => {
		const { tools } = setup();
		for (const name of ["agent_peers", "agent_context_update", "agent_session_inspect"]) {
			expect(tools.has(name)).toBe(true);
		}
	});

	it("advertises cwd, hostname and session title before awaiting wake", async () => {
		const { requests, handlers, ctx } = setup();
		const c = ctx();
		await handlers.session_start?.[0]?.({}, c);
		await wait(() => requests.some((r) => r.path === "/api/cross-agent/wake"));
		const paths = requests.map((r) => r.path);
		expect(paths.indexOf("/api/cross-agent/presence")).toBeGreaterThan(-1);
		expect(paths.indexOf("/api/cross-agent/presence")).toBeLessThan(paths.indexOf("/api/cross-agent/wake"));
		const expected = { cwd: "/work/proj", hostname: hostname(), title: "Fix the GPU bug" };
		expect(requests.find((r) => r.path === "/api/hooks/session-start")?.body?.context).toEqual(expected);
		const presence = requests.find((r) => r.path === "/api/cross-agent/presence")?.body;
		expect(presence).toMatchObject({ harness: "pi", sessionKey: "sess-1", agentId: "agent-a", context: expected });
		expect(requests.find((r) => r.path === "/api/cross-agent/wake")?.body?.context).toEqual(expected);
		await handlers.session_shutdown?.[0]?.({}, c);
	});

	it("omits title instead of fabricating one and still guards print mode", async () => {
		const { requests, handlers, ctx } = setup();
		await handlers.session_start?.[0]?.({}, ctx("print", null));
		await Bun.sleep(40);
		const context = requests.find((r) => r.path === "/api/hooks/session-start")?.body?.context as Record<
			string,
			unknown
		>;
		expect(context.title).toBeUndefined();
		expect(
			requests.filter((r) => r.path === "/api/cross-agent/wake" || r.path === "/api/cross-agent/presence"),
		).toHaveLength(0);
	});

	it("never advertises a raw prompt as task and refreshes presence after observed file edits only", async () => {
		const { requests, handlers, ctx } = setup();
		const c = ctx();
		await handlers.session_start?.[0]?.({}, c);
		handlers.input?.[0]?.({ text: `Please ${"refactor ".repeat(100)}` }, c);
		await wait(() => requests.some((r) => r.path === "/api/hooks/user-prompt-submit"));
		const submitted = requests.find((r) => r.path === "/api/hooks/user-prompt-submit")?.body;
		expect(submitted?.userMessage).toStartWith("Please refactor");
		expect(submitted?.context).not.toHaveProperty("task");
		expect(JSON.stringify(submitted?.context)).not.toContain("refactor");

		const before = requests.filter((r) => r.path === "/api/cross-agent/presence").length;
		await handlers.tool_result?.[0]?.({ toolName: "bash", input: { command: "echo hi > x" }, isError: false }, c);
		await handlers.tool_result?.[0]?.({ toolName: "write", input: { path: "bad.ts" }, isError: true }, c);
		await Bun.sleep(40);
		expect(requests.filter((r) => r.path === "/api/cross-agent/presence")).toHaveLength(before);

		await handlers.tool_result?.[0]?.({ toolName: "edit", input: { path: "src/a.ts" }, isError: false }, c);
		await handlers.tool_result?.[0]?.({ toolName: "write", input: { path: "/abs/b.ts" }, isError: false }, c);
		await handlers.tool_result?.[0]?.(
			{ toolName: "write", input: { path: `/${"long/".repeat(70)}file.ts` }, isError: false },
			c,
		);
		await handlers.tool_result?.[0]?.({ toolName: "edit", input: { path: "/abs/c.ts" }, isError: false }, c);
		await wait(() => {
			const context = requests.filter((r) => r.path === "/api/cross-agent/presence").at(-1)?.body?.context as
				| { modifiedFiles?: string[] }
				| undefined;
			return context?.modifiedFiles?.at(-1) === "/abs/c.ts";
		});
		const last = requests.filter((r) => r.path === "/api/cross-agent/presence").at(-1)?.body?.context as Record<
			string,
			unknown
		>;
		expect(last.modifiedFiles).toEqual(["/work/proj/src/a.ts", "/abs/b.ts", "/abs/c.ts"]);
		expect(last).not.toHaveProperty("task");
		await handlers.session_shutdown?.[0]?.({}, c);
	});

	it("keeps the explicit agent task across human, rpc and extension-wake prompts", async () => {
		const { requests, handlers, tools, ctx } = setup();
		const c = ctx("rpc");
		await handlers.session_start?.[0]?.({}, c);
		handlers.input?.[0]?.({ text: "Render the character" }, c);
		await handlers.before_agent_start?.[0]?.({ prompt: "Render the character", systemPrompt: "" }, c);
		const first = requests.filter((r) => r.path === "/api/hooks/user-prompt-submit").at(-1);
		expect(first?.body?.context).not.toHaveProperty("task");
		await tools
			.get("agent_context_update")
			?.execute(
				"task",
				{ task: "Waiting to render the character", resources: ["gpu:0"] },
				new AbortController().signal,
				() => {},
				c,
			);
		const wake = "## Direct message from another agent\nMessage ID: test-message\nPlease coordinate";
		handlers.input?.[0]?.({ text: wake }, c);
		await handlers.before_agent_start?.[0]?.({ prompt: wake, systemPrompt: "" }, c);
		const submit = requests.filter((r) => r.path === "/api/hooks/user-prompt-submit").at(-1);
		expect(submit?.body?.userMessage).toBe(wake);
		expect(submit?.body?.context).toMatchObject({ task: "Waiting to render the character", resources: ["gpu:0"] });
		handlers.input?.[0]?.({ text: "continue" }, c);
		await handlers.before_agent_start?.[0]?.({ prompt: "continue", systemPrompt: "" }, c);
		const next = requests.filter((r) => r.path === "/api/hooks/user-prompt-submit").at(-1);
		expect(next?.body?.context).toMatchObject({ task: "Waiting to render the character", resources: ["gpu:0"] });
		await handlers.session_shutdown?.[0]?.({}, c);
	});

	it("agent_context_update posts own-session resources and an empty list clears them", async () => {
		const { requests, handlers, tools, ctx } = setup();
		const c = ctx();
		await handlers.session_start?.[0]?.({}, c);
		const tool = tools.get("agent_context_update");
		const res = await tool?.execute(
			"1",
			{ resources: ["gpu:0", "port:3000"], session_key: "other", agent_id: "evil" },
			new AbortController().signal,
			() => {},
			c,
		);
		expect(res?.isError).toBeUndefined();
		const post = requests.filter((r) => r.path === "/api/cross-agent/presence").at(-1)?.body;
		expect(post).toMatchObject({
			harness: "pi",
			sessionKey: "sess-1",
			agentId: "agent-a",
			context: { resources: ["gpu:0", "port:3000"] },
		});
		await tool?.execute("2", { resources: [] }, new AbortController().signal, () => {}, c);
		const cleared = requests.filter((r) => r.path === "/api/cross-agent/presence").at(-1)?.body?.context as Record<
			string,
			unknown
		>;
		expect(cleared.resources).toEqual([]);
		const empty = await tool?.execute("3", {}, new AbortController().signal, () => {}, c);
		expect(empty?.isError).toBe(true);
		await handlers.session_shutdown?.[0]?.({}, c);
	});

	it("agent_session_inspect calls the daemon inspect endpoint with caller identity", async () => {
		const { requests, tools, ctx } = setup();
		const res = await tools
			.get("agent_session_inspect")
			?.execute(
				"1",
				{ session_key: "a/b c", session_agent_id: "agent-b" },
				new AbortController().signal,
				() => {},
				ctx(),
			);
		expect(res?.isError).toBeUndefined();
		const req = requests.find((r) => r.path.startsWith("/api/cross-agent/sessions/"));
		expect(req?.path).toBe("/api/cross-agent/sessions/a%2Fb%20c/context");
		const q = new URLSearchParams(req?.search);
		expect(q.get("target_agent_id")).toBe("agent-b");
		expect(q.get("agent_id")).toBe("agent-a");
		expect(q.get("caller_session_key")).toBe("sess-1");
		expect(q.has("session_key")).toBe(false);
		const missing = await tools
			.get("agent_session_inspect")
			?.execute("2", {}, new AbortController().signal, () => {}, ctx());
		expect(missing?.isError).toBe(true);
	});

	it("redacts credentials in an explicit task and ignores tool results without a success flag", async () => {
		const { requests, handlers, tools, ctx } = setup();
		const c = ctx();
		await handlers.session_start?.[0]?.({}, c);
		await tools
			.get("agent_context_update")
			?.execute(
				"t",
				{ task: "deploy with sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 now" },
				new AbortController().signal,
				() => {},
				c,
			);
		const sent = requests.filter((r) => r.path === "/api/cross-agent/presence").at(-1);
		const task = ((sent?.body?.context ?? {}) as { task?: string }).task ?? "";
		expect(task).toStartWith("deploy with");
		expect(task).not.toContain("abcdefghijklmnopqrstuvwxyz");
		const before = requests.filter((r) => r.path === "/api/cross-agent/presence").length;
		await handlers.tool_result?.[0]?.({ toolName: "write", input: { path: "unknown.ts" } }, c);
		await Bun.sleep(40);
		expect(requests.filter((r) => r.path === "/api/cross-agent/presence")).toHaveLength(before);
		await handlers.session_shutdown?.[0]?.({}, c);
	});
});
