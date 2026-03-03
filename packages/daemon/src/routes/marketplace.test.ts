import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { extractStandardMcpConfig, mountMarketplaceRoutes, parseReferenceServersMarkdown } from "./marketplace.js";

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
});
