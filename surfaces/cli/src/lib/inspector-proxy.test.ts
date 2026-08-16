import { afterEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
	createInspectorProxy,
	formatInspectorEndpoint,
	parseInspectorEndpoint,
	resolveInspectorHandoffArgs,
	resolveInspectorParentHandoff,
} from "./inspector-proxy.js";

let target: ChildProcess | null = null;
let nativeParent: ChildProcess | null = null;
let proxy: Bun.Server<unknown> | null = null;

const inspectorProxySource = fileURLToPath(new URL("./inspector-proxy.ts", import.meta.url));

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

function compileInspectorHarness(directory: string): string {
	const fixture = join(directory, "native-inspector-harness.ts");
	const binary = join(directory, "native-inspector-harness");
	writeFileSync(
		fixture,
		`import { handoffInspectorParent, parseInspectorEndpoint, runInspectorProxy } from ${JSON.stringify(inspectorProxySource)};
const publicValue = process.env.SIGNET_INSPECTOR_TEST_PUBLIC;
const targetValue = process.env.SIGNET_INSPECTOR_TEST_TARGET;
if (!publicValue || !targetValue) throw new Error("Inspector test endpoints are missing");
handoffInspectorParent();
if (process.env.SIGNET_INSPECTOR_HANDOFF !== "1") throw new Error("Inspector parent handoff did not re-exec");
await runInspectorProxy({
  publicEndpoint: parseInspectorEndpoint(publicValue),
  targetEndpoint: parseInspectorEndpoint(targetValue),
});
const exitAfterMs = Number(process.env.SIGNET_INSPECTOR_TEST_EXIT_AFTER_MS ?? "0");
if (exitAfterMs > 0) setTimeout(() => process.exit(0), exitAfterMs);
`,
	);
	const result = spawnSync(process.execPath, ["build", "--compile", "--target=bun", "--outfile", binary, fixture], {
		encoding: "utf8",
		timeout: 120_000,
	});
	if (result.status !== 0 || !existsSync(binary)) {
		throw new Error(`Native inspector harness build failed: ${String(result.stderr ?? result.stdout)}`);
	}
	return binary;
}

afterEach(() => {
	proxy?.stop(true);
	proxy = null;
	nativeParent?.kill();
	nativeParent = null;
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

	it("drops Bun's compiled entrypoint from the re-exec argument list", () => {
		expect(resolveInspectorHandoffArgs(["bun", "/$bunfs/root/signet", "daemon", "start"])).toEqual(["daemon", "start"]);
		expect(resolveInspectorHandoffArgs(["bun", "/tmp/cli.ts", "daemon", "start"])).toEqual([
			"/tmp/cli.ts",
			"daemon",
			"start",
		]);
	});

	it("exercises native parent re-exec and proxy discovery", async () => {
		const targetPort = await freePort();
		const publicPort = await freePort();
		const directory = mkdtempSync(join(tmpdir(), "signet-native-inspector-test-"));
		target = spawn(process.execPath, [`--inspect=127.0.0.1:${targetPort}/json`, "-e", "setInterval(() => {}, 1000)"], {
			env: { ...process.env, BUN_INSPECT: "" },
			stdio: "ignore",
		});
		await waitForInspector(targetPort);

		try {
			const binary = compileInspectorHarness(directory);
			nativeParent = spawn(binary, [], {
				env: {
					...process.env,
					BUN_INSPECT: `127.0.0.1:${publicPort}/json`,
					SIGNET_INSPECTOR_TEST_PUBLIC: `127.0.0.1:${publicPort}/json`,
					SIGNET_INSPECTOR_TEST_TARGET: `127.0.0.1:${targetPort}/json`,
					SIGNET_INSPECTOR_TEST_EXIT_AFTER_MS: "5000",
				},
				stdio: "ignore",
			});
			await waitForInspector(publicPort);

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
				socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 7, method: "Runtime.enable" })));
				socket.addEventListener("message", (event) => {
					resolve(String(event.data));
					socket.close();
				});
				socket.addEventListener("error", () => reject(new Error("Native inspector WebSocket failed")));
			});
			expect(result).toContain('"id":7');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
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
