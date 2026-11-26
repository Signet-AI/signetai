import "../../../tests/support/connector-safety.js";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as realOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, afterAll } from "bun:test";

mock.module("node:os", () => ({ ...realOs, homedir: () => process.env.HOME ?? realOs.homedir() }));
const { GeminiConnector } = await import("./src/index");
afterAll(() => {
	mock.module("node:os", () => realOs);
});

const saved = { HOME: process.env.HOME, SIGNET_HOOK_COMMAND: process.env.SIGNET_HOOK_COMMAND };
const execPath = process.execPath;
let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "signet-gemini-"));
	process.env.HOME = root;
	Reflect.deleteProperty(process.env, "SIGNET_HOOK_COMMAND");
	mkdirSync(join(root, ".gemini"));
	for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) writeFileSync(join(root, name), "fixture");
});

afterEach(() => {
	process.execPath = execPath;
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		if (value !== undefined) process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

test.each([false, true])("retains the host MCP launcher and other servers; override=%s", async (override) => {
	const path = join(root, ".gemini", "settings.json");
	const host = {
		command: "/host/My Tools/signet",
		args: ["--fixture"],
		env: { SIGNET_MCP_STDIO_WORKER: "1", CUSTOM: "keep" },
	};
	const other = { command: "other-mcp", args: [] };
	writeFileSync(path, JSON.stringify({ mcpServers: { signet: host, other }, theme: "dark" }));
	process.execPath = "/app/bin/signet";
	if (override) process.env.SIGNET_HOOK_COMMAND = '["/host/Other Tools/signet","--host"]';
	const connector = new GeminiConnector();
	expect(connector.getConfigPath()).toBe(path);
	expect((await connector.install(root)).success).toBe(true);
	expect((await connector.install(root)).success).toBe(true);
	const config = JSON.parse(readFileSync(path, "utf-8"));
	expect(config.theme).toBe("dark");
	expect(config.mcpServers.other).toEqual(other);
	expect(config.mcpServers.signet).toEqual(
		override
			? { command: "/host/Other Tools/signet", args: ["--host", "connector", "mcp", "gemini"] }
			: { command: host.command, args: ["connector", "mcp", "gemini"], env: { CUSTOM: "keep" } },
	);
	await connector.uninstall();
	expect(JSON.parse(readFileSync(path, "utf-8")).mcpServers).toEqual({ other });
});
