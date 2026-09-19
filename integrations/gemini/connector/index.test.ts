import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiConnector } from "./src/index.js";

const originalHome = process.env.HOME;
let root = "";

function identityFiles(path: string): void {
	mkdirSync(path, { recursive: true });
	for (const file of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) writeFileSync(join(path, file), `# ${file}\n`);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "signet-gemini-test-"));
	process.env.HOME = root;
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(root, { recursive: true, force: true });
});

describe("GeminiConnector", () => {
	it("writes the native MCP command and generated context", async () => {
		identityFiles(root);
		const result = await new GeminiConnector().install(root);
		const settingsPath = join(root, ".gemini", "settings.json");

		expect(result.success).toBe(true);
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
			mcpServers: { signet: { command: "signet-mcp", args: [] } },
		});
		expect(readFileSync(join(root, ".gemini", "GEMINI.md"), "utf8")).toContain("# AGENTS.md");
	});

	it("rejects incomplete managed identity without mutating Gemini files", async () => {
		writeFileSync(join(root, "AGENTS.md"), "before\n<!-- SIGNET:START -->\nold\n<!-- SIGNET:END -->\n");
		const result = await new GeminiConnector().install(root);
		expect(result.success).toBe(false);
		expect(existsSync(join(root, ".gemini", "settings.json"))).toBe(false);
		expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("SIGNET:START");
	});

	it("allows identity off mode without requiring identity files", async () => {
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "agent.yaml"), "mode: off\n");
		const result = await new GeminiConnector().install(root);
		expect(result.success).toBe(true);
		expect(existsSync(join(root, ".gemini", "settings.json"))).toBe(true);
	});
});
