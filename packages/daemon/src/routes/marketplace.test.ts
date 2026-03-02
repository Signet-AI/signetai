import { describe, expect, it } from "bun:test";
import { extractStandardMcpConfig, parseReferenceServersMarkdown } from "./marketplace.js";

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
