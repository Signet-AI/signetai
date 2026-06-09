#!/usr/bin/env bun
/**
 * Signet MCP stdio server end-to-end probe.
 *
 * Spawns the installed `signet-mcp` binary, drives it through a real MCP
 * session (initialize → notifications/initialized → tools/list → a small
 * set of read-only tools/call), and asserts every response shape. This
 * is the manual-probe flow used during issue #826 verification, captured
 * as a CI-friendly script so future regressions in the npm wrapper
 * surface as a red CI run rather than a connector that silently fails
 * handshakes.
 *
 * Used by:
 *   - `bun scripts/probe-signet-mcp.ts` — manual run against a live
 *     daemon
 *   - `bun run probe:signet-mcp` — same, via the root script alias
 *   - The `signet-mcp-stdio-smoke` CI job (when wired in) — uses
 *     `--self-test` to skip the daemon dependency
 *
 * The script is daemon-dependent: it expects a healthy Signet daemon on
 * the default port. Run `signet daemon start` first, or set
 * `SIGNET_DAEMON_URL` to point at a different instance.
 *
 * Frame pacing: each JSON-RPC frame is written with a small delay
 * between writes. The stdio server in `platform/daemon/src/mcp-stdio.ts`
 * shuts down on stdin EOF, so a `cat <<EOF | signet-mcp` style pipe
 * closes stdin too early and frames after the first one are lost. The
 * delays keep stdin open long enough for each request to be processed
 * and the response to be flushed.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface JsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id: number;
	readonly method: string;
	readonly params?: unknown;
}

interface JsonRpcNotification {
	readonly jsonrpc: "2.0";
	readonly method: string;
	readonly params?: unknown;
}

interface JsonRpcResponse {
	readonly jsonrpc?: unknown;
	readonly id?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code: unknown; readonly message: unknown };
}

type ToolCall = {
	readonly name: string;
	readonly args: Record<string, unknown>;
	readonly validate: (result: unknown) => string | null;
};

const FRAME_DELAY_MS = 250;
const HANDSHAKE_TIMEOUT_MS = 15_000;

function frameDelay(ms = FRAME_DELAY_MS): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function findSignetMcpBin(): string {
	// Resolve the installed `signet-mcp` from PATH, matching the npm
	// wrapper's bin symlink that consumers actually get. On PATH miss we
	// fall back to the workspace install location used by `bun add -g`.
	const candidates: string[] = [];
	const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
	for (const dir of pathDirs) {
		candidates.push(join(dir, "signet-mcp"));
	}
	if (process.env.BUN_INSTALL) {
		candidates.push(join(process.env.BUN_INSTALL, "bin", "signet-mcp"));
	}
	candidates.push(join(process.env.HOME ?? tmpdir(), ".bun", "bin", "signet-mcp"));
	candidates.push(join(process.env.HOME ?? tmpdir(), ".local", "bin", "signet-mcp"));
	candidates.push("/usr/local/bin/signet-mcp");
	candidates.push("/usr/bin/signet-mcp");

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	throw new Error(
		"signet-mcp binary not found on PATH or in common install locations. " +
			"Install with `bun add -g signetai` (or `npm install -g signetai`) and retry.",
	);
}

class StdioClient {
	private readonly child: ChildProcess;
	private readonly stdoutBuffer: string[] = [];
	private readonly stderrBuffer: string[] = [];
	private responseWaiters: Array<(line: string) => void> = [];
	private lineTail = "";
	private exitCode: number | null = null;

	constructor(bin: string) {
		this.child = spawn(bin, [], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, SIGNET_HARNESS: "probe" },
		});
		this.child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk.toString("utf8")));
		this.child.stderr?.on("data", (chunk: Buffer) => this.stderrBuffer.push(chunk.toString("utf8")));
		this.child.on("close", (code) => {
			this.exitCode = code;
			const waiters = this.responseWaiters;
			this.responseWaiters = [];
			for (const resolve of waiters) resolve("");
		});
	}

	private onStdout(chunk: string): void {
		this.stdoutBuffer.push(chunk);
		this.lineTail += chunk;
		let newlineIndex = this.lineTail.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.lineTail.slice(0, newlineIndex).trim();
			this.lineTail = this.lineTail.slice(newlineIndex + 1);
			// The daemon writes structured log lines to stderr and JSON-RPC
			// responses to stdout, but some plugin log lines still leak
			// through stdout when the log level or formatter is misrouted.
			// Filter to JSON-shaped lines so waiters only ever see real
			// JSON-RPC frames.
			if (line.length > 0 && line.startsWith("{")) {
				const waiter = this.responseWaiters.shift();
				if (waiter) waiter(line);
			}
			newlineIndex = this.lineTail.indexOf("\n");
		}
	}

	async sendRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		const responsePromise = new Promise<string>((resolve) => this.responseWaiters.push(resolve));
		this.child.stdin?.write(`${JSON.stringify(request)}\n`);
		const line = await responsePromise;
		if (line.length === 0) {
			throw new Error(
				`signet-mcp exited (code ${this.exitCode}) before responding to ${request.method} (id=${request.id}). ` +
					`stderr: ${this.stderrBuffer.join("").trim().slice(0, 1000)}`,
			);
		}
		try {
			return JSON.parse(line) as JsonRpcResponse;
		} catch (err) {
			throw new Error(
				`failed to parse response for ${request.method} (id=${request.id}): ${err instanceof Error ? err.message : String(err)}\n` +
					`first 200 chars of line: ${line.slice(0, 200)}`,
			);
		}
	}

	async sendNotification(notification: JsonRpcNotification): Promise<void> {
		this.child.stdin?.write(`${JSON.stringify(notification)}\n`);
	}

	async close(): Promise<void> {
		if (!this.child.stdin?.destroyed) this.child.stdin?.end();
		await new Promise<void>((resolve) => {
			if (this.child.exitCode !== null) return resolve();
			this.child.once("close", () => resolve());
			const timer = setTimeout(() => {
				this.child.kill("SIGTERM");
				resolve();
			}, 1_000);
			timer.unref();
		});
	}

	stderr(): string {
		return this.stderrBuffer.join("").trim();
	}
}

const TOOL_CALLS: readonly ToolCall[] = [
	{
		name: "memory_list",
		args: { limit: 2 },
		validate: (result) => {
			const r = unwrapToolResult(result) as { memories?: unknown[]; stats?: { total?: number } };
			if (!r || !Array.isArray(r.memories)) return "expected memories array in result";
			if (!r.stats || typeof r.stats.total !== "number") return "expected stats.total in result";
			return null;
		},
	},
	{
		name: "knowledge_list_entities",
		args: { limit: 3 },
		validate: (result) => {
			const r = unwrapToolResult(result) as { items?: unknown[]; limit?: number };
			if (!r || !Array.isArray(r.items)) return "expected items array in result";
			return null;
		},
	},
	{
		name: "mcp_server_list",
		args: {},
		validate: (result) => {
			const r = unwrapToolResult(result) as { tools?: unknown[]; servers?: unknown[]; policy?: { mode?: string } };
			if (!r || !Array.isArray(r.servers)) return "expected servers array in result";
			if (r.policy && typeof r.policy !== "object") return "expected policy object in result";
			return null;
		},
	},
	{
		name: "signet_code_status",
		args: {},
		validate: (result) => {
			const text = unwrapToolText(result);
			if (!text.includes("GraphIQ Status")) return "expected GraphIQ Status header in code status output";
			return null;
		},
	},
	{
		name: "secret_list",
		args: {},
		validate: (result) => {
			const r = unwrapToolResult(result) as { secrets?: unknown[]; provider?: string };
			if (!r || !Array.isArray(r.secrets)) return "expected secrets array in result";
			return null;
		},
	},
];

function unwrapToolResult(result: unknown): unknown {
	if (!result || typeof result !== "object") return result;
	const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
	if (!Array.isArray(r.content) || r.content.length === 0) return result;
	if (r.isError) {
		const firstText = r.content.find((c) => c?.type === "text")?.text ?? "(no text)";
		throw new Error(`tool reported error: ${firstText}`);
	}
	const textItem = r.content.find((c) => c?.type === "text");
	if (!textItem?.text) return result;
	// Tools that return structured data wrap it in JSON inside the text
	// item. Tools that return pre-formatted text (e.g. signet_code_status)
	// return human-readable output and we should not try to parse it.
	const text = textItem.text;
	if (text.length === 0 || text[0] !== "{") return text;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function unwrapToolText(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const r = result as { content?: Array<{ type: string; text?: string }> };
	if (!Array.isArray(r.content)) return "";
	return r.content
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text ?? "")
		.join("\n");
}

async function main(): Promise<void> {
	const bin = findSignetMcpBin();
	console.log(`probe: signet-mcp at ${bin}`);

	const client = new StdioClient(bin);
	const failures: string[] = [];
	let id = 0;

	try {
		const initResponse = await client.sendRequest({
			jsonrpc: "2.0",
			id: ++id,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "probe-signet-mcp", version: "0" },
			},
		});
		if (initResponse.error) {
			throw new Error(`initialize returned error: ${JSON.stringify(initResponse.error)}`);
		}
		const initResult = initResponse.result as
			| {
					protocolVersion?: string;
					serverInfo?: { name?: string };
					capabilities?: { tools?: { listChanged?: boolean } };
			  }
			| undefined;
		if (!initResult) throw new Error("initialize returned no result");
		if (initResult.protocolVersion !== "2024-11-05") {
			throw new Error(`unexpected protocolVersion: ${initResult.protocolVersion}`);
		}
		if (initResult.serverInfo?.name !== "signet") {
			throw new Error(`unexpected serverInfo.name: ${initResult.serverInfo?.name}`);
		}
		if (initResult.capabilities?.tools?.listChanged !== true) {
			throw new Error("server did not advertise tools.listChanged");
		}
		console.log(
			`probe: initialize ok (server=${initResult.serverInfo.name}, protocolVersion=${initResult.protocolVersion})`,
		);

		await frameDelay();
		await client.sendNotification({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
		await frameDelay();

		const listResponse = await client.sendRequest({ jsonrpc: "2.0", id: ++id, method: "tools/list", params: {} });
		if (listResponse.error) throw new Error(`tools/list returned error: ${JSON.stringify(listResponse.error)}`);
		const listResult = listResponse.result as { tools?: Array<{ name: string }> } | undefined;
		if (!listResult?.tools || listResult.tools.length === 0) throw new Error("tools/list returned empty catalog");
		console.log(`probe: tools/list ok (${listResult.tools.length} tools)`);
		await frameDelay();

		for (const call of TOOL_CALLS) {
			const response = await client.sendRequest({
				jsonrpc: "2.0",
				id: ++id,
				method: "tools/call",
				params: { name: call.name, arguments: call.args },
			});
			if (response.error) {
				failures.push(`${call.name} returned error: ${JSON.stringify(response.error)}`);
				continue;
			}
			const validationError = call.validate(response.result);
			if (validationError) {
				failures.push(`${call.name} validation failed: ${validationError}`);
				continue;
			}
			console.log(`probe: tools/call ${call.name} ok`);
			await frameDelay();
		}
	} finally {
		await sleep(100);
		await client.close();
	}

	if (failures.length > 0) {
		console.error("");
		console.error("probe FAILED:");
		for (const failure of failures) console.error(`  - ${failure}`);
		process.exit(1);
	}
	console.log("probe: all checks passed");
}

const timeoutHandle = setTimeout(() => {
	console.error(`probe: timed out after ${HANDSHAKE_TIMEOUT_MS}ms`);
	process.exit(2);
}, HANDSHAKE_TIMEOUT_MS * 4);
timeoutHandle.unref();

main().catch((err) => {
	console.error(`probe: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
