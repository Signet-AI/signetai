import { afterEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	createInspectorProxy,
	formatInspectorEndpoint,
	parseInspectorEndpoint,
	resolveInspectorParentHandoff,
} from "./inspector-proxy.js";

let target: ChildProcess | null = null;
let proxy: Bun.Server<unknown> | null = null;

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address !== "object" || address === null) {
				server.close();
				reject(new Error("Port reservation returned no address"));
				return;
			}
			const port = address.port;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

async function waitForInspector(port: number): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (response.ok) return;
		} catch {
			// The inspector is still starting.
		}
		await Bun.sleep(50);
	}
	throw new Error(`Inspector did not start on port ${port}`);
}

afterEach(() => {
	proxy?.stop(true);
	proxy = null;
	target?.kill();
	target = null;
});

describe("inspector discovery proxy", () => {
	it("hands off a parent-owned BUN_INSPECT listener before binding discovery", () => {
		const handoff = resolveInspectorParentHandoff({ BUN_INSPECT: "127.0.0.1:9230" });

		expect(handoff?.publicInspector).toBe("127.0.0.1:9230");
		expect(handoff?.environment.BUN_INSPECT).toBe("");
		expect(handoff?.environment.SIGNET_INSPECTOR_PUBLIC).toBe("127.0.0.1:9230");
		expect(handoff?.environment.SIGNET_INSPECTOR_HANDOFF).toBe("1");
		expect(resolveInspectorParentHandoff({ BUN_INSPECT: "127.0.0.1:9230", SIGNET_INSPECTOR_HANDOFF: "1" })).toBeNull();
	});

	it("normalizes IPv6 discovery endpoints and rejects invalid ports", () => {
		const endpoint = parseInspectorEndpoint("[::1]:9230/json");
		expect(endpoint.host).toBe("::1");
		expect(formatInspectorEndpoint(endpoint)).toBe("[::1]:9230/json");
		expect(() => parseInspectorEndpoint("0")).toThrow("Invalid inspector port");
		expect(() => parseInspectorEndpoint("70000")).toThrow("Invalid inspector port");
	});

	it("serves discovery routes and forwards WebSocket messages for a Bun target", async () => {
		const targetPort = await freePort();
		const publicPort = await freePort();
		target = spawn(process.execPath, [`--inspect=127.0.0.1:${targetPort}/json`, "-e", "setInterval(() => {}, 1000)"], {
			env: { ...process.env, BUN_INSPECT: "" },
			stdio: "ignore",
		});
		await waitForInspector(targetPort);
		proxy = createInspectorProxy({
			publicEndpoint: parseInspectorEndpoint(`127.0.0.1:${publicPort}`),
			targetEndpoint: parseInspectorEndpoint(`127.0.0.1:${targetPort}/json`),
		});

		for (const path of ["/json", "/json/list", "/json/protocol"]) {
			const response = await fetch(`http://127.0.0.1:${publicPort}${path}`);
			expect(response.status).toBe(200);
		}
		const discovery = (await (await fetch(`http://127.0.0.1:${publicPort}/json`)).json()) as Array<{
			webSocketDebuggerUrl: string;
		}>;
		expect(discovery[0]?.webSocketDebuggerUrl).toBe(
			`ws://${formatInspectorEndpoint(parseInspectorEndpoint(`127.0.0.1:${publicPort}`), "/json")}`,
		);

		const result = await new Promise<string>((resolve, reject) => {
			const socket = new WebSocket(discovery[0]?.webSocketDebuggerUrl ?? "");
			socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" })));
			socket.addEventListener("message", (event) => {
				resolve(String(event.data));
				socket.close();
			});
			socket.addEventListener("error", () => reject(new Error("Inspector WebSocket failed")));
		});
		expect(result).toContain('"id":1');
	});
});
