/**
 * Regression guard for the published `signet-mcp` stdio server.
 *
 * Background: PR #816 changed the npm wrapper's `signet-mcp` bin from
 * `dist/mcp-stdio.js` (a real MCP stdio server) to `bin/signet-mcp.js`
 * (a wrapper that shells out to the native binary's management CLI).
 * Connectors like `claude-code` spawn `signet-mcp` as a JSON-RPC stdio
 * server, so the regression broke every harness using the default
 * `{"command": "signet-mcp"}` MCP config (issue #826).
 *
 * The shipped `signet-mcp` must accept a JSON-RPC `initialize` request
 * and return a valid `result`. If this test fails, the wrapper has
 * regressed to forwarding into the native binary's management CLI.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
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

function spawnStdioServer(input: string, timeoutMs = 10_000): Promise<StdioHandshake> {
	return new Promise((resolve, reject) => {
		const child = spawn("node", [stdioBundlePath], {
			env: process.env,
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
		// Hard timeout — if the stdio server hangs (MCP SDK regression,
		// hung daemon probe, etc.) kill the child and surface a clear
		// failure rather than blocking the whole `bun test` run.
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
	// The manifest test runs regardless of build state — it only depends on
	// the tracked package.json file. The bundle and handshake tests skip
	// cleanly when the bundle hasn't been built, so `bun test` works in
	// clean checkouts that haven't run `bun run build:signetai` yet.
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
		// The pre-#816 forwarder shim must not be in the tarball.
		expect(wrapper.files ?? []).not.toContain("bin/signet-mcp.js");
	});

	test("bundle is a real Node-runnable file (not a redirect or stub)", () => {
		if (!existsSync(stdioBundlePath)) {
			// Skipped on clean checkouts — the bundle is a build artifact.
			return;
		}
		const stat = statSync(stdioBundlePath);
		expect(stat.isFile()).toBe(true);
		// Bundle must have a Node shebang so `signet-mcp` runs directly when
		// the package manager installs the bin symlink with default perms.
		const head = readFileSync(stdioBundlePath, { encoding: "utf-8", flag: "r" }).slice(0, 64);
		expect(head.startsWith("#!/usr/bin/env node")).toBe(true);
	});

	test("responds to a JSON-RPC initialize request with a valid handshake", async () => {
		if (!existsSync(stdioBundlePath)) {
			// Skipped on clean checkouts — the bundle is a build artifact.
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

		// The server must shut down cleanly when its stdin closes.
		expect(result.status).toBe(0);
		// The native management CLI prints "Usage: signet mcp ..." to stderr.
		// A real stdio server should not produce any non-protocol output.
		expect(result.stderr.trim()).toBe("");

		// The first non-empty stdout line must be a JSON-RPC response to our
		// initialize request. This is the exact shape a harness expects to
		// see during the MCP handshake.
		const lines = result.stdout.split("\n").filter((line) => line.length > 0);
		expect(lines.length).toBeGreaterThan(0);
		const parsed = JSON.parse(lines[0]) as JsonRpcResponse;
		expect(parsed.jsonrpc).toBe("2.0");
		expect(parsed.id).toBe(1);
		expect(parsed.error).toBeUndefined();
		expect(parsed.result).toBeDefined();
		expect(typeof parsed.result?.protocolVersion).toBe("string");
		expect(parsed.result?.capabilities).toBeDefined();
	});
});
