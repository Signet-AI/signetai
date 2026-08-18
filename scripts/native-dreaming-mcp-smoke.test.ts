/** Regression guard for Dreaming MCP dispatch through the compiled native binary. */
import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DREAMING_CAPABILITY_IDS } from "../platform/daemon/src/pipeline/dreaming-capabilities";

const root = join(import.meta.dir, "..");
const enabled = process.env.SIGNET_DREAMING_MCP_SMOKE === "1";
const children: ChildProcessWithoutNullStreams[] = [];

function nativeSmokeBinary(): string {
	const override = process.env.SIGNET_NATIVE_SMOKE_BINARY;
	if (override) return resolve(root, override);
	const key = `${process.platform}-${process.arch}`;
	return join(root, "dist", "native", key.startsWith("win32-") ? `signet-${key}.exe` : `signet-${key}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

interface McpProcessConfig {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: readonly { readonly name: string; readonly value: string }[];
}

function dreamingMcpProcess(binary: string): McpProcessConfig {
	const generated = spawnSync(binary, [], {
		env: { ...process.env, SIGNET_DREAMING_MCP_CONFIG_SMOKE: "1", SIGNET_TELEMETRY_OPTOUT: "1" },
		encoding: "utf8",
		timeout: 10_000,
	});
	if (generated.error) throw generated.error;
	if (generated.status !== 0) {
		throw new Error(`native MCP config smoke exited with ${generated.status}: ${generated.stderr}`);
	}
	const parsed: unknown = JSON.parse(generated.stdout);
	if (!isRecord(parsed) || !Array.isArray(parsed.mcpServers) || !isRecord(parsed.mcpServers[0])) {
		throw new Error("native MCP config smoke returned an invalid server list");
	}
	const server = parsed.mcpServers[0];
	if (typeof server.command !== "string" || !Array.isArray(server.args) || !Array.isArray(server.env)) {
		throw new Error("native MCP config smoke returned an invalid process config");
	}
	const args = server.args.filter((arg): arg is string => typeof arg === "string");
	if (args.length !== server.args.length) throw new Error("native MCP config smoke returned a non-string argument");
	const env = server.env.flatMap((entry) => {
		if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") return [];
		return [{ name: entry.name, value: entry.value }];
	});
	if (env.length !== server.env.length) throw new Error("native MCP config smoke returned an invalid environment");
	return { command: server.command, args, env };
}

async function waitForResponse(
	output: () => string,
	stderr: () => string,
	child: ChildProcessWithoutNullStreams,
	id: number,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		for (const line of output().split("\n")) {
			if (line.length === 0) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isRecord(parsed) && parsed.id === id) return parsed;
			} catch {}
		}
		if (child.exitCode !== null) {
			throw new Error(`native MCP worker exited with ${child.exitCode}: ${stderr()}`);
		}
		await Bun.sleep(10);
	}
	throw new Error(`native MCP response ${id} did not arrive: ${stderr()}`);
}

afterEach(() => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
	}
});

describe("compiled native Dreaming MCP", () => {
	const smoke = enabled ? test : test.skip;

	smoke(
		"starts the scoped stdio server without resolving /$bunfs/mcp-stdio.js",
		async () => {
			const binary = nativeSmokeBinary();
			if (!existsSync(binary)) {
				throw new Error(`native binary not found at ${binary}; build it first (bun run build:native-bun)`);
			}
			const config = dreamingMcpProcess(binary);
			expect(resolve(config.command)).toBe(binary);
			expect(config.args).toEqual([]);
			expect(config.env).toContainEqual({ name: "SIGNET_MCP_STDIO_WORKER", value: "1" });
			const env = { ...process.env, SIGNET_TELEMETRY_OPTOUT: "1" };
			for (const entry of config.env) env[entry.name] = entry.value;
			const child = spawn(config.command, [...config.args], {
				env,
				stdio: ["pipe", "pipe", "pipe"],
			});
			children.push(child);
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code, signal) => resolve({ code, signal }));
			});

			child.stdin.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2024-11-05",
						capabilities: {},
						clientInfo: { name: "native-dreaming-mcp-smoke", version: "0" },
					},
				})}\n`,
			);
			const initialized = await waitForResponse(stdoutText, stderrText, child, 1);
			expect(initialized.error).toBeUndefined();

			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
			const listed = await waitForResponse(stdoutText, stderrText, child, 2);
			expect(listed.error).toBeUndefined();
			const result = listed.result;
			expect(isRecord(result)).toBe(true);
			if (!isRecord(result)) throw new Error("native MCP tools/list result is not an object");
			const tools = result.tools;
			expect(Array.isArray(tools)).toBe(true);
			if (!Array.isArray(tools)) throw new Error("native MCP tools/list result has no tools array");
			const names = tools.flatMap((tool) => (isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []));
			expect(names.sort()).toEqual([...DREAMING_CAPABILITY_IDS].sort());

			child.stdin.end();
			expect(await closed).toEqual({ code: 0, signal: null });
			expect(stderr.trim()).toBe("");

			function stdoutText(): string {
				return stdout;
			}

			function stderrText(): string {
				return stderr;
			}
		},
		30_000,
	);
});
