import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const daemon = process.env.SIGNET_RUST_DAEMON_BIN ?? join(import.meta.dir, "target/debug/signet-daemon");
const mcp = process.env.SIGNET_RUST_MCP_BIN ?? join(import.meta.dir, "target/debug/signet-mcp");
const launcher = join(root, "dist/signetai/bin/signet-mcp.js");
const token = "stdio-contract-token";
type RpcResponse = {
	id: number;
	result: { serverInfo?: { name: string }; tools?: Array<{ name: string }>; structuredContent?: unknown };
	error?: { code: number };
};
let workspace = "";
let port = 0;
let daemonProc: ReturnType<typeof Bun.spawn> | undefined;

async function waitForDaemon(origin: string) {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${origin}/health/live`)).ok) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error("native daemon did not become healthy");
}

function rpc(id: number, method: string, params: unknown = {}) {
	return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

beforeAll(async () => {
	if (!existsSync(daemon) || !existsSync(mcp) || !existsSync(launcher)) {
		throw new Error(`stdio contract requires native binaries and published launcher: ${daemon}, ${mcp}, ${launcher}`);
	}
	workspace = await mkdtemp("/tmp/signet-mcp-stdio-");
	const probe = Bun.spawn(
		[
			"sh",
			"-c",
			"python3 - <<'PY'\nimport socket\ns=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()\nPY",
		],
		{ stdout: "pipe" },
	);
	port = Number((await new Response(probe.stdout).text()).trim());
	await probe.exited;
	daemonProc = Bun.spawn([daemon], {
		env: {
			...process.env,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_PATH: workspace,
			SIGNET_API_KEY: token,
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	await waitForDaemon(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
	daemonProc?.kill();
	if (daemonProc) await daemonProc.exited;
	if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("published native signet-mcp stdio contract", () => {
	it("uses the native launcher for the complete JSON-RPC lifecycle", async () => {
		const child = Bun.spawn([process.execPath, launcher], {
			env: {
				...process.env,
				SIGNET_RUST_MCP_BIN: mcp,
				SIGNET_PORT: String(port),
				SIGNET_PATH: workspace,
				SIGNET_API_KEY: token,
				SIGNET_AGENT_ID: "agent-stdio-a",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const input = `${[
			rpc(1, "initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "contract", version: "1" },
			}),
			rpc(2, "tools/list"),
			rpc(3, "tools/call", { name: "health", arguments: {} }),
			rpc(4, "tools/call", { name: "remember", arguments: { content: "stdio contract propagation needle" } }),
			rpc(5, "tools/call", { name: "recall", arguments: { query: "propagation needle" } }),
			rpc(6, "tools/call", { name: "old_tool", arguments: {} }),
		].join("\n")}\n`;
		child.stdin.write(input);
		child.stdin.end();
		const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		const status = await child.exited;
		expect(status).toBe(0);
		expect(stderr.trim()).toBe("");
		const responses = stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as RpcResponse);
		expect(responses.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(responses[0].result.serverInfo.name).toBe("signet-native");
		expect(responses[1].result.tools?.map((x) => x.name)).toEqual(["remember", "recall", "health"]);
		expect(responses[2].error).toBeUndefined();
		expect(responses[2].result.structuredContent).toBeDefined();
		expect(typeof responses[3].result.structuredContent.id).toBe("string");
		expect(responses[4].result.structuredContent[0].content).toContain("stdio contract propagation needle");
		expect(responses[5].error.code).toBe(-32602);

		const isolated = Bun.spawn([process.execPath, launcher], {
			env: {
				...process.env,
				SIGNET_RUST_MCP_BIN: mcp,
				SIGNET_PORT: String(port),
				SIGNET_PATH: workspace,
				SIGNET_API_KEY: token,
				SIGNET_AGENT_ID: "agent-stdio-b",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		isolated.stdin.write(`${rpc(7, "tools/call", { name: "recall", arguments: { query: "propagation needle" } })}\n`);
		isolated.stdin.end();
		const isolatedBody = JSON.parse((await new Response(isolated.stdout).text()).trim());
		expect(await isolated.exited).toBe(0);
		expect(isolatedBody.id).toBe(7);
		expect(isolatedBody.result.structuredContent).toHaveLength(0);
		expect((await new Response(isolated.stderr).text()).trim()).toBe("");
	});
});
