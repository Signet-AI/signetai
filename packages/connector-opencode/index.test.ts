import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeConnector } from "./src/index.js";

const origHome = process.env.HOME;
let tmpRoot = "";

function writeIdentity(dir: string): void {
	for (const file of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
		writeFileSync(join(dir, file), `# ${file}\n`, "utf-8");
	}
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
	mkdirSync(join(tmpRoot, ".config", "opencode"), { recursive: true });
});

afterEach(() => {
	if (origHome !== undefined) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("OpenCodeConnector.install — legacy SIGNET block migration", () => {
	it("strips legacy block from AGENTS.md and reports path in filesWritten", async () => {
		writeIdentity(tmpRoot);
		const agentsPath = join(tmpRoot, "AGENTS.md");
		writeFileSync(
			agentsPath,
			`before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n`,
			"utf-8",
		);
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
		writeFileSync(
			agentsPath,
			`before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n`,
			"utf-8",
		);
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

	it("install works with JSONC config files", async () => {
		writeIdentity(tmpRoot);
		const configPath = join(ocPath(), "opencode.jsonc");
		writeFileSync(configPath, '{\n  // comment\n  "provider": {}\n}\n', "utf-8");

		await new TestableConnector(ocPath()).install(tmpRoot);

		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.agent["signet-pipeline"]).toEqual(EXPECTED_AGENT);
	});

	it("install creates opencode.json when no config file exists", async () => {
		writeIdentity(tmpRoot);
		const freshOcPath = join(tmpRoot, ".config", "opencode-fresh");
		mkdirSync(freshOcPath, { recursive: true });

		await new TestableConnector(freshOcPath).install(tmpRoot);

		const configPath = join(freshOcPath, "opencode.json");
		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		// ensureConfigFile creates the empty file before registerPlugin,
		// registerMcpServer, and registerPipelineAgent — all three entries
		// must be present to prove the ordering fix works.
		expect(config.agent["signet-pipeline"]).toEqual(EXPECTED_AGENT);
		expect(config.mcp).toBeDefined();
		expect(config.mcp.signet).toBeDefined();
		expect(config.mcp.signet.type).toBe("local");
		expect(config.mcp.signet.enabled).toBe(true);
		expect(Array.isArray(config.plugin)).toBe(true);
		expect(config.plugin.length).toBeGreaterThan(0);
	});
});
