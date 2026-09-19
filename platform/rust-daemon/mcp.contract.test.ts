import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const port = 39871;
const token = "mcp-contract-token";
let proc: ReturnType<typeof Bun.spawn>;
let workspace: string;
const origin = `http://127.0.0.1:${port}`;
const call = (body: unknown, agent?: string, auth = token) =>
	fetch(`${origin}/api/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${auth}`,
			...(agent ? { "x-signet-agent": agent } : {}),
		},
		body: JSON.stringify(body),
	});

beforeAll(async () => {
	workspace = await mkdtemp(`${tmpdir()}/signet-mcp-`);
	proc = Bun.spawn(["target/debug/signet-daemon"], {
		cwd: import.meta.dir,
		env: { ...process.env, SIGNET_PORT: String(port), SIGNET_PATH: workspace, SIGNET_API_KEY: token },
		stdout: "ignore",
		stderr: "pipe",
	});
	for (let i = 0; i < 80; i++) {
		try {
			if ((await fetch(`${origin}/health/live`)).ok) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error("daemon did not start");
});
afterAll(async () => {
	proc.kill();
	await rm(workspace, { recursive: true, force: true });
});

describe("native MCP JSON-RPC boundary", () => {
	it("initializes and lists bounded tools", async () => {
		const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		expect(init.status).toBe(200);
		expect((await init.json()).result.serverInfo.name).toBe("signet-native");
		const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		expect((await list.json()).result.tools.map((x: { name: string }) => x.name)).toEqual([
			"remember",
			"recall",
			"health",
		]);
	});
	it("remembers and recalls through the owner", async () => {
		const saved = await call(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "remember", arguments: { content: "native mcp contract needle" } },
			},
			"agent-a",
		);
		const savedBody = await saved.json();
		expect(typeof savedBody.result.structuredContent.id).toBe("string");
		const recalled = await call(
			{
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "recall", arguments: { query: "contract needle" } },
			},
			"agent-a",
		);
		const recalledBody = await recalled.json();
		expect(recalledBody.result.structuredContent.length).toBeGreaterThan(0);
		expect(recalledBody.result.structuredContent[0].content).toContain("native mcp contract needle");
	});
	it("returns structured errors and enforces auth and agent isolation", async () => {
		expect((await (await call({ jsonrpc: "2.0", id: 5, method: "wat", params: {} })).json()).error.code).toBe(-32601);
		expect(
			(await (await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } })).json()).error.code,
		).toBe(-32602);
		expect((await fetch(`${origin}/api/mcp`, { method: "POST", body: "{" })).status).toBe(401);
		const isolated = await call(
			{
				jsonrpc: "2.0",
				id: 7,
				method: "tools/call",
				params: { name: "recall", arguments: { query: "contract needle" } },
			},
			"agent-b",
		);
		expect((await isolated.json()).result.structuredContent.length).toBe(0);
	});
});
