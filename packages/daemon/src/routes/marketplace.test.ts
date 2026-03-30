import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
	type InstalledMarketplaceMcpServer,
	extractStandardMcpConfig,
	mountMarketplaceRoutes,
	parseReferenceServersMarkdown,
} from "./marketplace.js";

describe("parseReferenceServersMarkdown", () => {
	it("parses official reference server section", () => {
		const markdown = `
## 🌟 Reference Servers

- **[Fetch](src/fetch)** - Web content fetching and conversion.
- **[Filesystem](src/filesystem)** - Secure file operations.

### Archived
`;

		const entries = parseReferenceServersMarkdown(markdown);
		expect(entries.length).toBe(2);
		expect(entries[0]?.source).toBe("modelcontextprotocol/servers");
		expect(entries[0]?.catalogId).toBe("fetch");
		expect(entries[0]?.official).toBe(true);
		expect(entries[1]?.catalogId).toBe("filesystem");
	});
});

describe("extractStandardMcpConfig", () => {
	it("parses mcpServers config blocks", () => {
		const markdown = `
## Config



\`\`\`json
{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}
\`\`\`
`;

		const detail = extractStandardMcpConfig(markdown);
		expect(detail.nameHint).toBe("fetch");
		expect(detail.config?.transport).toBe("stdio");
		if (detail.config?.transport === "stdio") {
			expect(detail.config.command).toBe("uvx");
			expect(detail.config.args[0]).toBe("mcp-server-fetch");
		}
	});

	it("parses VS Code mcp.servers config blocks", () => {
		const markdown = `
## Config

\`\`\`json
{
  "mcp": {
    "servers": {
      "time": {
        "command": "uvx",
        "args": ["mcp-server-time"]
      }
    }
  }
}
\`\`\`
`;

		const detail = extractStandardMcpConfig(markdown);
		expect(detail.nameHint).toBe("time");
		expect(detail.config?.transport).toBe("stdio");
		if (detail.config?.transport === "stdio") {
			expect(detail.config.command).toBe("uvx");
			expect(detail.config.args[0]).toBe("mcp-server-time");
		}
	});
});

describe("marketplace routes", () => {
	const tmpAgentsDir = join(tmpdir(), `signet-marketplace-route-test-${process.pid}`);
	let origSignetPath: string | undefined;
	let app: Hono;

	beforeEach(() => {
		origSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = tmpAgentsDir;
		mkdirSync(tmpAgentsDir, { recursive: true });

		app = new Hono();
		mountMarketplaceRoutes(app);
	});

	afterEach(() => {
		process.env.SIGNET_PATH = origSignetPath;
		if (existsSync(tmpAgentsDir)) {
			rmSync(tmpAgentsDir, { recursive: true, force: true });
		}
	});

	it("GET /api/marketplace/mcp/tools resolves to tools handler", async () => {
		const res = await app.request("/api/marketplace/mcp/tools");
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			count: number;
			tools: unknown[];
			servers: unknown[];
			error?: string;
		};

		expect(body.error).toBeUndefined();
		expect(body.count).toBe(0);
		expect(body.tools).toEqual([]);
		expect(body.servers).toEqual([]);
	});

	it("GET /api/marketplace/mcp/search resolves to search handler", async () => {
		const res = await app.request("/api/marketplace/mcp/search?q=time");
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			query: string;
			count: number;
			results: unknown[];
			error?: string;
		};

		expect(body.error).toBeUndefined();
		expect(body.query).toBe("time");
		expect(body.count).toBe(0);
		expect(body.results).toEqual([]);
	});

	it("POST /api/marketplace/mcp/:id/generate-cli returns 404 for unknown server", async () => {
		const res = await app.request("/api/marketplace/mcp/nonexistent/generate-cli", { method: "POST" });
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Server not found");
	});

	it("POST /api/marketplace/mcp/:id/generate-cli returns 400 for HTTP servers", async () => {
		// Seed an HTTP server
		const server: InstalledMarketplaceMcpServer = {
			id: "test-http",
			source: "manual",
			name: "test-http-server",
			description: "test",
			category: "test",
			official: false,
			enabled: true,
			scope: { harnesses: [], workspaces: [], channels: [] },
			config: { transport: "http", url: "https://example.com/mcp", headers: {}, timeoutMs: 20000 },
			installedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		const mpDir = join(tmpAgentsDir, "marketplace");
		mkdirSync(mpDir, { recursive: true });
		writeFileSync(join(mpDir, "mcp-servers.json"), JSON.stringify([server]));

		const res = await app.request("/api/marketplace/mcp/test-http/generate-cli", { method: "POST" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("stdio");
	});

	it("POST /api/marketplace/mcp/:id/generate-cli rejects servers with secret:// references", async () => {
		const server: InstalledMarketplaceMcpServer = {
			id: "test-secret",
			source: "manual",
			name: "test-secret-server",
			description: "test",
			category: "test",
			official: false,
			enabled: true,
			scope: { harnesses: [], workspaces: [], channels: [] },
			config: {
				transport: "stdio",
				command: "npx",
				args: ["-y", "some-mcp-server"],
				env: { API_KEY: "secret://MY_API_KEY" },
				timeoutMs: 20000,
			},
			installedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		const mpDir = join(tmpAgentsDir, "marketplace");
		mkdirSync(mpDir, { recursive: true });
		writeFileSync(join(mpDir, "mcp-servers.json"), JSON.stringify([server]));

		const res = await app.request("/api/marketplace/mcp/test-secret/generate-cli", { method: "POST" });
		expect(res.status).toBe(500);
		const body = (await res.json()) as { success: boolean; error: string };
		expect(body.success).toBe(false);
		expect(body.error).toContain("secret://");
	});
});
