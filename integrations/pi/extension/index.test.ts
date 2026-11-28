import "../../../tests/support/connector-safety.js";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseRecallPayload } from "@signet/core";
import type { PiCustomMessage } from "./src/types.js";
import SignetPiExtension, {
	loadConfig,
	parseRememberArgs,
	recallMemories,
	rememberContent,
	searchSessions,
	searchSourceArtifacts,
} from "./src/index.js";

const tempDirs: string[] = [];
const servers: Array<{ stop: () => void }> = [];
const originalWarn = console.warn;
let savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
	console.warn = originalWarn;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	for (const server of servers.splice(0)) {
		server.stop();
	}
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	savedEnv = {};
});

function saveEnv(...keys: string[]) {
	for (const key of keys) {
		savedEnv[key] = process.env[key];
	}
}

function makeTempDir() {
	const dir = mkdtempSync(join(tmpdir(), "signet-pi-test-"));
	tempDirs.push(dir);
	return dir;
}
function makeTempDirInHome() {
	const dir = mkdtempSync(join(homedir(), ".signet-pi-test-"));
	tempDirs.push(dir);
	return dir;
}

describe("loadConfig", () => {
	it("defaults to enabled when no env var or config file exists", () => {
		saveEnv("SIGNET_ENABLED", "PI_CODING_AGENT_DIR");
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete process.env.SIGNET_ENABLED;
		process.env.PI_CODING_AGENT_DIR = makeTempDir();
		expect(loadConfig().enabled).toBe(true);
	});

	it("SIGNET_ENABLED=false disables the extension", () => {
		saveEnv("SIGNET_ENABLED");
		process.env.SIGNET_ENABLED = "false";
		expect(loadConfig().enabled).toBe(false);
	});

	it("SIGNET_ENABLED=true enables even if config file says false", () => {
		saveEnv("SIGNET_ENABLED", "PI_CODING_AGENT_DIR");
		const dir = makeTempDir();
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(join(dir, "extensions", "signet.json"), JSON.stringify({ enabled: false }));
		process.env.PI_CODING_AGENT_DIR = dir;
		process.env.SIGNET_ENABLED = "true";
		expect(loadConfig().enabled).toBe(true);
	});

	it("config file enabled:false disables when env var is absent", () => {
		saveEnv("SIGNET_ENABLED", "PI_CODING_AGENT_DIR");
		const dir = makeTempDir();
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(join(dir, "extensions", "signet.json"), JSON.stringify({ enabled: false }));
		process.env.PI_CODING_AGENT_DIR = dir;
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete process.env.SIGNET_ENABLED;
		expect(loadConfig().enabled).toBe(false);
	});

	it("resolves PI_CODING_AGENT_DIR with tilde expansion", () => {
		saveEnv("SIGNET_ENABLED", "PI_CODING_AGENT_DIR");
		const dir = makeTempDirInHome();
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(join(dir, "extensions", "signet.json"), JSON.stringify({ enabled: false }));
		const rel = relative(homedir(), dir);
		process.env.PI_CODING_AGENT_DIR = `~/${rel}`;
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete process.env.SIGNET_ENABLED;
		expect(loadConfig().enabled).toBe(false);
	});

	it("reads config from persisted pi.json when PI_CODING_AGENT_DIR is unset", () => {
		saveEnv("SIGNET_ENABLED", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME");
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete process.env.SIGNET_ENABLED;
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete process.env.PI_CODING_AGENT_DIR;
		const configHome = makeTempDir();
		process.env.XDG_CONFIG_HOME = configHome;
		const agentDir = makeTempDir();
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "signet.json"), JSON.stringify({ enabled: false }));
		mkdirSync(join(configHome, "signet"), { recursive: true });
		writeFileSync(
			join(configHome, "signet", "pi.json"),
			JSON.stringify({ version: 1, agentDir, updatedAt: new Date().toISOString() }),
		);

		expect(loadConfig().enabled).toBe(false);
	});

	it("SIGNET_BYPASS=1 is not part of loadConfig (read at runtime)", () => {
		saveEnv("SIGNET_ENABLED", "SIGNET_BYPASS", "PI_CODING_AGENT_DIR");
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete process.env.SIGNET_ENABLED;
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete process.env.PI_CODING_AGENT_DIR;
		process.env.SIGNET_BYPASS = "1";
		const config = loadConfig();
		expect(config.enabled).toBe(true);
		expect(config).not.toHaveProperty("bypass");
	});
});

describe("parseRememberArgs", () => {
	it("parses plain content with no flags", () => {
		expect(parseRememberArgs("use bun for scripts")).toEqual({
			content: "use bun for scripts",
			critical: false,
			tags: [],
		});
	});

	it("strips critical: prefix and sets critical=true", () => {
		expect(parseRememberArgs("critical: prefer TypeScript strict mode")).toEqual({
			content: "prefer TypeScript strict mode",
			critical: true,
			tags: [],
		});
	});

	it("extracts bracketed tags", () => {
		expect(parseRememberArgs("[ts, style]: always use const over let")).toEqual({
			content: "always use const over let",
			critical: false,
			tags: ["ts", "style"],
		});
	});

	it("combines critical prefix and tags", () => {
		expect(parseRememberArgs("critical: [security]: never commit secrets")).toEqual({
			content: "never commit secrets",
			critical: true,
			tags: ["security"],
		});
	});

	it("trims surrounding whitespace from raw input", () => {
		const result = parseRememberArgs("  plain content  ");
		expect(result.content).toBe("plain content");
	});
});

describe("recallMemories", () => {
	it("returns memories from data.results field (not data.memories)", async () => {
		let capturedMethod: string | undefined;
		let capturedPath: string | undefined;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				capturedMethod = req.method;
				capturedPath = new URL(req.url).pathname;
				if (capturedPath === "/api/memory/recall") {
					return Response.json({
						results: [
							{
								content: "use bun",
								importance: 0.9,
								tags: "bun,tooling",
								score: 0.9,
								source: "user",
								type: "fact",
								pinned: false,
								who: "agent",
								project: null,
								created_at: "",
							},
						],
						query: "bun",
						method: "hybrid",
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);

		const result = await recallMemories(`http://127.0.0.1:${server.port}`, "bun");
		const rows = parseRecallPayload(result).rows;
		expect(capturedMethod).toBe("POST");
		expect(capturedPath).toBe("/api/memory/recall");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.content).toBe("use bun");
		expect(rows[0]?.importance).toBe(0.9);
	});

	it("returns empty array when results field is absent", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch() {
				return Response.json({ query: "nothing", method: "hybrid" });
			},
		});
		servers.push(server);

		const result = await recallMemories(`http://127.0.0.1:${server.port}`, "nothing");
		expect(parseRecallPayload(result).rows).toEqual([]);
	});

	it("preserves daemon recall rows without local reshaping", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch() {
				return Response.json({
					results: [
						{
							content: "x",
							tags: "a,b,c",
							score: 1,
							importance: 1,
							source: "user",
							type: "fact",
							pinned: false,
							who: "agent",
							project: null,
							created_at: "",
						},
					],
				});
			},
		});
		servers.push(server);

		const result = await recallMemories(`http://127.0.0.1:${server.port}`, "x");
		expect(parseRecallPayload(result).rows[0]?.tags).toBe("a,b,c");
	});

	it("does not send a scope field by default (preserves daemon unscoped-memory path)", async () => {
		let capturedBody: Record<string, unknown> = {};
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				capturedBody = (await req.json()) as Record<string, unknown>;
				return Response.json({ results: [] });
			},
		});
		servers.push(server);

		await recallMemories(`http://127.0.0.1:${server.port}`, "test");
		expect(capturedBody).not.toHaveProperty("scope");
	});
});

describe("Signet search helpers", () => {
	it("source search posts sourceOnly recall requests", async () => {
		let capturedPath: string | undefined;
		let capturedBody: Record<string, unknown> = {};
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				capturedPath = new URL(req.url).pathname;
				capturedBody = (await req.json()) as Record<string, unknown>;
				return Response.json({ results: [] });
			},
		});
		servers.push(server);

		await searchSourceArtifacts(`http://127.0.0.1:${server.port}`, "obsidian note", {
			agentId: "agent-pi",
			sessionKey: "session-pi",
			project: "/tmp/project",
			limit: 3,
		});

		expect(capturedPath).toBe("/api/memory/recall");
		expect(capturedBody.query).toBe("obsidian note");
		expect(capturedBody.sourceOnly).toBe(true);
		expect(capturedBody.agentId).toBe("agent-pi");
		expect(capturedBody.sessionKey).toBe("session-pi");
		expect(capturedBody.project).toBe("/tmp/project");
		expect(capturedBody.limit).toBe(3);
	});

	it("session search posts to the transcript search endpoint", async () => {
		let capturedPath: string | undefined;
		let capturedBody: Record<string, unknown> = {};
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				capturedPath = new URL(req.url).pathname;
				capturedBody = (await req.json()) as Record<string, unknown>;
				return Response.json({ results: [{ sessionKey: "session-pi" }] });
			},
		});
		servers.push(server);

		const result = await searchSessions(`http://127.0.0.1:${server.port}`, "what happened", {
			sessionKey: "specific-session",
			currentSessionKey: "current-session",
			agentId: "agent-pi",
			project: "/tmp/project",
			limit: 2,
		});

		expect(capturedPath).toBe("/api/sessions/search");
		expect(capturedBody).toEqual({
			query: "what happened",
			sessionKey: "specific-session",
			currentSessionKey: "current-session",
			agentId: "agent-pi",
			project: "/tmp/project",
			limit: 2,
		});
		expect(result).toEqual({ results: [{ sessionKey: "session-pi" }] });
	});
});

describe("daemon-unavailable helper behavior", () => {
	it("rejects direct requests with concise unavailable errors and no console warnings", async () => {
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};

		const offlineServer = Bun.serve({
			port: 0,
			fetch: () => new Response(),
		});
		const offlinePort = offlineServer.port;
		offlineServer.stop();
		const daemonUrl = `http://127.0.0.1:${offlinePort}`;

		await expect(recallMemories(daemonUrl, "query")).rejects.toThrow("Recall failed: offline");
		await expect(rememberContent(daemonUrl, "memory")).rejects.toThrow("Remember failed: offline");
		await expect(searchSourceArtifacts(daemonUrl, "query")).rejects.toThrow("Source search failed: offline");
		await expect(searchSessions(daemonUrl, "query")).rejects.toThrow("Session search failed: offline");
		expect(warnings).toEqual([]);
	});
});

describe("rememberContent", () => {
	it("includes harness field in the request body and POSTs to /api/hooks/remember", async () => {
		let capturedMethod: string | undefined;
		let capturedPath: string | undefined;
		let capturedBody: Record<string, unknown> = {};
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				capturedMethod = req.method;
				capturedPath = new URL(req.url).pathname;
				capturedBody = (await req.json()) as Record<string, unknown>;
				return new Response(null, { status: 200 });
			},
		});
		servers.push(server);

		await rememberContent(`http://127.0.0.1:${server.port}`, "my memory");
		expect(capturedMethod).toBe("POST");
		expect(capturedPath).toBe("/api/hooks/remember");
		expect(capturedBody.harness).toBe("pi");
	});

	it("sends content, pinned, and tags in the request body", async () => {
		let capturedBody: Record<string, unknown> = {};
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				capturedBody = (await req.json()) as Record<string, unknown>;
				return new Response(null, { status: 200 });
			},
		});
		servers.push(server);
		await fetch(`http://127.0.0.1:${server.port}`, { method: "HEAD" });

		await rememberContent(`http://127.0.0.1:${server.port}`, "test memory", {
			critical: true,
			tags: ["tag1", "tag2"],
			reviewAfter: "2026-08-03T00:00:00.000Z",
		});
		expect(capturedBody.content).toBe("test memory");
		expect(capturedBody.pinned).toBe(true);
		expect(capturedBody.tags).toBe("tag1,tag2");
		expect(capturedBody.reviewAfter).toBe("2026-08-03T00:00:00.000Z");
	});

	it("throws when the daemon returns an error status", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch() {
				return new Response("harness required", { status: 400 });
			},
		});
		servers.push(server);

		await expect(rememberContent(`http://127.0.0.1:${server.port}`, "x")).rejects.toThrow("Remember failed");
	});
});

interface HandlerMap {
	[event: string]: Array<(event: unknown, ctx: unknown) => unknown>;
}

describe("SignetPiExtension", () => {
	it("saves explicit command and tool memories under the session project, not daemon cwd", async () => {
		const bodies: unknown[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				if (new URL(req.url).pathname === "/health") return new Response(null, { status: 200 });
				bodies.push(await req.json());
				return Response.json({ id: "memory" });
			},
		});
		servers.push(server);
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;
		expect((await fetch(process.env.SIGNET_DAEMON_URL, { method: "HEAD" })).status).toBe(200);
		const commands = new Map<string, import("./src/types").PiCommandHandler>();
		const tools = new Map<string, import("./src/types").PiToolDefinition>();
		const ui = {
			notify(): void {},
			setStatus(): void {},
			theme: {
				fg(_color: string, text: string): string {
					return text;
				},
			},
		};
		SignetPiExtension({
			ui,
			on(): void {},
			registerFlag(): void {},
			getFlag(): unknown {
				return undefined;
			},
			registerCommand(name, definition): void {
				commands.set(name, definition);
			},
			registerTool(definition): void {
				tools.set(definition.name, definition);
			},
		});
		const ctx = {
			cwd: "/work/project",
			sessionManager: {
				getBranch: () => [],
				getEntries: () => [],
				getHeader: () => ({ id: "session-project", cwd: "/work/session-project" }),
				getSessionFile: () => undefined,
				getSessionId: () => "session-project",
			},
			ui,
		};
		const command = commands.get("remember");
		const tool = tools.get("signet_remember");
		if (!command || !tool) throw new Error("remember surfaces missing");
		await command.handler("project beta decisions", ctx);
		await tool.execute("call", { content: "project beta decisions" }, new AbortController().signal, () => {}, ctx);
		expect(bodies).toHaveLength(2);
		for (const body of bodies) expect(body).toMatchObject({ project: "/work/project" });
	});

	afterEach(() => {
		for (const server of servers.splice(0)) {
			server.stop();
		}
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete process.env.SIGNET_ENABLED;
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete process.env.SIGNET_AGENT_ID;
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete process.env.SIGNET_DAEMON_URL;
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete process.env.SIGNET_BYPASS;
	});

	it("registers handlers for Pi lifecycle, prompt, context, and compaction events", () => {
		const registered = new Set<string>();
		const pi = {
			on(event: string, _handler: unknown) {
				registered.add(event);
			},
			registerCommand(_name: string, _opts: unknown) {},
			registerTool(_opts: unknown) {},
		};
		SignetPiExtension(pi as never);
		expect(registered.has("session_start")).toBe(true);
		expect(registered.has("before_agent_start")).toBe(true);
		expect(registered.has("context")).toBe(true);
		expect(registered.has("session_before_compact")).toBe(true);
		expect(registered.has("session_before_switch")).toBe(true);
		expect(registered.has("session_before_fork")).toBe(true);
		expect(registered.has("session_switch")).toBe(true);
		expect(registered.has("session_fork")).toBe(true);
	});

	it("session_before_switch ends the previous session; session_switch only refreshes (no double session-end)", async () => {
		const requests: Array<{ method: string; path: string; body: unknown }> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				const path = new URL(req.url).pathname;
				const body = req.method === "POST" ? ((await req.json().catch(() => undefined)) as unknown) : undefined;
				requests.push({ method: req.method, path, body });
				if (path === "/health") return new Response(null, { status: 200 });
				if (path === "/api/hooks/session-start") return Response.json({ inject: "session-context" });
				if (path === "/api/hooks/session-end") return Response.json({ ok: true });
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;

		const handlers: HandlerMap = {};
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				(handlers[event] ??= []).push(handler);
			},
			registerCommand(_name: string, _opts: unknown) {},
			registerTool(_opts: unknown) {},
		};
		SignetPiExtension(pi as never);

		const ctx = {
			cwd: "/tmp/pi-project",
			sessionManager: {
				getBranch: () => [],
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				getHeader: () => ({ id: "session-pi-switch-1", cwd: "/tmp/pi-project" }),
				getSessionFile: () => undefined,
				getSessionId: () => "session-pi-switch-1",
			},
			ui: {
				notify: () => {},
				setStatus: () => {},
				theme: { fg: (_color: string, text: string) => text },
			},
		};
		await handlers.session_start[0]?.({}, ctx);
		await handlers.session_before_switch[0]?.({ type: "session_before_switch", reason: "new" }, ctx);
		await handlers.session_switch[0]?.({ type: "session_switch", reason: "new" }, ctx);

		const posts = requests.filter((r) => r.method === "POST");
		expect(posts.map((r) => r.path)).toEqual([
			"/api/hooks/session-start",
			"/api/hooks/session-end",
			"/api/hooks/session-start",
		]);
		expect(posts.filter((r) => r.path === "/api/hooks/session-end")).toHaveLength(1);
		const end = posts.find((r) => r.path === "/api/hooks/session-end");
		expect(end?.body).toMatchObject({
			harness: "pi",
			reason: "session_switch",
			sessionKey: "session-pi-switch-1",
		});
		expect(end?.body).not.toHaveProperty("transcript");
	});

	it("wakes interactive sessions for direct messages and never polls in print mode", async () => {
		const requests: Array<{ path: string; body: unknown }> = [];
		let wakeCount = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				const path = new URL(req.url).pathname;
				const body = req.method === "POST" ? ((await req.json().catch(() => undefined)) as unknown) : undefined;
				requests.push({ path, body });
				if (path === "/health") return new Response(null, { status: 200 });
				if (path === "/api/hooks/session-start") return Response.json({ inject: "" });
				if (path === "/api/hooks/session-end") return Response.json({ ok: true });
				if (path === "/api/cross-agent/wake") {
					wakeCount += 1;
					if (wakeCount === 1) return Response.json({ wake: true, inject: "peer says hi", messageIds: ["m1"] });
					return Response.json({ wake: false, reason: "superseded" });
				}
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;

		const delivered: Array<{ text: unknown; options: unknown }> = [];
		const handlers: HandlerMap = {};
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				(handlers[event] ??= []).push(handler);
			},
			registerCommand(_name: string, _opts: unknown) {},
			registerTool(_opts: unknown) {},
			sendUserMessage(text: unknown, options: unknown) {
				delivered.push({ text, options });
			},
		};
		SignetPiExtension(pi as never);
		const ctxFor = (mode: string, id: string) => ({
			mode,
			cwd: "/tmp/pi-project",
			sessionManager: {
				getBranch: () => [],
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				getHeader: () => ({ id, cwd: "/tmp/pi-project" }),
				getSessionFile: () => undefined,
				getSessionId: () => id,
			},
			ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_color: string, text: string) => text } },
		});

		await handlers.session_start[0]?.({}, ctxFor("print", "session-print"));
		await Bun.sleep(50);
		expect(requests.filter((r) => r.path === "/api/cross-agent/wake")).toHaveLength(0);

		await handlers.session_start[0]?.({}, ctxFor("tui", "session-tui"));
		for (let attempt = 0; attempt < 50 && wakeCount < 2; attempt++) await Bun.sleep(20);
		expect(delivered).toEqual([{ text: "peer says hi", options: { deliverAs: "followUp" } }]);
		expect(requests.find((r) => r.path === "/api/cross-agent/wake")?.body).toMatchObject({
			harness: "pi",
			sessionKey: "session-tui",
		});
		await handlers.session_shutdown[0]?.({}, ctxFor("tui", "session-tui"));
	});

	it("session_before_fork ends the previous session with the fork reason", async () => {
		const requests: Array<{ method: string; path: string; body: unknown }> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				const path = new URL(req.url).pathname;
				const body = req.method === "POST" ? ((await req.json().catch(() => undefined)) as unknown) : undefined;
				requests.push({ method: req.method, path, body });
				if (path === "/health") return new Response(null, { status: 200 });
				if (path === "/api/hooks/session-start") return Response.json({ inject: "session-context" });
				if (path === "/api/hooks/session-end") return Response.json({ ok: true });
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;

		const handlers: HandlerMap = {};
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				(handlers[event] ??= []).push(handler);
			},
			registerCommand(_name: string, _opts: unknown) {},
			registerTool(_opts: unknown) {},
		};
		SignetPiExtension(pi as never);

		const ctx = {
			cwd: "/tmp/pi-project",
			sessionManager: {
				getBranch: () => [],
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				getHeader: () => ({ id: "session-pi-fork-1", cwd: "/tmp/pi-project" }),
				getSessionFile: () => undefined,
				getSessionId: () => "session-pi-fork-1",
			},
			ui: {
				notify: () => {},
				setStatus: () => {},
				theme: { fg: (_color: string, text: string) => text },
			},
		};

		await handlers.session_start[0]?.({}, ctx);
		await handlers.session_before_fork[0]?.({ type: "session_before_fork", entryId: "entry-42" }, ctx);

		const end = requests.find((r) => r.method === "POST" && r.path === "/api/hooks/session-end");
		expect(end).toBeDefined();
		expect(end?.body).toMatchObject({
			harness: "pi",
			reason: "session_fork",
			sessionKey: "session-pi-fork-1",
		});
	});

	it("pi-mono flow: before-event ends the old session, then session_start establishes the new one", async () => {
		const requests: Array<{ method: string; path: string; body: unknown }> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				const path = new URL(req.url).pathname;
				const body = req.method === "POST" ? ((await req.json().catch(() => undefined)) as unknown) : undefined;
				requests.push({ method: req.method, path, body });
				if (path === "/health") return new Response(null, { status: 200 });
				if (path === "/api/hooks/session-start") return Response.json({ inject: "session-context" });
				if (path === "/api/hooks/session-end") return Response.json({ ok: true });
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;

		const handlers: HandlerMap = {};
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				(handlers[event] ??= []).push(handler);
			},
			registerCommand(_name: string, _opts: unknown) {},
			registerTool(_opts: unknown) {},
		};
		SignetPiExtension(pi as never);

		const ctxFor = (id: string) => ({
			cwd: "/tmp/pi-project",
			sessionManager: {
				getBranch: () => [],
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				getHeader: () => ({ id, cwd: "/tmp/pi-project" }),
				getSessionFile: () => undefined,
				getSessionId: () => id,
			},
			ui: {
				notify: () => {},
				setStatus: () => {},
				theme: { fg: (_color: string, text: string) => text },
			},
		});
		await handlers.session_start[0]?.({}, ctxFor("session-A"));
		await handlers.session_before_switch[0]?.({ type: "session_before_switch", reason: "new" }, ctxFor("session-A"));
		await handlers.session_start[0]?.({}, ctxFor("session-B"));

		const posts = requests.filter((r) => r.method === "POST");
		const ends = posts.filter((r) => r.path === "/api/hooks/session-end");
		const starts = posts.filter((r) => r.path === "/api/hooks/session-start");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.body).toMatchObject({ harness: "pi", reason: "session_switch", sessionKey: "session-A" });
		expect(starts.map((r) => (r.body as { sessionKey?: string }).sessionKey)).toEqual(["session-A", "session-B"]);
	});

	it("bypass mode skips automatic hooks but keeps commands and tools", () => {
		process.env.SIGNET_BYPASS = "1";

		const events = new Set<string>();
		let commandCount = 0;
		let toolCount = 0;
		const pi = {
			on(event: string, _handler: unknown) {
				events.add(event);
			},
			registerCommand(_name: string, _opts: unknown) {
				commandCount++;
			},
			registerTool(_opts: unknown) {
				toolCount++;
			},
		};

		SignetPiExtension(pi as never);
		expect(events.has("session_start")).toBe(false);
		expect(events.has("before_agent_start")).toBe(false);
		expect(events.has("context")).toBe(false);
		expect(events.has("session_before_compact")).toBe(false);
		expect(commandCount).toBeGreaterThan(0);
		expect(toolCount).toBeGreaterThan(0);
	});

	it("registers the Signet-facing Pi tool surface without memory feedback", () => {
		const toolNames: string[] = [];
		const pi = {
			on(_event: string, _handler: unknown) {},
			registerCommand(_name: string, _opts: unknown) {},
			registerTool(opts: { name: string }) {
				toolNames.push(opts.name);
			},
		};

		SignetPiExtension(pi as never);

		expect(toolNames).toContain("signet_recall");
		expect(toolNames).toContain("signet_source_search");
		expect(toolNames).toContain("signet_session_search");
		expect(toolNames).toContain("signet_remember");
		expect(toolNames).not.toContain("signet_memory_feedback");
	});

	it("signet_recall tool forwards canonical recall context with default limit 10", async () => {
		let capturedBody: Record<string, unknown> = {};
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				const path = new URL(req.url).pathname;
				if (path === "/health") return new Response(null, { status: 200 });
				if (path === "/api/memory/recall") {
					capturedBody = (await req.json()) as Record<string, unknown>;
					return Response.json({
						method: "hybrid",
						results: [{ id: "mem-1", content: "session memory", source: "hybrid", type: "fact" }],
						meta: { totalReturned: 1, hasSupplementary: false, noHits: false },
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;
		process.env.SIGNET_AGENT_ID = "context-agent";

		let recallTool:
			| {
					parameters?: { properties?: Record<string, unknown> };
					execute: (
						toolCallId: string,
						params: Record<string, unknown>,
						signal: AbortSignal,
						onUpdate: unknown,
						ctx: unknown,
					) => Promise<unknown>;
			  }
			| undefined;
		const pi = {
			on(_event: string, _handler: unknown) {},
			registerCommand(_name: string, _opts: unknown) {},
			registerTool(opts: { name: string; parameters?: { properties?: Record<string, unknown> }; execute: never }) {
				if (opts.name === "signet_recall") recallTool = opts as typeof recallTool;
			},
		};

		SignetPiExtension(pi as never);

		expect(recallTool?.parameters?.properties).toHaveProperty("sessionKey");
		expect(recallTool?.parameters?.properties).toHaveProperty("includeRecalled");
		expect(recallTool?.parameters?.properties).toHaveProperty("scope");

		const ctx = {
			sessionManager: {
				getHeader: () => ({ id: "ctx-session", cwd: "/tmp/pi-project" }),
				getSessionId: () => "ctx-session",
			},
			ui: {
				setStatus: () => {},
				theme: { fg: (_color: string, text: string) => text },
			},
		};

		await recallTool?.execute(
			"tool-call-1",
			{
				query: "session memory",
				sessionKey: "explicit-session",
				includeRecalled: true,
				scope: "session",
			},
			new AbortController().signal,
			undefined,
			ctx,
		);

		expect(capturedBody).toMatchObject({
			query: "session memory",
			limit: 10,
			agentId: "context-agent",
			sessionKey: "explicit-session",
			includeRecalled: true,
			scope: "session",
		});
	});

	it("signet_recall tool labels degraded aggregate evidence honestly", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				const path = new URL(req.url).pathname;
				if (path === "/health") return new Response(null, { status: 200 });
				if (path === "/api/memory/recall") {
					return Response.json({
						method: "hybrid",
						results: [{ id: "mem-1", content: "First evidence", source: "hybrid", type: "semantic" }],
						meta: { totalReturned: 1, hasSupplementary: false, noHits: false },
						aggregate: {
							savedMemoryId: null,
							saved: false,
							deduped: false,
							budget: "small",
							queries: ["what happened"],
							sourceMemoryIds: ["mem-1"],
							stoppedReason: "synthesis_failed",
							partial: true,
							message: "Aggregate recall synthesis failed; returning retrieved evidence.",
						},
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;

		let recallTool:
			| {
					execute: (
						toolCallId: string,
						params: Record<string, unknown>,
						signal: AbortSignal,
						onUpdate: unknown,
						ctx: unknown,
					) => Promise<{ content?: Array<{ text?: string }>; details?: Record<string, unknown> }>;
			  }
			| undefined;
		const pi = {
			on(_event: string, _handler: unknown) {},
			registerCommand(_name: string, _opts: unknown) {},
			registerTool(opts: { name: string; execute: never }) {
				if (opts.name === "signet_recall") recallTool = opts as typeof recallTool;
			},
		};

		SignetPiExtension(pi as never);

		const result = await recallTool?.execute(
			"tool-call-1",
			{ query: "what happened", aggregate: true },
			new AbortController().signal,
			undefined,
			{
				sessionManager: { getHeader: () => ({ id: "ctx-session" }), getSessionId: () => "ctx-session" },
				ui: { setStatus: () => {}, theme: { fg: (_color: string, text: string) => text } },
			},
		);

		expect(result?.content?.[0]?.text).toContain("[Aggregate Recall degraded]");
		expect(result?.content?.[0]?.text).toContain("Aggregate recall synthesis failed");
		expect(result?.content?.[0]?.text).toContain("First evidence");
		expect(result?.details?.aggregate).toMatchObject({ partial: true, stoppedReason: "synthesis_failed" });
	});

	it("/recall command uses the canonical default recall limit", async () => {
		let capturedBody: Record<string, unknown> = {};
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				const path = new URL(req.url).pathname;
				if (path === "/health") return new Response(null, { status: 200 });
				if (path === "/api/memory/recall") {
					capturedBody = (await req.json()) as Record<string, unknown>;
					return Response.json({
						method: "hybrid",
						results: [{ id: "mem-1", content: "command memory", source: "hybrid", type: "fact" }],
						meta: { totalReturned: 1, hasSupplementary: false, noHits: false },
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;

		let recallCommand: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		const pi = {
			on(_event: string, _handler: unknown) {},
			registerCommand(name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) {
				if (name === "recall") recallCommand = opts;
			},
			registerTool(_opts: unknown) {},
		};

		SignetPiExtension(pi as never);
		await recallCommand?.handler("command memory", {
			ui: {
				notify: () => {},
				setStatus: () => {},
				theme: { fg: (_color: string, text: string) => text },
			},
		});

		expect(capturedBody.limit).toBe(10);
	});

	it.each(["clock", "recall", "compacted"])(
		"delivers refreshed session context after %s-only history",
		async (kind) => {
			let available = kind === "compacted";
			const server = Bun.serve({
				port: 0,
				fetch(req) {
					const path = new URL(req.url).pathname;
					if (path === "/api/hooks/session-start") {
						return Response.json({ dynamicContext: available ? "refreshed session context" : "" });
					}
					if (path === "/api/hooks/user-prompt-submit") {
						return Response.json(
							kind === "recall" ? { dynamicContext: "prompt recall" } : { clockContext: "prompt clock" },
						);
					}
					return Response.json({});
				},
			});
			servers.push(server);
			process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;
			const handlers: HandlerMap = {};
			SignetPiExtension({
				on(event, handler) {
					(handlers[event] ??= []).push((event, ctx): unknown => Reflect.apply(handler, undefined, [event, ctx]));
				},
				registerCommand() {},
				registerTool() {},
				registerFlag() {},
				getFlag() {},
				sendMessage() {},
				ui: { notify() {}, setStatus() {}, theme: { fg: (_color: string, text: string) => text } },
			});
			const history: Array<PiCustomMessage & { type: string; role: string }> = [];
			const ctx = {
				cwd: "/synthetic/pi-project",
				sessionManager: {
					getBranch: () => history,
					getEntries: () => history,
					buildSessionContext: () => ({ messages: kind === "compacted" ? [] : history }),
					getHeader: () => ({ id: "session", cwd: "/synthetic/pi-project" }),
					getSessionId: () => "session",
					getSessionFile: () => undefined,
				},
				ui: { notify() {}, setStatus() {}, theme: { fg: (_color: string, text: string) => text } },
			};
			await handlers.session_start?.[0]?.({}, ctx);
			const first = await handlers.before_agent_start?.[0]?.({ prompt: "first" }, ctx);
			if (typeof first !== "object" || first === null || !("message" in first))
				throw new Error("Missing first message");
			const message = first.message;
			if (
				typeof message !== "object" ||
				message === null ||
				!("content" in message) ||
				typeof message.content !== "string" ||
				!("customType" in message) ||
				typeof message.customType !== "string" ||
				!("display" in message) ||
				typeof message.display !== "boolean"
			)
				throw new Error("Invalid first message");
			history.push({ ...message, type: "custom_message", role: "custom" });
			expect(message.content.includes("refreshed session context")).toBe(kind === "compacted");
			available = true;
			if (kind === "compacted") {
				await handlers.session_compact?.[0]?.({ compactionEntry: { summary: "ordinary conversation summary" } }, ctx);
			}
			if (kind !== "compacted") await handlers.session_start?.[0]?.({}, ctx);
			const next = await handlers.before_agent_start?.[0]?.({ prompt: "continue" }, ctx);
			expect(JSON.stringify(next)).toContain("refreshed session context");
		},
	);

	it("keeps context append-only across requests and resumed session lifecycles", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				const path = new URL(req.url).pathname;
				if (path === "/api/hooks/session-start") {
					return Response.json({
						stableSystemPrompt: "stable-session-context",
						dynamicContext: "session-context-content",
					});
				}
				if (path === "/api/hooks/user-prompt-submit") {
					return Response.json({
						dynamicContext: "[signet:recall]\n- Preferred language is TypeScript",
						clockContext: "Current date/time: 2026-10-14T17:22:54+00:00 (UTC)",
					});
				}
				if (path === "/api/hooks/notifications") return Response.json({});
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;

		const handlers: HandlerMap = {};
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				(handlers[event] ??= []).push(handler);
			},
			registerCommand(_name: string, _opts: unknown) {},
			registerTool(_opts: unknown) {},
		};
		SignetPiExtension(pi as never);

		const entries: Array<{ type: string; role: string; customType: string; details?: unknown }> = [];
		const ctx = {
			cwd: "/tmp/pi-project",
			sessionManager: {
				getBranch: () => entries,
				buildSessionContext: () => ({ messages: entries }),
				getEntries: () => [],
				getHeader: () => ({ id: "session-pi-1", cwd: "/tmp/pi-project" }),
				getSessionFile: () => undefined,
				getSessionId: () => "session-pi-1",
			},
			ui: {
				notify: () => {},
				setStatus: () => {},
				theme: { fg: (_color: string, text: string) => text },
			},
		};

		const history: unknown[] = [{ role: "user", content: "what is my preferred language?" }];
		const start = await handlers.before_agent_start[0]?.({ prompt: "what is my preferred language?" }, ctx);
		if (typeof start === "object" && start !== null && "message" in start) history.push(start.message);
		const first = await handlers.context[0]?.({ messages: [...history] }, ctx);
		const firstMessages =
			typeof first === "object" && first !== null && "messages" in first ? first.messages : [...history];
		const request = JSON.stringify(firstMessages);
		history.push({ role: "assistant", content: "Checking preferences" }, { role: "toolResult", content: "TypeScript" });
		const second = await handlers.context[0]?.({ messages: [...history] }, ctx);
		const secondMessages =
			typeof second === "object" && second !== null && "messages" in second ? second.messages : [...history];

		expect(JSON.stringify(secondMessages).startsWith(request.slice(0, -1))).toBe(true);
		expect(request).toContain("session-context-content");
		expect(request).toContain("Preferred language is TypeScript");
		expect(request).toContain("Current date/time: 2026-10-14T17:22:54+00:00 (UTC)");
		expect(start).toMatchObject({ message: { customType: "signet-pi-context", display: false } });
		expect(first).toBeUndefined();
		expect(second).toBeUndefined();
		const restored: unknown = JSON.parse(JSON.stringify(history));
		expect(await handlers.context[0]?.({ messages: restored }, ctx)).toBeUndefined();
		expect(restored).toEqual(history);
		entries.push({
			type: "custom_message",
			role: "custom",
			customType: "signet-pi-context",
			details: { sessionContext: true },
		});
		for (const event of ["session_start", "session_start", "session_switch", "session_fork"]) {
			await handlers[event]?.[0]?.({}, ctx);
			const resumed = await handlers.before_agent_start[0]?.({ prompt: "continue" }, ctx);
			expect(JSON.stringify(resumed)).not.toContain("session-context-content");
			expect(JSON.stringify(resumed)).toContain("Preferred language is TypeScript");
		}
		entries[0] = { type: "custom_message", role: "custom", customType: "signet-pi-session-context" };
		await handlers.session_switch[0]?.({}, ctx);
		expect(JSON.stringify(await handlers.before_agent_start[0]?.({ prompt: "legacy resume" }, ctx))).not.toContain(
			"session-context-content",
		);
		entries.splice(0);
		await handlers.session_fork[0]?.({}, ctx);
		expect(JSON.stringify(await handlers.before_agent_start[0]?.({ prompt: "new fork" }, ctx))).toContain(
			"session-context-content",
		);
	});

	it("a custom-message run does not trigger user-prompt recall", async () => {
		let promptSubmits = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				const path = new URL(req.url).pathname;
				if (path === "/api/hooks/session-start") return Response.json({ dynamicContext: "session-context-content" });
				if (path === "/api/hooks/user-prompt-submit") {
					promptSubmits += 1;
					return Response.json({ dynamicContext: "[signet:recall]\n- should not be requested" });
				}
				if (path === "/api/hooks/notifications") return Response.json({});
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;

		const handlers: HandlerMap = {};
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				(handlers[event] ??= []).push(handler);
			},
			registerCommand(_name: string, _opts: unknown) {},
			registerTool(_opts: unknown) {},
		};
		SignetPiExtension(pi as never);

		const ctx = {
			cwd: "/tmp/pi-project",
			sessionManager: {
				getBranch: () => [],
				getEntries: () => [],
				getHeader: () => ({ id: "session-pi-custom", cwd: "/tmp/pi-project" }),
				getSessionFile: () => undefined,
				getSessionId: () => "session-pi-custom",
				buildSessionContext: () => ({ messages: [] }),
			},
			ui: {
				notify: () => {},
				setStatus: () => {},
				theme: { fg: (_color: string, text: string) => text },
			},
		};

		await handlers.before_agent_start[0]?.({ messageType: "custom", message: { role: "custom" } }, ctx);
		expect(promptSubmits).toBe(0);

		await handlers.before_agent_start[0]?.({ messageType: "user", prompt: "what changed?" }, ctx);
		expect(promptSubmits).toBe(1);
	});

	it("input does not wait for prompt-submit and before_agent_start does not retry a failed submit", async () => {
		let promptSubmits = 0;
		let releasePromptSubmit: () => void = () => {};
		const promptSubmitGate = new Promise<void>((resolve) => {
			releasePromptSubmit = resolve;
		});
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				const path = new URL(req.url).pathname;
				if (path === "/api/hooks/session-start") return Response.json({});
				if (path === "/api/hooks/user-prompt-submit") {
					promptSubmits += 1;
					await promptSubmitGate;
					return new Response("daemon busy", { status: 503 });
				}
				if (path === "/api/hooks/notifications") return Response.json({});
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;

		const handlers: HandlerMap = {};
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				(handlers[event] ??= []).push(handler);
			},
			registerCommand(_name: string, _opts: unknown) {},
			registerTool(_opts: unknown) {},
		};
		SignetPiExtension(pi as never);
		const ctx = {
			cwd: "/tmp/pi-project",
			sessionManager: {
				getBranch: () => [],
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				getHeader: () => ({ id: "session-pi-slow", cwd: "/tmp/pi-project" }),
				getSessionFile: () => undefined,
				getSessionId: () => "session-pi-slow",
			},
			ui: {
				notify: () => {},
				setStatus: () => {},
				theme: { fg: (_color: string, text: string) => text },
			},
		};

		try {
			const input = Promise.resolve(handlers.input[0]?.({ text: "hello" }, ctx)).then(() => "accepted");
			const outcome = await Promise.race([input, Bun.sleep(250).then(() => "blocked")]);
			expect(outcome).toBe("accepted");
		} finally {
			releasePromptSubmit();
		}

		await handlers.before_agent_start[0]?.({ prompt: "hello" }, ctx);
		const result = await handlers.context[0]?.({ messages: [] }, ctx);
		expect(promptSubmits).toBe(1);
		const messages = (result as { messages?: Array<{ customType?: string }> } | undefined)?.messages ?? [];
		expect(messages.some((message) => message.customType === "signet-pi-hidden-recall")).toBe(false);
	});

	it.each(["recall", "notification"])("defers late %s to the next prompt", async (source: string) => {
		const delivered: Array<{ readonly message: PiCustomMessage; readonly options: unknown }> = [];
		let promptSubmits = 0;
		let polls = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				const path = new URL(req.url).pathname;
				if (path === "/api/hooks/session-start") return Response.json({});
				if (path === "/api/hooks/user-prompt-submit") {
					promptSubmits += 1;
					return Response.json({
						dynamicContext: "[signet:recall]\n- Steered recall",
						clockContext: "Current date/time: late",
					});
				}
				if (path === "/api/hooks/notifications") {
					polls += 1;
					return Response.json({ inject: polls === 1 && source === "notification" ? "Late peer notification" : "" });
				}
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;

		const handlers: HandlerMap = {};
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				(handlers[event] ??= []).push(handler);
			},
			registerCommand(_name: string, _opts: unknown) {},
			registerTool(_opts: unknown) {},
			sendMessage(message: PiCustomMessage, options: unknown): void {
				delivered.push({ message, options });
			},
		};
		SignetPiExtension(pi as never);
		const ctx = {
			cwd: "/tmp/pi-project",
			sessionManager: {
				getBranch: () => [],
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				getHeader: () => ({ id: "session-pi-steer", cwd: "/tmp/pi-project" }),
				getSessionFile: () => undefined,
				getSessionId: () => "session-pi-steer",
			},
			ui: {
				notify: () => {},
				setStatus: () => {},
				theme: { fg: (_color: string, text: string) => text },
			},
		};

		if (source === "recall") await handlers.input[0]?.({ text: "steer toward the recalled fact" }, ctx);
		const history: unknown[] = [{ role: "user", content: "Already running" }];
		const first = await handlers.context[0]?.({ messages: [...history] }, ctx);
		expect(first).toBeUndefined();
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.options).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
		expect(delivered[0]?.message).toMatchObject({ customType: "signet-pi-context", display: false });
		expect(delivered[0]?.message.content).toContain(source === "recall" ? "Steered recall" : "Late peer notification");
		if (source === "recall") expect(delivered[0]?.message.content).toContain("Current date/time: late");
		history.push({ role: "assistant", content: "Final answer" });
		const second = await handlers.context[0]?.({ messages: [...history] }, ctx);
		expect(second).toBeUndefined();
		expect(delivered).toHaveLength(1);
		expect(promptSubmits).toBe(source === "recall" ? 1 : 0);
	});

	it("excludes Signet context from both compaction inputs and posts session metadata", async () => {
		const requests: Array<{ path: string; body: unknown }> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				const path = new URL(req.url).pathname;
				const body = req.method === "POST" ? ((await req.json()) as unknown) : undefined;
				requests.push({ path, body });

				if (path === "/api/hooks/session-start") {
					return Response.json({ inject: "session-context-content" });
				}
				if (path === "/api/hooks/pre-compaction") {
					return Response.json({ summaryPrompt: "keep the important bits" });
				}
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;
		await fetch(`http://127.0.0.1:${server.port}`, { method: "HEAD" });

		const handlers: HandlerMap = {};
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				(handlers[event] ??= []).push(handler);
			},
			registerCommand(_name: string, _opts: unknown) {},
			registerTool(_opts: unknown) {},
		};
		SignetPiExtension(pi as never);

		const ctx = {
			cwd: "/tmp/pi-project",
			sessionManager: {
				getBranch: () => [],
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				getHeader: () => ({ id: "session-pi-compact-1", cwd: "/tmp/pi-project" }),
				getSessionFile: () => undefined,
				getSessionId: () => "session-pi-compact-1",
			},
			ui: {
				notify: () => {},
				setStatus: () => {},
				theme: { fg: (_color: string, text: string) => text },
			},
		};

		const user = { role: "user", content: "User-authored evidence" };
		const other = { role: "custom", customType: "another-extension", content: "Other context" };
		const injected = [
			"signet-pi-context",
			"signet-pi-session-context",
			"signet-pi-hidden-recall",
			"signet-pi-clock-context",
		].map((customType) => ({ role: "custom", customType, content: "Recalled memory" }));
		const preparation = {
			messagesToSummarize: [user, ...injected, other],
			turnPrefixMessages: [...injected, user],
		};
		const result = await handlers.session_before_compact[0]?.({ type: "session_before_compact", preparation }, ctx);
		expect(preparation.messagesToSummarize).toEqual([user, other]);
		expect(preparation.turnPrefixMessages).toEqual([user]);
		expect(injected).toHaveLength(4);

		expect(result).toBeUndefined();
		expect(requests.map((req) => req.path)).toEqual(["/api/hooks/session-start", "/api/hooks/pre-compaction"]);
		expect(requests[1]?.body).toMatchObject({
			harness: "pi",
			sessionKey: "session-pi-compact-1",
			messageCount: 2,
			runtimePath: "plugin",
		});
	});

	it("session_compact posts compaction-complete with summary and current session info", async () => {
		const requests: Array<{ path: string; body: unknown }> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				const path = new URL(req.url).pathname;
				const body = req.method === "POST" ? ((await req.json()) as unknown) : undefined;
				requests.push({ path, body });

				if (path === "/api/hooks/compaction-complete") {
					return Response.json({ ok: true });
				}
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;
		process.env.SIGNET_AGENT_ID = "agent-pi-test";

		const handlers: HandlerMap = {};
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				(handlers[event] ??= []).push(handler);
			},
			registerCommand(_name: string, _opts: unknown) {},
			registerTool(_opts: unknown) {},
		};
		SignetPiExtension(pi as never);

		const ctx = {
			cwd: "/tmp/pi-project",
			sessionManager: {
				getBranch: () => [],
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				getHeader: () => ({ id: "session-pi-compact-2", cwd: "/tmp/pi-project" }),
				getSessionFile: () => undefined,
				getSessionId: () => "session-pi-compact-2",
			},
			ui: {
				notify: () => {},
				setStatus: () => {},
				theme: { fg: (_color: string, text: string) => text },
			},
		};

		await handlers.session_compact[0]?.(
			{
				compactionEntry: {
					summary: "the conversation was about TypeScript and memory routing",
				},
			},
			ctx,
		);

		expect(requests.map((req) => req.path)).toEqual(["/api/hooks/compaction-complete", "/api/hooks/session-start"]);
		expect(requests[0]?.body).toEqual({
			harness: "pi",
			summary: "the conversation was about TypeScript and memory routing",
			project: "/tmp/pi-project",
			sessionKey: "session-pi-compact-2",
			agentId: "agent-pi-test",
			runtimePath: "plugin",
		});
	});
});

describe("collaboration tools", () => {
	type Tool = {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: unknown,
			ctx: unknown,
		) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
	};
	type Seen = { method: string; path: string; search: string; body: unknown };

	async function setup(): Promise<{ tools: Map<string, Tool>; seen: Seen[] }> {
		const seen: Seen[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "HEAD" && new URL(req.url).pathname === "/") return new Response(null);
				const url = new URL(req.url);
				if (url.pathname === "/health" || (url.pathname === "/" && req.method === "HEAD"))
					return new Response(null, { status: 200 });
				const text = req.method === "GET" ? "" : await req.text();
				seen.push({
					method: req.method,
					path: url.pathname,
					search: url.search,
					body: text ? JSON.parse(text) : undefined,
				});
				if (url.pathname === "/api/board/threads/bad") return new Response("nope", { status: 500 });
				if (req.method === "GET" && url.pathname === "/api/board/threads/t%201") {
					return Response.json({
						posts: [{ id: "p1" }, { id: "p2" }],
						hasMorePosts: url.searchParams.get("limit") === "2",
						readThroughPostId: "p2",
					});
				}
				return Response.json({ ok: true });
			},
		});
		servers.push(server);
		savedEnv = {
			SIGNET_DAEMON_URL: process.env.SIGNET_DAEMON_URL,
			SIGNET_AGENT_ID: process.env.SIGNET_AGENT_ID,
			SIGNET_BYPASS: process.env.SIGNET_BYPASS,
		};
		process.env.SIGNET_DAEMON_URL = `http://127.0.0.1:${server.port}`;
		process.env.SIGNET_AGENT_ID = "pi-agent";
		Reflect.deleteProperty(process.env, "SIGNET_BYPASS");
		const tools = new Map<string, Tool>();
		SignetPiExtension({
			on() {},
			registerCommand() {},
			registerTool(opts: { name: string }) {
				tools.set(opts.name, opts as unknown as Tool);
			},
		} as never);
		return { tools, seen };
	}

	const ctx = {
		sessionManager: {
			getHeader: () => ({ id: "pi-sess" }),
			getSessionId: () => "pi-sess",
			getSessionFile: () => undefined,
		},
		ui: { setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } },
	};

	function run(tools: Map<string, Tool>, name: string, params: Record<string, unknown>) {
		const tool = tools.get(name);
		if (!tool) throw new Error(`missing tool ${name}`);
		return tool.execute("call", params, new AbortController().signal, undefined, ctx);
	}

	it("registers all tools", async () => {
		const { tools } = await setup();
		for (const name of [
			"agent_peers",
			"agent_message_send",
			"agent_message_inbox",
			"agent_message_ack",
			"board_list",
			"board_read",
			"board_post",
			"board_update",
		]) {
			expect(tools.has(name)).toBe(true);
		}
	});

	it("agent_peers fills identity", async () => {
		const { tools, seen } = await setup();
		await run(tools, "agent_peers", { include_self: true, limit: 5 });
		const params = new URLSearchParams(seen[0]?.search);
		expect(seen[0]?.path).toBe("/api/cross-agent/presence");
		expect(params.get("agent_id")).toBe("pi-agent");
		expect(params.get("session_key")).toBe("pi-sess");
		expect(params.get("include_self")).toBe("true");
		expect(params.get("limit")).toBe("5");
	});

	it("agent_message_send requires exactly one target and auto-fills sender", async () => {
		const { tools, seen } = await setup();
		const none = await run(tools, "agent_message_send", { content: "hi" });
		const both = await run(tools, "agent_message_send", { content: "hi", to_agent_id: "a", broadcast: true });
		expect(none.isError).toBe(true);
		expect(both.isError).toBe(true);
		expect(seen).toHaveLength(0);

		const sent = await run(tools, "agent_message_send", {
			content: "hi",
			to_session_key: "peer-1",
			type: "question",
			fromSessionKey: "spoofed",
		});
		expect(sent.isError).toBeUndefined();
		expect(seen[0]?.method).toBe("POST");
		expect(seen[0]?.path).toBe("/api/cross-agent/messages");
		expect(seen[0]?.body).toMatchObject({
			fromAgentId: "pi-agent",
			fromSessionKey: "pi-sess",
			toSessionKey: "peer-1",
			broadcast: false,
			type: "question",
			content: "hi",
		});
	});

	it("agent_message_inbox and ack use encoded paths", async () => {
		const { tools, seen } = await setup();
		await run(tools, "agent_message_inbox", { unread_only: true, limit: 99 });
		const params = new URLSearchParams(seen[0]?.search);
		expect(seen[0]?.path).toBe("/api/cross-agent/messages");
		expect(params.get("agent_id")).toBe("pi-agent");
		expect(params.get("session_key")).toBe("pi-sess");
		expect(params.get("unread_only")).toBe("true");
		expect(params.get("limit")).toBe("25");

		await run(tools, "agent_message_ack", { message_id: "m/1" });
		expect(seen[1]?.method).toBe("POST");
		expect(seen[1]?.path).toBe("/api/cross-agent/messages/m%2F1/ack");
		expect(seen[1]?.body).toEqual({ agentId: "pi-agent", sessionKey: "pi-sess" });
	});

	it("board_list returns topics and threads", async () => {
		const { tools, seen } = await setup();
		const result = await run(tools, "board_list", { topic: "dev", status: "all", limit: 3 });
		expect(seen.map((s) => s.path).sort()).toEqual(["/api/board/threads", "/api/board/topics"]);
		const threads = seen.find((s) => s.path === "/api/board/threads");
		const params = new URLSearchParams(threads?.search);
		expect(params.get("topic")).toBe("dev");
		expect(params.get("status")).toBe("all");
		expect(params.get("agent_id")).toBe("pi-agent");
		expect(result.content[0]?.text).toContain("topics");
		expect(result.content[0]?.text).toContain("threads");
	});

	it("board_read fetches then marks read", async () => {
		const { tools, seen } = await setup();
		const result = await run(tools, "board_read", { thread_id: "t 1" });
		expect(result.isError).toBeUndefined();
		expect(seen[0]?.method).toBe("GET");
		expect(seen[0]?.path).toBe("/api/board/threads/t%201");
		expect(seen[1]?.method).toBe("POST");
		expect(seen[1]?.path).toBe("/api/board/threads/t%201/read");
		expect(seen[1]?.body).toEqual({ agentId: "pi-agent", throughPostId: "p2" });
	});

	it("board_read marks through the newest returned post when more posts remain", async () => {
		const { tools, seen } = await setup();
		await run(tools, "board_read", { thread_id: "t 1", limit: 2 });
		expect(seen[1]?.body).toEqual({ agentId: "pi-agent", throughPostId: "p2" });
	});

	it("board_read leaves the read cursor alone for an offset page", async () => {
		const { tools, seen } = await setup();
		await run(tools, "board_read", { thread_id: "t 1", offset: 3 });
		expect(seen.map((call) => call.method)).toEqual(["GET"]);
	});

	it("board_post replies to a thread or starts a new one with harness pi", async () => {
		const { tools, seen } = await setup();
		await run(tools, "board_post", { thread_id: "t1", body: "reply", reply_to_post_id: "p1" });
		expect(seen[0]?.path).toBe("/api/board/threads/t1/posts");
		expect(seen[0]?.body).toMatchObject({
			agentId: "pi-agent",
			sessionKey: "pi-sess",
			harness: "pi",
			body: "reply",
			replyToPostId: "p1",
		});

		await run(tools, "board_post", { topic: "dev", title: "T", body: "b", tags: ["x"], from_message_id: "m1" });
		expect(seen[1]?.path).toBe("/api/board/threads");
		expect(seen[1]?.body).toMatchObject({
			agentId: "pi-agent",
			sessionKey: "pi-sess",
			harness: "pi",
			topic: "dev",
			title: "T",
			body: "b",
			tags: ["x"],
			fromMessageId: "m1",
		});
	});

	it("board_update sends PATCH and reports errors", async () => {
		const { tools, seen } = await setup();
		await run(tools, "board_update", { thread_id: "t1", status: "resolved", pinned: true, tags: ["a"] });
		expect(seen[0]?.method).toBe("PATCH");
		expect(seen[0]?.path).toBe("/api/board/threads/t1");
		expect(seen[0]?.body).toEqual({ agentId: "pi-agent", status: "resolved", pinned: true, tags: ["a"] });

		const failed = await run(tools, "board_update", { thread_id: "bad", status: "open" });
		expect(failed.isError).toBe(true);
		expect(failed.content[0]?.text).toContain("500");
	});
});
