import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = process.env.SIGNET_TEST_CLI ?? resolve(import.meta.dir, "..", "cli.ts");

test.each([false, true, null, "node /x/signet.js", "[broken"])(
	"sync preserves configuration policy: %s",
	async (requiresAuth) => {
		const root = mkdtempSync(join(tmpdir(), "sync-launcher-"));
		const workspace = join(root, "agents");
		const env = { ...process.env };
		for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "HERMES_HOME", "PI_CODING_AGENT_DIR", "TMPDIR"]) {
			const path = join(root, name.toLowerCase());
			mkdirSync(path);
			env[name] = path;
		}
		const home = env.HOME ?? root;
		env.USERPROFILE = home;
		env.HOMEDRIVE = home;
		env.HOMEPATH = home;
		env.SIGNET_PATH = workspace;
		env.CODEX_HOME = join(home, ".codex");
		env.HERMES_REPO = join(root, "missing-repo");
		env.KIMI_SHARE_DIR = join(home, ".kimi");
		env.SIGNET_SKIP_AGENT_REGISTER = "1";
		env.SIGNET_AGENT_ID = "default";
		env.SIGNET_CLI_PATH = "";
		env.SIGNET_API_KEY = "sig_sk_sync_fixture_not_a_secret";
		env.SIGNET_TELEMETRY = "0";
		env.PATH = "";
		env.CODEX_CLI_PATH = "";
		env.SIGNET_CODEX_FORCE_COMPAT_HOOKS = "1";
		env.CODEX_APP_PATH = "";
		env.CHATGPT_APP_PATH = "";
		Reflect.deleteProperty(env, "SIGNET_HOOK_COMMAND");
		Reflect.deleteProperty(env, "SIGNET_WRAPPER_DIR");
		Reflect.deleteProperty(env, "SIGNET_DIR");
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				if (new URL(req.url).pathname === "/api/mode")
					return requiresAuth === null
						? new Response("offline", { status: 503 })
						: Response.json({ mode: "server", requiresAuth });
				return new Response(null, { status: 404 });
			},
		});
		env.SIGNET_DAEMON_URL = server.url.origin;
		env.SIGNET_PORT = String(server.port);
		mkdirSync(workspace);
		writeFileSync(
			join(workspace, "agent.yaml"),
			"harnesses:\n  - claude-code\n  - codex\n  - gemini\n  - kimi\n  - pi\n  - oh-my-pi\n  - muse-code\n  - forge\n  - opencode\n  - hermes-agent\nembedding:\n  provider: ollama\n",
		);
		for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"])
			writeFileSync(join(workspace, name), "fixture");
		for (const name of [".claude", ".codex", ".gemini"]) mkdirSync(join(home, name));
		const settings = join(home, ".claude", "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({
				hooks: {
					SessionStart: [
						{ hooks: [{ type: "command", command: "/host/bin/signet hook session-start -H claude-code" }] },
					],
					PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }],
				},
			}),
		);
		writeFileSync(
			join(home, ".codex", "hooks.json"),
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							hooks: [
								{
									type: "command",
									command: "SIGNET_API_KEY='stale-fixture' /host/bin/signet hook session-start -H codex",
								},
							],
						},
					],
				},
			}),
		);
		writeFileSync(
			join(home, ".gemini", "settings.json"),
			JSON.stringify({
				mcpServers: {
					signet: { command: "/host/bin/signet", args: [], env: { SIGNET_MCP_STDIO_WORKER: "1" } },
					other: { command: "other-mcp" },
				},
			}),
		);
		const before = readFileSync(settings, "utf-8");
		if (typeof requiresAuth === "string") env.SIGNET_HOOK_COMMAND = requiresAuth;
		try {
			for (let i = 0; i < 2; i++) {
				const child = Bun.spawn(
					[
						process.execPath,
						"--eval",
						`process.execPath = "/app/bin/signet"; process.execArgv = []; process.argv = ["signet", ${JSON.stringify(cli)}, "sync"]; await import(${JSON.stringify(cli)});`,
					],
					{ env, stdout: "pipe", stderr: "pipe" },
				);
				const timer = setTimeout(() => child.kill(), 10_000);
				const [stdout, stderr, exit] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				clearTimeout(timer);
				if (typeof requiresAuth === "string") {
					expect(exit).not.toBe(0);
					expect(stderr).toContain("SIGNET_HOOK_COMMAND must be");
					expect(readFileSync(settings, "utf-8")).toBe(before);
					continue;
				}
				expect({ exit, stderr }).toMatchObject({ exit: 0 });
				expect(stdout).toContain("hooks re-registered for codex");
			}
			if (typeof requiresAuth === "string") return;
			const claude = readFileSync(settings, "utf-8");
			expect(claude).toContain("/host/bin/signet hook session-start");
			expect(claude).toContain("rtk hook claude");
			const codex = readFileSync(join(home, ".codex", "hooks.json"), "utf-8");
			expect(codex).toContain("/host/bin/signet hook session-start");
			expect(codex).not.toContain("/app/bin/signet");
			expect(codex).not.toContain("stale-fixture");
			expect(codex.includes("sig_sk_sync_fixture_not_a_secret")).toBe(false);
			const gemini = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf-8"));
			expect(gemini.mcpServers.signet).toEqual({
				command: "/host/bin/signet",
				args: ["connector", "mcp", "gemini"],
			});
			expect(gemini.mcpServers.other).toEqual({ command: "other-mcp" });
		} finally {
			server.stop(true);
			rmSync(root, { recursive: true, force: true });
		}
	},
);
