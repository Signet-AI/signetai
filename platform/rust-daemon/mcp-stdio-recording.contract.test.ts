import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const binary = process.env.SIGNET_RUST_MCP_BIN ?? join(import.meta.dir, "target/debug/signet-mcp");

describe("native MCP stdio transport", () => {
	it("forwards bounded JSON-RPC requests to the recording daemon", async () => {
		const seen: Request[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				seen.push(request);
				const body = await request.json();
				return Response.json(
					body.id === 1
						? { jsonrpc: "2.0", id: 1, result: { ok: true } }
						: { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32602, message: "bad params" } },
				);
			},
		});
		const child = Bun.spawn([binary], {
			env: {
				...process.env,
				SIGNET_DAEMON_URL: `http://127.0.0.1:${server.port}`,
				SIGNET_MCP_BRIDGE_URL: "http://127.0.0.1:1/wrong",
				SIGNET_DREAMING_AGENT_ID: "dream-agent",
				SIGNET_WORKSPACE: "workspace-a",
				SIGNET_HARNESS: "acpx",
				SIGNET_CHANNEL: "dreaming",
				SIGNET_TOKEN: "secret-token",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
		child.stdin.write("not json\n");
		child.stdin.write(`${"x".repeat(256 * 1024 + 1)}\n`);
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call" })}\n`);
		child.stdin.end();
		const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect(await child.exited).toBe(0);
		expect(stderr).toBe("");
		const replies = stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(replies.map((reply) => reply.id)).toEqual([1, null, null, 2]);
		expect(replies[0].result.ok).toBe(true);
		expect(replies[1].error.code).toBe(-32700);
		expect(replies[2].error.code).toBe(-32600);
		expect(replies[3].error.code).toBe(-32602);
		expect(seen).toHaveLength(2);
		expect(new URL(seen[0].url).pathname).toBe("/api/mcp");
		expect(seen[0].headers.get("x-signet-agent-id")).toBe("dream-agent");
		expect(seen[0].headers.get("x-signet-workspace")).toBe("workspace-a");
		expect(seen[0].headers.get("x-signet-harness")).toBe("acpx");
		expect(seen[0].headers.get("x-signet-channel")).toBe("dreaming");
		expect(seen[0].headers.get("authorization")).toBe("Bearer secret-token");
		server.stop(true);
	});
});
