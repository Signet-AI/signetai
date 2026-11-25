import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ConnectorRegistry, writeKeyFile } from "../../../../libs/sdk/src/node.js";

test("connector MCP proxies to its registered origin without credential argv", async () => {
	const home = await mkdtemp(join(tmpdir(), "signet-mcp-"));
	const secret = `sig_sk_${crypto.randomUUID()}`;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname !== "/mcp") return Response.json({});
			expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = await request.json();
			if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
			const result =
				body.method === "initialize"
					? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "remote", version: "1" } }
					: { tools: [{ name: "remote-only", inputSchema: { type: "object" } }] };
			return Response.json({ jsonrpc: "2.0", id: body.id, result });
		},
	});
	const env = { HOME: home };
	const keyFile = await writeKeyFile(server.url.origin, "codex", secret, { env });
	await new ConnectorRegistry({ env }).set("codex", { url: server.url.origin, keyFile });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [resolve(import.meta.dir, "../cli.ts"), "connector", "mcp", "codex"],
		env: { PATH: process.env.PATH ?? "", HOME: home, SIGNET_TELEMETRY_OPTOUT: "1" },
		stderr: "pipe",
	});
	const client = new Client({ name: "probe", version: "1" });
	try {
		await client.connect(transport);
		expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["remote-only"]);
	} finally {
		await client.close();
		server.stop(true);
		await rm(home, { recursive: true, force: true });
	}
}, 30000);
