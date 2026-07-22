import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser/lib/esm/main.js";
import { OpenCodeConnector } from "./src/index.js";

const origHome = process.env.HOME;
const origDaemonUrl = process.env.SIGNET_DAEMON_URL;
const origApiKey = process.env.SIGNET_API_KEY;
const origToken = process.env.SIGNET_TOKEN;
const origAgentId = process.env.SIGNET_AGENT_ID;
let tmpRoot = "";

function writeIdentity(dir: string): void {
	for (const file of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
		writeFileSync(join(dir, file), `# ${file}\n`, "utf-8");
	}
}

interface TestMcpEntry {
	readonly type?: string;
	readonly command?: string[];
	readonly url?: string;
	readonly headers?: Record<string, string>;
	readonly oauth?: boolean;
	readonly enabled?: boolean;
}

interface TestConfig {
	readonly agent: Record<string, unknown>;
	readonly mcp: Record<string, TestMcpEntry>;
	readonly plugin: unknown[];
	readonly provider?: unknown;
}

function readConfig(path: string): TestConfig {
	return parse(readFileSync(path, "utf-8"), undefined, { allowTrailingComma: true }) as TestConfig;
}

class TestableConnector extends OpenCodeConnector {
	private readonly ocPath: string;
	constructor(ocPath: string) {
		super();
		this.ocPath = ocPath;
	}
	protected override getOpenCodePath(): string {
		return this.ocPath;
	}
}

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-opencode-test-"));
	process.env.HOME = tmpRoot;
	Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
	Reflect.deleteProperty(process.env, "SIGNET_API_KEY");
	Reflect.deleteProperty(process.env, "SIGNET_TOKEN");
	Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
	mkdirSync(join(tmpRoot, ".config", "opencode"), { recursive: true });
});

afterEach(() => {
	if (origHome !== undefined) process.env.HOME = origHome;
	else Reflect.deleteProperty(process.env, "HOME");
	for (const [key, value] of Object.entries({
		SIGNET_DAEMON_URL: origDaemonUrl,
		SIGNET_API_KEY: origApiKey,
		SIGNET_TOKEN: origToken,
		SIGNET_AGENT_ID: origAgentId,
	})) {
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = value;
	}
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("OpenCodeConnector.install — legacy SIGNET block migration", () => {
	it("strips legacy block from AGENTS.md and reports path in filesWritten", async () => {
		writeIdentity(tmpRoot);
		const agentsPath = join(tmpRoot, "AGENTS.md");
		writeFileSync(agentsPath, "before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n", "utf-8");
		const result = await new OpenCodeConnector().install(tmpRoot);
		expect(readFileSync(agentsPath, "utf-8")).toBe("before\nafter\n");
		expect(result.filesWritten).toContain(agentsPath);
	});

	it("leaves AGENTS.md untouched when no legacy block present", async () => {
		writeIdentity(tmpRoot);
		const agentsPath = join(tmpRoot, "AGENTS.md");
		const result = await new OpenCodeConnector().install(tmpRoot);
		expect(readFileSync(agentsPath, "utf-8")).toBe("# AGENTS.md\n");
		expect(result.filesWritten).not.toContain(agentsPath);
	});

	it("does not strip AGENTS.md when identity check fails", async () => {
		const agentsPath = join(tmpRoot, "AGENTS.md");
		writeFileSync(agentsPath, "before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n", "utf-8");
		const result = await new OpenCodeConnector().install(tmpRoot);
		expect(result.success).toBe(false);
		expect(readFileSync(agentsPath, "utf-8")).toContain("<!-- SIGNET:START -->");
		expect(result.filesWritten).toHaveLength(0);
	});
});

// ============================================================================
// Pipeline agent registration
// ============================================================================

describe("OpenCodeConnector — pipeline agent registration", () => {
	const EXPECTED_AGENT = {
		prompt:
			"You are a structured data extraction system. Return ONLY valid JSON matching the requested schema. No explanations, no markdown, no code fences.",
		permission: { "*": "deny" },
		hidden: true,
		steps: 1,
		mode: "all",
	};

	function ocPath(): string {
		return join(tmpRoot, ".config", "opencode");
	}

	it("install registers signet-pipeline agent in existing opencode.json", async () => {
		writeIdentity(tmpRoot);
		const configPath = join(ocPath(), "opencode.json");
		writeFileSync(configPath, JSON.stringify({ provider: {} }), "utf-8");

		await new TestableConnector(ocPath()).install(tmpRoot);

		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.agent).toBeDefined();
		expect(config.agent["signet-pipeline"]).toEqual(EXPECTED_AGENT);
	});

	it("install preserves existing custom agents", async () => {
		writeIdentity(tmpRoot);
		const configPath = join(ocPath(), "opencode.json");
		const existing = {
			provider: {},
			agent: {
				"my-custom": { prompt: "custom", hidden: false },
			},
		};
		writeFileSync(configPath, JSON.stringify(existing), "utf-8");

		await new TestableConnector(ocPath()).install(tmpRoot);

		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.agent["my-custom"]).toEqual({ prompt: "custom", hidden: false });
		expect(config.agent["signet-pipeline"]).toEqual(EXPECTED_AGENT);
	});

	it("install is idempotent — does not duplicate agent on repeated installs", async () => {
		writeIdentity(tmpRoot);
		const configPath = join(ocPath(), "opencode.json");
		writeFileSync(configPath, JSON.stringify({ provider: {} }), "utf-8");

		const connector = new TestableConnector(ocPath());
		await connector.install(tmpRoot);
		await connector.install(tmpRoot);

		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.agent["signet-pipeline"]).toEqual(EXPECTED_AGENT);
		expect(Object.keys(config.agent).filter((k) => k === "signet-pipeline")).toHaveLength(1);
	});

	it("install overwrites stale signet-pipeline agent config", async () => {
		writeIdentity(tmpRoot);
		const configPath = join(ocPath(), "opencode.json");
		const stale = {
			provider: {},
			agent: {
				"signet-pipeline": { prompt: "old prompt", steps: 5 },
			},
		};
		writeFileSync(configPath, JSON.stringify(stale), "utf-8");

		await new TestableConnector(ocPath()).install(tmpRoot);

		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.agent["signet-pipeline"]).toEqual(EXPECTED_AGENT);
	});

	it("uninstall removes signet-pipeline agent from config", async () => {
		writeIdentity(tmpRoot);
		const configPath = join(ocPath(), "opencode.json");
		const withAgent = {
			provider: {},
			agent: {
				"signet-pipeline": EXPECTED_AGENT,
				"my-custom": { prompt: "keep me" },
			},
		};
		writeFileSync(configPath, JSON.stringify(withAgent), "utf-8");

		await new TestableConnector(ocPath()).install(tmpRoot);
		await new TestableConnector(ocPath()).uninstall();

		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.agent["signet-pipeline"]).toBeUndefined();
		expect(config.agent["my-custom"]).toEqual({ prompt: "keep me" });
	});

	it("uninstall removes empty agent section", async () => {
		writeIdentity(tmpRoot);
		const configPath = join(ocPath(), "opencode.json");
		const withAgent = {
			provider: {},
			agent: { "signet-pipeline": EXPECTED_AGENT },
		};
		writeFileSync(configPath, JSON.stringify(withAgent), "utf-8");

		await new TestableConnector(ocPath()).install(tmpRoot);
		await new TestableConnector(ocPath()).uninstall();

		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.agent).toBeUndefined();
	});

	it("continues uninstall cleanup when another config candidate is malformed", async () => {
		const jsonPath = join(ocPath(), "opencode.json");
		const jsoncPath = join(ocPath(), "opencode.jsonc");
		writeFileSync(
			jsonPath,
			JSON.stringify({
				plugin: ["./plugins/signet.mjs", "./keep.mjs"],
				mcp: { signet: { type: "remote" }, keep: { type: "remote" } },
				agent: { "signet-pipeline": EXPECTED_AGENT, keep: { prompt: "keep" } },
			}),
			"utf-8",
		);
		writeFileSync(jsoncPath, "{ invalid", "utf-8");
		mkdirSync(join(ocPath(), "plugins"), { recursive: true });
		writeFileSync(join(ocPath(), "plugins", "signet.mjs"), "plugin", "utf-8");
		writeFileSync(join(ocPath(), "plugins", ".signet-api-key"), "secret", "utf-8");
		const warn = spyOn(console, "warn").mockImplementation(() => {});

		try {
			await new TestableConnector(ocPath()).uninstall();
		} finally {
			warn.mockRestore();
		}

		const config = readConfig(jsonPath);
		expect(config.plugin).toEqual(["./keep.mjs"]);
		expect(config.mcp).toEqual({ keep: { type: "remote" } });
		expect(config.agent).toEqual({ keep: { prompt: "keep" } });
		expect(readFileSync(jsoncPath, "utf-8")).toBe("{ invalid");
		expect(existsSync(join(ocPath(), "plugins", "signet.mjs"))).toBe(false);
		expect(existsSync(join(ocPath(), "plugins", ".signet-api-key"))).toBe(false);
	});

	it("preserves JSONC comments while updating unrelated configuration", async () => {
		writeIdentity(tmpRoot);
		const configPath = join(ocPath(), "opencode.jsonc");
		writeFileSync(configPath, '{\n  // keep this provider comment\n  "provider": {},\n}\n', "utf-8");

		await new TestableConnector(ocPath()).install(tmpRoot);

		const raw = readFileSync(configPath, "utf-8");
		const config = readConfig(configPath);
		expect(raw).toContain("// keep this provider comment");
		expect(raw).toContain('"provider": {}');
		expect(config.agent["signet-pipeline"]).toEqual(EXPECTED_AGENT);
	});

	it("installs remotely without identity and patches the highest-precedence config", async () => {
		process.env.SIGNET_DAEMON_URL = "https://daemon.example.test:3850/";
		process.env.SIGNET_API_KEY = "sig_sk_opencode_test_secret";
		process.env.SIGNET_AGENT_ID = "opencode-remote";
		const jsonPath = join(ocPath(), "opencode.json");
		const jsoncPath = join(ocPath(), "opencode.jsonc");
		writeFileSync(
			jsonPath,
			JSON.stringify({
				plugin: ["./lower-precedence.mjs"],
				mcp: { signet: { type: "local", command: ["signet-mcp"], enabled: true } },
			}),
			"utf-8",
		);
		writeFileSync(
			jsoncPath,
			'{\n  // highest-precedence user config\n  "plugin": ["./existing.mjs", ["package-plugin", { "option": true }]],\n  "provider": { "custom": {} },\n}\n',
			"utf-8",
		);

		const connector = new TestableConnector(ocPath());
		const result = await connector.install(join(tmpRoot, "missing-workspace"));

		expect(result.success).toBe(true);
		expect(connector.getConfigPath()).toBe(jsoncPath);
		const raw = readFileSync(jsoncPath, "utf-8");
		const config = readConfig(jsoncPath);
		expect(raw).toContain("// highest-precedence user config");
		expect(config.provider).toEqual({ custom: {} });
		expect(config.plugin).toEqual(["./existing.mjs", ["package-plugin", { option: true }], "./plugins/signet.mjs"]);
		expect(config.mcp.signet).toEqual({
			type: "remote",
			url: "https://daemon.example.test:3850/mcp",
			headers: { Authorization: "Bearer {file:./plugins/.signet-api-key}" },
			oauth: false,
			enabled: true,
		});
		expect(readConfig(jsonPath).mcp).toBeUndefined();
		expect(config.agent["signet-pipeline"]).toEqual(EXPECTED_AGENT);
		expect(existsSync(join(ocPath(), "AGENTS.md"))).toBe(false);

		const plugin = readFileSync(join(ocPath(), "plugins", "signet.mjs"), "utf-8");
		expect(plugin).toContain('process.env["SIGNET_DAEMON_URL"] = "https://daemon.example.test:3850";');
		expect(plugin).toContain('__signetReadFileSync');
		expect(plugin).not.toContain("sig_sk_opencode_test_secret");
		expect(plugin).toContain('process.env["SIGNET_AGENT_ID"] = "opencode-remote";');
		const apiKeyFile = join(ocPath(), "plugins", ".signet-api-key");
		expect(readFileSync(apiKeyFile, "utf-8")).toBe("sig_sk_opencode_test_secret\n");
		if (process.platform !== "win32") expect(statSync(apiKeyFile).mode & 0o777).toBe(0o600);
	});

	it("rejects invalid remote daemon URLs before writing connector files", async () => {
		process.env.SIGNET_DAEMON_URL = "https://daemon.example.test:3850/not-an-origin";
		const connector = new TestableConnector(ocPath());

		await expect(connector.install(join(tmpRoot, "missing-workspace"))).rejects.toThrow(
			"SIGNET_DAEMON_URL must point at the daemon origin",
		);
		expect(existsSync(join(ocPath(), "plugins", "signet.mjs"))).toBe(false);
	});

	it("rejects malformed lower-precedence config before writing any artifacts", async () => {
		process.env.SIGNET_DAEMON_URL = "https://daemon.example.test:3850";
		writeIdentity(tmpRoot);
		const agentsPath = join(tmpRoot, "AGENTS.md");
		const agents = "before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n";
		writeFileSync(agentsPath, agents, "utf-8");
		const jsoncPath = join(ocPath(), "opencode.jsonc");
		const legacyPath = join(ocPath(), "config.json");
		writeFileSync(jsoncPath, '{ "provider": {} }\n', "utf-8");
		writeFileSync(legacyPath, "{ invalid", "utf-8");
		const connector = new TestableConnector(ocPath());

		await expect(connector.install(tmpRoot)).rejects.toThrow(
			`Cannot update OpenCode config ${legacyPath}`,
		);
		expect(readFileSync(jsoncPath, "utf-8")).toBe('{ "provider": {} }\n');
		expect(readFileSync(legacyPath, "utf-8")).toBe("{ invalid");
		expect(readFileSync(agentsPath, "utf-8")).toBe(agents);
		expect(existsSync(join(ocPath(), "plugins"))).toBe(false);
	});

	it("install creates opencode.jsonc when no config file exists", async () => {
		writeIdentity(tmpRoot);
		const freshOcPath = join(tmpRoot, ".config", "opencode-fresh");
		mkdirSync(freshOcPath, { recursive: true });

		await new TestableConnector(freshOcPath).install(tmpRoot);

		const configPath = join(freshOcPath, "opencode.jsonc");
		const config = readConfig(configPath);
		// ensureConfigFile creates the empty file before registerPlugin,
		// registerMcpServer, and registerPipelineAgent — all three entries
		// must be present to prove the ordering fix works.
		expect(config.agent["signet-pipeline"]).toEqual(EXPECTED_AGENT);
		expect(config.mcp.signet.type).toBe("local");
		expect(config.mcp.signet.command).toEqual(["signet-mcp"]);
		expect(config.mcp.signet.enabled).toBe(true);
		expect(config.plugin).toEqual(["./plugins/signet.mjs"]);
	});
});
