import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermesAgentConnector } from "./src/index.js";

const originalEnv = {
	HOME: process.env.HOME,
	HERMES_REPO: process.env.HERMES_REPO,
	HERMES_HOME: process.env.HERMES_HOME,
	SIGNET_AGENT_ID: process.env.SIGNET_AGENT_ID,
	SIGNET_AGENT_WORKSPACE: process.env.SIGNET_AGENT_WORKSPACE,
	SIGNET_DAEMON_URL: process.env.SIGNET_DAEMON_URL,
	SIGNET_TOKEN: process.env.SIGNET_TOKEN,
	SIGNET_AGENT_READ_POLICY: process.env.SIGNET_AGENT_READ_POLICY,
	SIGNET_AGENT_MEMORY_POLICY: process.env.SIGNET_AGENT_MEMORY_POLICY,
	SIGNET_AGENT_POLICY_GROUP: process.env.SIGNET_AGENT_POLICY_GROUP,
	SIGNET_SKIP_AGENT_REGISTER: process.env.SIGNET_SKIP_AGENT_REGISTER,
};

let tmpRoot = "";

function restoreEnv(name: keyof typeof originalEnv): void {
	const value = originalEnv[name];
	if (typeof value === "string") {
		process.env[name] = value;
		return;
	}
	delete process.env[name];
}

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-hermes-connector-"));
	process.env.HOME = tmpRoot;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.HERMES_REPO;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.HERMES_HOME;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.SIGNET_AGENT_ID;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.SIGNET_AGENT_WORKSPACE;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.SIGNET_DAEMON_URL;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.SIGNET_TOKEN;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.SIGNET_AGENT_READ_POLICY;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.SIGNET_AGENT_MEMORY_POLICY;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.SIGNET_AGENT_POLICY_GROUP;
	process.env.SIGNET_SKIP_AGENT_REGISTER = "1";
});

afterEach(() => {
	restoreEnv("HOME");
	restoreEnv("HERMES_REPO");
	restoreEnv("HERMES_HOME");
	restoreEnv("SIGNET_AGENT_ID");
	restoreEnv("SIGNET_AGENT_WORKSPACE");
	restoreEnv("SIGNET_DAEMON_URL");
	restoreEnv("SIGNET_TOKEN");
	restoreEnv("SIGNET_AGENT_READ_POLICY");
	restoreEnv("SIGNET_AGENT_MEMORY_POLICY");
	restoreEnv("SIGNET_AGENT_POLICY_GROUP");
	restoreEnv("SIGNET_SKIP_AGENT_REGISTER");
	if (tmpRoot) {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

describe("HermesAgentConnector.isInstalled()", () => {
	it("returns false when plugin __init__.py is absent", () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_REPO = hermesRepo;

		expect(new HermesAgentConnector().isInstalled()).toBe(false);
	});

	it("returns true only when signet/__init__.py is present in plugins/memory", () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		const pluginDir = join(hermesRepo, "plugins", "memory", "signet");
		mkdirSync(pluginDir, { recursive: true });
		writeFileSync(join(pluginDir, "__init__.py"), "# signet plugin\n");
		process.env.HERMES_REPO = hermesRepo;

		expect(new HermesAgentConnector().isInstalled()).toBe(true);
	});

	it("returns false when HERMES_REPO is not set and no known install paths exist", () => {
		// HOME is a fresh tmp dir with no hermes paths
		expect(new HermesAgentConnector().isInstalled()).toBe(false);
	});
});

describe("HermesAgentConnector.install()", () => {
	it("copies plugin files into plugins/memory/signet/ when HERMES_REPO is set", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_REPO = hermesRepo;
		process.env.HERMES_HOME = join(tmpRoot, ".hermes");

		const connector = new HermesAgentConnector();
		const result = await connector.install(tmpRoot);

		const pluginDir = join(hermesRepo, "plugins", "memory", "signet");
		expect(result.success).toBe(true);
		expect(existsSync(join(pluginDir, "__init__.py"))).toBe(true);
		expect(existsSync(join(pluginDir, "client.py"))).toBe(true);
		expect(existsSync(join(pluginDir, "plugin.yaml"))).toBe(true);
		expect(connector.isInstalled()).toBe(true);
	});

	it("copies plugin files into ~/.hermes when HERMES_REPO is unset", async () => {
		const hermesRepo = join(tmpRoot, ".hermes");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });

		const connector = new HermesAgentConnector();
		const result = await connector.install(tmpRoot);

		const pluginDir = join(hermesRepo, "plugins", "memory", "signet");
		expect(result.success).toBe(true);
		expect(result.warnings.some((w) => w.includes("Hermes Agent install not found"))).toBe(false);
		expect(existsSync(join(pluginDir, "__init__.py"))).toBe(true);
		expect(existsSync(join(pluginDir, "client.py"))).toBe(true);
		expect(connector.isInstalled()).toBe(true);
	});

	it("copies plugin files into HERMES_HOME when HERMES_REPO is unset", async () => {
		const hermesHome = join(tmpRoot, "custom-hermes-home");
		mkdirSync(join(hermesHome, "plugins", "memory"), { recursive: true });
		process.env.HERMES_HOME = hermesHome;

		const connector = new HermesAgentConnector();
		const result = await connector.install(tmpRoot);

		const pluginDir = join(hermesHome, "plugins", "memory", "signet");
		expect(result.success).toBe(true);
		expect(result.warnings.some((w) => w.includes("Hermes Agent install not found"))).toBe(false);
		expect(existsSync(join(pluginDir, "__init__.py"))).toBe(true);
		expect(connector.isInstalled()).toBe(true);
	});

	it("warns (does not throw) when HERMES_REPO is unset", async () => {
		process.env.HERMES_HOME = join(tmpRoot, ".hermes");

		const result = await new HermesAgentConnector().install(tmpRoot);

		expect(result.success).toBe(true);
		expect(result.warnings.some((w) => w.includes("Hermes Agent install not found"))).toBe(true);
	});

	it("writes daemon env vars into ~/.hermes/.env when SIGNET_DAEMON_URL is set", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		const hermesHome = join(tmpRoot, ".hermes");
		process.env.HERMES_REPO = hermesRepo;
		process.env.HERMES_HOME = hermesHome;
		process.env.SIGNET_DAEMON_URL = "http://127.0.0.1:9999";

		const result = await new HermesAgentConnector().install(tmpRoot);

		const envPath = join(hermesHome, ".env");
		expect(result.configsPatched).toContain(envPath);
		expect(existsSync(envPath)).toBe(true);
		const envContent = await Bun.file(envPath).text();
		expect(envContent).toContain("SIGNET_DAEMON_URL=http://127.0.0.1:9999");
	});

	it("derives SIGNET_AGENT_WORKSPACE for named agents", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		mkdirSync(join(tmpRoot, "agents", "dot"), { recursive: true });
		const hermesHome = join(tmpRoot, ".hermes");
		process.env.HERMES_REPO = hermesRepo;
		process.env.HERMES_HOME = hermesHome;
		process.env.SIGNET_AGENT_ID = "dot";

		const result = await new HermesAgentConnector().install(tmpRoot);

		const envContent = await Bun.file(join(hermesHome, ".env")).text();
		expect(result.configsPatched).toContain(join(hermesHome, ".env"));
		expect(envContent).toContain("SIGNET_AGENT_ID=dot");
		expect(envContent).toContain(`SIGNET_AGENT_WORKSPACE=${join(tmpRoot, "agents", "dot")}`);
	});

	it("uses SIGNET_TOKEN and configured read policy when registering named agents", async () => {
		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			calls.push({ url: String(url), init });
			if (String(url).endsWith("/api/agents/dot")) {
				return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
			}
			return new Response(JSON.stringify({ id: "dot" }), { status: 201 });
		}) as typeof fetch;

		try {
			const hermesRepo = join(tmpRoot, "hermes-agent");
			mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
			const hermesHome = join(tmpRoot, ".hermes");
			process.env.HERMES_REPO = hermesRepo;
			process.env.HERMES_HOME = hermesHome;
			process.env.SIGNET_AGENT_ID = "dot";
			process.env.SIGNET_TOKEN = " test-token \n";
			process.env.SIGNET_AGENT_READ_POLICY = "isolated";
			// biome-ignore lint/performance/noDelete: this test exercises registration
			delete process.env.SIGNET_SKIP_AGENT_REGISTER;

			const result = await new HermesAgentConnector().install(tmpRoot);

			expect(result.success).toBe(true);
			expect(calls).toHaveLength(2);
			for (const call of calls) {
				expect(new Headers(call.init?.headers).get("Authorization")).toBe("Bearer test-token");
			}
			expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
				name: "dot",
				read_policy: "isolated",
				policy_group: null,
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not try to create a named agent when the existence check fails with non-404", async () => {
		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			calls.push({ url: String(url), init });
			return new Response("unauthorized", { status: 401 });
		}) as typeof fetch;

		try {
			const hermesRepo = join(tmpRoot, "hermes-agent");
			mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
			const hermesHome = join(tmpRoot, ".hermes");
			process.env.HERMES_REPO = hermesRepo;
			process.env.HERMES_HOME = hermesHome;
			process.env.SIGNET_AGENT_ID = "dot";
			// biome-ignore lint/performance/noDelete: this test exercises registration
			delete process.env.SIGNET_SKIP_AGENT_REGISTER;

			const result = await new HermesAgentConnector().install(tmpRoot);

			expect(result.success).toBe(true);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toContain("/api/agents/dot");
			expect(result.warnings.some((w) => w.includes("HTTP 401"))).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("Hermes Agent bundled plugin", () => {
	it("advertises canonical Signet memory tool names", () => {
		const plugin = readFileSync(join(import.meta.dir, "hermes-plugin", "__init__.py"), "utf-8");

		expect(plugin).toContain('"name": "memory_search"');
		expect(plugin).toContain('"name": "memory_store"');
		expect(plugin).toContain('"name": "memory_get"');
		expect(plugin).toContain('"name": "memory_list"');
		expect(plugin).not.toContain('"name": "signet_search"');
		expect(plugin).toContain('if tool_name in ("memory_search", "recall", "signet_search")');
	});

	it("does not force agentId into explicit recall requests", () => {
		const client = readFileSync(join(import.meta.dir, "hermes-plugin", "client.py"), "utf-8");

		expect(client).toContain("if agent_scoped and self._agent_id:");
		expect(client).toContain('body["agentId"] = self._agent_id');
		expect(client).not.toContain('"agentId": self._agent_id,\\n        }\\n        if min_score');
	});

	it("lets explicit recall requests opt into agent scoping", () => {
		const plugin = readFileSync(join(import.meta.dir, "hermes-plugin", "__init__.py"), "utf-8");

		expect(plugin).toContain('"agent_scoped"');
		expect(plugin).toContain("scope recall to SIGNET_AGENT_ID");
		expect(plugin).toContain('agent_scoped=bool(search_args.get("agent_scoped", False))');
	});

	it("uses longer timeouts for recall paths", () => {
		const client = readFileSync(join(import.meta.dir, "hermes-plugin", "client.py"), "utf-8");

		expect(client).toContain("_RECALL_TIMEOUT_SECS = 30");
		expect(client).toContain("timeout=_LONG_TIMEOUT_SECS,");
		expect(client).toMatch(/def user_prompt_submit[\s\S]+timeout=_RECALL_TIMEOUT_SECS,/);
		expect(client).toContain('self._post("/api/memory/recall", body, timeout=_RECALL_TIMEOUT_SECS)');
	});

	it("treats malformed recall scores as zero during score_min filtering", () => {
		const client = readFileSync(join(import.meta.dir, "hermes-plugin", "client.py"), "utf-8");

		expect(client).toContain("def _safe_score(value: Any) -> float:");
		expect(client).toContain("except (TypeError, ValueError):");
		expect(client).toContain('if not isinstance(row, dict) or _safe_score(row.get("score")) >= score_min');
	});

	it("does not expose hard-delete force to Hermes memory_forget", () => {
		const plugin = readFileSync(join(import.meta.dir, "hermes-plugin", "__init__.py"), "utf-8");
		const client = readFileSync(join(import.meta.dir, "hermes-plugin", "client.py"), "utf-8");

		expect(plugin).toContain('"description": "Soft-delete a memory by ID."');
		expect(plugin).not.toContain('"force"');
		expect(plugin).not.toContain("force=bool");
		expect(client).toContain("def forget_memory(");
		expect(client).not.toContain("force: bool");
		expect(client).not.toContain('"force": "true"');
	});

	it("exposes the complete Signet memory_store schema", () => {
		const plugin = readFileSync(join(import.meta.dir, "hermes-plugin", "__init__.py"), "utf-8");
		const client = readFileSync(join(import.meta.dir, "hermes-plugin", "client.py"), "utf-8");

		expect(plugin).toContain('"hints"');
		expect(plugin).toContain('"transcript"');
		expect(plugin).toContain('"structured"');
		expect(plugin).toContain('"entityName"');
		expect(plugin).toContain('"attributes"');
		expect(plugin).toContain("Prospective recall hints");
		expect(plugin).toContain('hints=_string_list(store_args.get("hints"))');
		expect(plugin).toContain('transcript=str(store_args.get("transcript", "") or "")');
		expect(plugin).toContain("structured=structured");
		expect(client).toContain("hints: Optional[List[str]] = None");
		expect(client).toContain('body["hints"] = hints');
		expect(client).toContain('body["transcript"] = transcript');
		expect(client).toContain('body["structured"] = structured');
		expect(client).toContain("def _read_json_response");
		expect(client).toContain("if not body:");
		expect(client).toContain("TimeoutError, ValueError");
		expect(client).toContain('_safe_score(row.get("score"))');
		expect(client).toContain('"noHits": len(kept) == 0');
		expect(plugin).toContain('agent_id not in ("default", "hermes-agent")');
	});
});

describe("HermesAgentConnector.uninstall()", () => {
	it("removes the plugin directory and reports it in filesRemoved", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_REPO = hermesRepo;
		process.env.HERMES_HOME = join(tmpRoot, ".hermes");

		const connector = new HermesAgentConnector();
		await connector.install(tmpRoot);
		expect(connector.isInstalled()).toBe(true);

		const result = await connector.uninstall();
		const pluginDir = join(hermesRepo, "plugins", "memory", "signet");
		expect(result.filesRemoved).toContain(pluginDir);
		expect(connector.isInstalled()).toBe(false);
	});

	it("removes persisted Signet env vars including SIGNET_TOKEN", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		const envPath = join(hermesHome, ".env");
		writeFileSync(
			envPath,
			[
				"KEEP_ME=1",
				"SIGNET_DAEMON_URL=http://localhost:3850",
				"SIGNET_AGENT_ID=dot",
				"SIGNET_AGENT_WORKSPACE=/tmp/dot",
				"SIGNET_TOKEN=secret-token",
				"",
			].join("\n"),
		);
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().uninstall();

		expect(result.configsPatched).toContain(envPath);
		const envContent = readFileSync(envPath, "utf-8");
		expect(envContent).toContain("KEEP_ME=1");
		expect(envContent).not.toContain("SIGNET_DAEMON_URL");
		expect(envContent).not.toContain("SIGNET_AGENT_ID");
		expect(envContent).not.toContain("SIGNET_AGENT_WORKSPACE");
		expect(envContent).not.toContain("SIGNET_TOKEN");
	});
});

describe("HermesAgentConnector — AGENTS.md legacy block migration", () => {
	it("strips legacy SIGNET block from AGENTS.md and reports path in filesWritten", async () => {
		const agentsPath = join(tmpRoot, "AGENTS.md");
		writeFileSync(agentsPath, "before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n", "utf-8");

		const result = await new HermesAgentConnector().install(tmpRoot);
		const { readFileSync } = await import("node:fs");
		expect(readFileSync(agentsPath, "utf-8")).toBe("before\nafter\n");
		expect(result.filesWritten).toContain(agentsPath);
	});
});
