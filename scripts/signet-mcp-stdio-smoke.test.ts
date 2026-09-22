import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const wrapperPackageJsonPath = join(root, "dist", "signetai", "package.json");
const stdioBundlePath = join(root, "dist", "signetai", "dist", "mcp-stdio.js");
const runningChildren: ChildProcess[] = [];

afterEach(() => {
	for (const child of runningChildren.splice(0)) {
		if (!child.killed) child.kill("SIGTERM");
	}
});

interface StdioHandshake {
	readonly status: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
}

function spawnStdioServer(
	input: string,
	timeoutMs = 30_000,
	bundlePath = stdioBundlePath,
	env = process.env,
): Promise<StdioHandshake> {
	return new Promise((resolve, reject) => {
		const child = spawn("node", [bundlePath], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		runningChildren.push(child);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (status, signal) => {
			clearTimeout(timer);
			resolve({
				status,
				signal,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(
				new Error(
					`signet-mcp stdio bundle did not exit within ${timeoutMs}ms — ` +
						`child killed, stderr so far: ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`,
				),
			);
		}, timeoutMs);
		timer.unref();
		child.stdin.write(`${input}\n`);
		child.stdin.end();
	});
}

interface JsonRpcResponse {
	readonly jsonrpc?: unknown;
	readonly id?: unknown;
	readonly result?: { readonly protocolVersion?: unknown; readonly capabilities?: unknown };
	readonly error?: { readonly code: unknown; readonly message: unknown };
}

describe("signet-mcp stdio server (regression guard for issue #826)", () => {
	test("wrapper package ships a self-contained stdio bundle as signet-mcp", () => {
		if (!existsSync(wrapperPackageJsonPath)) {
			throw new Error(
				`wrapper package.json not found at ${wrapperPackageJsonPath} — this file should always be tracked`,
			);
		}
		const wrapper = JSON.parse(readFileSync(wrapperPackageJsonPath, "utf-8")) as {
			readonly bin?: Record<string, string>;
			readonly files?: readonly string[];
		};
		expect(wrapper.bin?.["signet-mcp"]).toBe("dist/mcp-stdio.js");
		expect(wrapper.files ?? []).toContain("dist/mcp-stdio.js");
		expect(wrapper.files ?? []).not.toContain("bin/signet-mcp.js");
	});

	test("bundle is a real Node-runnable file (not a redirect or stub)", () => {
		if (!existsSync(stdioBundlePath)) {
			return;
		}
		const stat = statSync(stdioBundlePath);
		expect(stat.isFile()).toBe(true);
		const head = readFileSync(stdioBundlePath, { encoding: "utf-8", flag: "r" }).slice(0, 64);
		expect(head.startsWith("#!/usr/bin/env node")).toBe(true);
	});

	test(
		"responds to a JSON-RPC initialize request with a valid handshake",
		async () => {
			if (!existsSync(stdioBundlePath)) {
				return;
			}

			const request = JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "signet-mcp-stdio-smoke", version: "0" },
				},
			});

			const result = await spawnStdioServer(request);
			expect(result.status).toBe(0);
			expect(result.stderr.trim()).toBe("");
			const lines = result.stdout.split("\n").filter((line) => line.length > 0);
			expect(lines.length).toBeGreaterThan(0);
			const parsed = JSON.parse(lines[0]) as JsonRpcResponse;
			expect(parsed.jsonrpc).toBe("2.0");
			expect(parsed.id).toBe(1);
			expect(parsed.error).toBeUndefined();
			expect(parsed.result).toBeDefined();
			expect(typeof parsed.result?.protocolVersion).toBe("string");
			expect(parsed.result?.capabilities).toBeDefined();
		},
		{ timeout: 30_000 },
	);

	test(
		"starts under Node without resolving better-sqlite3 from the package",
		async () => {
			if (!existsSync(stdioBundlePath)) {
				return;
			}
			const isolatedDir = mkdtempSync(join(tmpdir(), "signet-mcp-node-smoke-"));
			const isolatedBundlePath = join(isolatedDir, "mcp-stdio.js");
			copyFileSync(stdioBundlePath, isolatedBundlePath);
			const env = { ...process.env };
			delete env.NODE_PATH;

			try {
				const request = JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2024-11-05",
						capabilities: {},
						clientInfo: { name: "signet-mcp-node-dependency-smoke", version: "0" },
					},
				});
				const result = await spawnStdioServer(request, 30_000, isolatedBundlePath, env);

				expect(result.status).toBe(0);
				expect(result.stderr.trim()).toBe("");
				const lines = result.stdout.split("\n").filter((line) => line.length > 0);
				expect(lines.length).toBeGreaterThan(0);
				const parsed = JSON.parse(lines[0]) as JsonRpcResponse;
				expect(parsed.jsonrpc).toBe("2.0");
				expect(parsed.id).toBe(1);
				expect(parsed.error).toBeUndefined();
				expect(parsed.result).toBeDefined();
			} finally {
				rmSync(isolatedDir, { recursive: true, force: true });
			}
		},
		{ timeout: 30_000 },
	);
});
