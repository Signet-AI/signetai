import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import SignetPiExtension, { loadConfig, parseRememberArgs, recallMemories, rememberContent } from "./src/index.js";

// ============================================================================
// Helpers
// ============================================================================

const tempDirs: string[] = [];
const servers: Array<{ stop: () => void }> = [];
let savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
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

/** Creates a temp dir inside homedir so it can be addressed as ~/relative-path. */
function makeTempDirInHome() {
	const dir = mkdtempSync(join(homedir(), ".signet-pi-test-"));
	tempDirs.push(dir);
	return dir;
}

// ============================================================================
// loadConfig
// ============================================================================

describe("loadConfig", () => {
	it("defaults to enabled when no env var or config file exists", () => {
		saveEnv("SIGNET_ENABLED", "PI_CODING_AGENT_DIR");
		delete process.env.SIGNET_ENABLED;
		process.env.PI_CODING_AGENT_DIR = makeTempDir(); // empty dir — no signet.json
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
		delete process.env.SIGNET_ENABLED;
		expect(loadConfig().enabled).toBe(false);
	});

	it("resolves PI_CODING_AGENT_DIR with tilde expansion", () => {
		saveEnv("SIGNET_ENABLED", "PI_CODING_AGENT_DIR");
		const dir = makeTempDirInHome();
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(join(dir, "extensions", "signet.json"), JSON.stringify({ enabled: false }));
		// Express the path as ~/relative so tilde expansion is required
		const rel = relative(homedir(), dir);
		process.env.PI_CODING_AGENT_DIR = `~/${rel}`;
		delete process.env.SIGNET_ENABLED;
		expect(loadConfig().enabled).toBe(false);
	});

	it("reads config from persisted pi.json when PI_CODING_AGENT_DIR is unset", () => {
		saveEnv("SIGNET_ENABLED", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME");
		delete process.env.SIGNET_ENABLED;
		delete process.env.PI_CODING_AGENT_DIR;

		// Set XDG_CONFIG_HOME to an isolated temp dir so we don't touch the real config
		const configHome = makeTempDir();
		process.env.XDG_CONFIG_HOME = configHome;

		// Write a signet/pi.json pointing at an agent dir containing signet.json
		const agentDir = makeTempDir();
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "signet.json"), JSON.stringify({ enabled: false }));
		mkdirSync(join(configHome, "signet"), { recursive: true });
		writeFileSync(join(configHome, "signet", "pi.json"), JSON.stringify({ version: 1, agentDir, updatedAt: new Date().toISOString() }));

		expect(loadConfig().enabled).toBe(false);
	});

	it("SIGNET_BYPASS=1 is not part of loadConfig (read at runtime)", () => {
		saveEnv("SIGNET_ENABLED", "SIGNET_BYPASS", "PI_CODING_AGENT_DIR");
		delete process.env.SIGNET_ENABLED;
		delete process.env.PI_CODING_AGENT_DIR;
		process.env.SIGNET_BYPASS = "1";
		// loadConfig does not include bypass — it's checked at factory call time
		const config = loadConfig();
		expect(config.enabled).toBe(true);
		expect(config).not.toHaveProperty("bypass");
	});
});

// ============================================================================
// parseRememberArgs
// ============================================================================

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

// ============================================================================
// recallMemories (regression: must read data.results, not data.memories)
// ============================================================================

describe("recallMemories", () => {
	it("returns memories from data.results field (not data.memories)", async () => {
		let capturedMethod: string | undefined;
		let capturedPath: string | undefined;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				capturedMethod = req.method;
				capturedPath = new URL(req.url).pathname;
				if (capturedPath === "/api/memory/recall") {
					return Response.json({
						results: [
							{ content: "use bun", importance: 0.9, tags: "bun,tooling", score: 0.9, source: "user", type: "fact", pinned: false, who: "agent", project: null, created_at: "" },
						],
						query: "bun",
						method: "hybrid",
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);

		const results = await recallMemories(`http://127.0.0.1:${server.port}`, "bun");
		expect(capturedMethod).toBe("POST");
		expect(capturedPath).toBe("/api/memory/recall");
		expect(results).toHaveLength(1);
		expect(results[0]?.content).toBe("use bun");
		expect(results[0]?.importance).toBe(0.9);
	});

	it("returns empty array when results field is absent", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch() {
				return Response.json({ query: "nothing", method: "hybrid" });
			},
		});
		servers.push(server);

		const results = await recallMemories(`http://127.0.0.1:${server.port}`, "nothing");
		expect(results).toEqual([]);
	});

	it("deserializes comma-separated string tags into an array", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch() {
				return Response.json({
					results: [{ content: "x", tags: "a,b,c", score: 1, importance: 1, source: "user", type: "fact", pinned: false, who: "agent", project: null, created_at: "" }],
				});
			},
		});
		servers.push(server);

		const [mem] = await recallMemories(`http://127.0.0.1:${server.port}`, "x");
		expect(mem?.tags).toEqual(["a", "b", "c"]);
	});

	it("does not send a scope field by default (preserves daemon unscoped-memory path)", async () => {
		let capturedBody: Record<string, unknown> = {};
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				capturedBody = (await req.json()) as Record<string, unknown>;
				return Response.json({ results: [] });
			},
		});
		servers.push(server);

		await recallMemories(`http://127.0.0.1:${server.port}`, "test");
		expect(capturedBody).not.toHaveProperty("scope");
	});
});

// ============================================================================
// rememberContent (regression: must include harness field)
// ============================================================================

describe("rememberContent", () => {
	it("includes harness field in the request body and POSTs to /api/hooks/remember", async () => {
		let capturedMethod: string | undefined;
		let capturedPath: string | undefined;
		let capturedBody: Record<string, unknown> = {};
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
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
				capturedBody = (await req.json()) as Record<string, unknown>;
				return new Response(null, { status: 200 });
			},
		});
		servers.push(server);

		await rememberContent(`http://127.0.0.1:${server.port}`, "test memory", {
			critical: true,
			tags: ["tag1", "tag2"],
		});
		expect(capturedBody.content).toBe("test memory");
		expect(capturedBody.pinned).toBe(true);
		expect(capturedBody.tags).toEqual(["tag1", "tag2"]);
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

// ============================================================================
// SignetPiExtension integration
// ============================================================================

interface HandlerMap {
	[event: string]: Array<(event: unknown, ctx: unknown) => unknown>;
}

describe("SignetPiExtension", () => {
	afterEach(() => {
		for (const server of servers.splice(0)) {
			server.stop();
		}
		delete process.env.SIGNET_ENABLED;
		delete process.env.SIGNET_AGENT_ID;
		delete process.env.SIGNET_DAEMON_URL;
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

		// Automatic hooks should NOT be registered
		expect(events.has("session_start")).toBe(false);
		expect(events.has("before_agent_start")).toBe(false);
		expect(events.has("context")).toBe(false);
		expect(events.has("session_before_compact")).toBe(false);

		// Commands and tools should still be registered
		expect(commandCount).toBeGreaterThan(0);
		expect(toolCount).toBeGreaterThan(0);
	});

	it("context injection end-to-end: session context and recall are delivered via context event", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				const path = new URL(req.url).pathname;
				if (path === "/api/hooks/session-start") {
					return Response.json({ inject: "session-context-content" });
				}
				if (path === "/api/hooks/user-prompt-submit") {
					return Response.json({ inject: "[signet:recall]\n- Preferred language is TypeScript" });
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
		};
		SignetPiExtension(pi as never);

		const ctx = {
			cwd: "/tmp/pi-project",
			sessionManager: {
				getBranch: () => [],
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

		await handlers.before_agent_start[0]?.({ prompt: "what is my preferred language?" }, ctx);
		const result = await handlers.context[0]?.({ messages: [] }, ctx);

		expect(result).not.toBeUndefined();
		const messages = (result as { messages: Array<{ customType?: string; content?: unknown }> })
			.messages;
		expect(Array.isArray(messages)).toBe(true);

		const sessionCtxMsg = messages.find((m) => m.customType === "signet-pi-session-context");
		expect(typeof sessionCtxMsg?.content).toBe("string");
		expect(sessionCtxMsg?.content as string).toContain("session-context-content");

		const recallMsg = messages.find((m) => m.customType === "signet-pi-hidden-recall");
		expect(typeof recallMsg?.content).toBe("string");
		expect(recallMsg?.content as string).toContain("Preferred language is TypeScript");
	});
});
