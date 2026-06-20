import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeConnector } from "./src/index.js";

const origHome = process.env.HOME;
const origForgeConfig = process.env.FORGE_CONFIG;
const origDaemonUrl = process.env.SIGNET_DAEMON_URL;
const origApiKey = process.env.SIGNET_API_KEY;
const origToken = process.env.SIGNET_TOKEN;
const origAgentId = process.env.SIGNET_AGENT_ID;
let tmpRoot = "";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function writeIdentity(dir: string): void {
	mkdirSync(dir, { recursive: true });
	for (const file of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
		writeFileSync(join(dir, file), `# ${file}\n`, "utf-8");
	}
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-forge-test-"));
	process.env.HOME = tmpRoot;
	delete process.env.FORGE_CONFIG;
	delete process.env.SIGNET_DAEMON_URL;
	delete process.env.SIGNET_API_KEY;
	delete process.env.SIGNET_TOKEN;
	delete process.env.SIGNET_AGENT_ID;
});

afterEach(() => {
	restoreEnv("HOME", origHome);
	restoreEnv("FORGE_CONFIG", origForgeConfig);
	restoreEnv("SIGNET_DAEMON_URL", origDaemonUrl);
	restoreEnv("SIGNET_API_KEY", origApiKey);
	restoreEnv("SIGNET_TOKEN", origToken);
	restoreEnv("SIGNET_AGENT_ID", origAgentId);
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ForgeConnector.install", () => {
	it("writes ForgeCode user MCP config and managed AGENTS.md", async () => {
		writeIdentity(tmpRoot);

		const result = await new ForgeConnector().install(tmpRoot);

		expect(result.success).toBe(true);
		const forgeHome = join(tmpRoot, ".forge");
		const mcpPath = join(forgeHome, ".mcp.json");
		const agentsPath = join(forgeHome, "AGENTS.md");
		const config = readJson(mcpPath);
		expect(config.mcpServers).toEqual({
			signet: {
				command: "signet-mcp",
				env: { SIGNET_PATH: tmpRoot },
			},
		});
		expect(readFileSync(agentsPath, "utf-8")).toContain("Managed by Signet (@signet/connector-forge)");
		expect(readFileSync(agentsPath, "utf-8")).toContain("# AGENTS.md");
		expect(result.configsPatched).toContain(mcpPath);
		expect(result.filesWritten).toContain(agentsPath);
	});

	it("preserves existing MCP servers while upserting signet", async () => {
		writeIdentity(tmpRoot);
		const forgeHome = join(tmpRoot, ".forge");
		mkdirSync(forgeHome, { recursive: true });
		const mcpPath = join(forgeHome, ".mcp.json");
		writeFileSync(
			mcpPath,
			JSON.stringify({ mcpServers: { existing: { command: "example", args: ["serve"] } }, other: true }),
			"utf-8",
		);

		await new ForgeConnector().install(tmpRoot);

		const config = readJson(mcpPath);
		expect(config.other).toBe(true);
		expect(config.mcpServers).toMatchObject({
			existing: { command: "example", args: ["serve"] },
			signet: { command: "signet-mcp", env: { SIGNET_PATH: tmpRoot } },
		});
	});

	it("uses FORGE_CONFIG as the ForgeCode config home", async () => {
		writeIdentity(tmpRoot);
		const forgeHome = join(tmpRoot, "custom-forge-home");
		process.env.FORGE_CONFIG = forgeHome;

		await new ForgeConnector().install(tmpRoot);

		expect(existsSync(join(forgeHome, ".mcp.json"))).toBe(true);
		expect(existsSync(join(forgeHome, "AGENTS.md"))).toBe(true);
	});

	it("prefers legacy ~/forge when it exists", async () => {
		writeIdentity(tmpRoot);
		const legacyHome = join(tmpRoot, "forge");
		mkdirSync(legacyHome, { recursive: true });

		await new ForgeConnector().install(tmpRoot);

		expect(existsSync(join(legacyHome, ".mcp.json"))).toBe(true);
		expect(existsSync(join(tmpRoot, ".forge", ".mcp.json"))).toBe(false);
	});

	it("writes remote HTTP MCP config when SIGNET_DAEMON_URL is set", async () => {
		writeIdentity(tmpRoot);
		process.env.SIGNET_DAEMON_URL = "https://daemon.example.test:3850";
		process.env.SIGNET_API_KEY = "sig_sk_forge_test_secret";
		process.env.SIGNET_AGENT_ID = "forge-remote";

		await new ForgeConnector().install(tmpRoot);

		const config = readJson(join(tmpRoot, ".forge", ".mcp.json"));
		expect(config.mcpServers).toEqual({
			signet: {
				url: "https://daemon.example.test:3850/mcp",
				headers: { Authorization: "Bearer sig_sk_forge_test_secret" },
			},
		});
	});

	it("strips legacy Signet block from source AGENTS.md", async () => {
		writeIdentity(tmpRoot);
		const agentsPath = join(tmpRoot, "AGENTS.md");
		writeFileSync(agentsPath, "before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n", "utf-8");

		const result = await new ForgeConnector().install(tmpRoot);

		expect(readFileSync(agentsPath, "utf-8")).toBe("before\nafter\n");
		expect(result.filesWritten).toContain(agentsPath);
	});

	it("does not mutate files when identity validation fails", async () => {
		const agentsPath = join(tmpRoot, "AGENTS.md");
		writeFileSync(agentsPath, "before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n", "utf-8");

		const result = await new ForgeConnector().install(tmpRoot);

		expect(result.success).toBe(false);
		expect(readFileSync(agentsPath, "utf-8")).toContain("<!-- SIGNET:START -->");
		expect(existsSync(join(tmpRoot, ".forge", ".mcp.json"))).toBe(false);
	});

	it("symlinks Signet skills into ForgeCode skills directory", async () => {
		writeIdentity(tmpRoot);
		const skillsSource = join(tmpRoot, "skills");
		mkdirSync(join(skillsSource, "recall"), { recursive: true });

		await new ForgeConnector().install(tmpRoot);

		const skillLink = join(tmpRoot, ".forge", "skills", "recall");
		expect(lstatSync(skillLink).isSymbolicLink()).toBe(true);
	});
});

describe("ForgeConnector.uninstall", () => {
	it("removes Signet MCP server, managed AGENTS.md, and Signet skill symlinks", async () => {
		writeIdentity(tmpRoot);
		const skillsSource = join(tmpRoot, "skills");
		mkdirSync(join(skillsSource, "recall"), { recursive: true });
		const connector = new ForgeConnector();
		await connector.install(tmpRoot);

		const result = await connector.uninstall();

		const forgeHome = join(tmpRoot, ".forge");
		expect(result.filesRemoved).toContain(join(forgeHome, "AGENTS.md"));
		expect(existsSync(join(forgeHome, "AGENTS.md"))).toBe(false);
		expect(existsSync(join(forgeHome, ".mcp.json"))).toBe(false);
		expect(existsSync(join(forgeHome, "skills"))).toBe(false);
	});

	it("preserves non-Signet MCP servers on uninstall", async () => {
		writeIdentity(tmpRoot);
		const forgeHome = join(tmpRoot, ".forge");
		mkdirSync(forgeHome, { recursive: true });
		const mcpPath = join(forgeHome, ".mcp.json");
		writeFileSync(mcpPath, JSON.stringify({ mcpServers: { existing: { command: "example" } } }), "utf-8");
		const connector = new ForgeConnector();
		await connector.install(tmpRoot);

		await connector.uninstall();

		const config = readJson(mcpPath);
		expect(config.mcpServers).toEqual({ existing: { command: "example" } });
	});
});
