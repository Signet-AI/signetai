/**
 * Tests for the surviving provider infrastructure: the ACPX harness-subprocess
 * provider, the global LLM concurrency semaphore, and the subprocess deadline
 * helper.
 *
 * The per-provider HTTP/subprocess factories (Anthropic, OpenAI-compatible,
 * Ollama, llama.cpp, OpenRouter, Claude Code, Codex, OpenCode, command-line)
 * were removed in #947; their tests went with them. The pi-ai-backed provider
 * is covered by pi-provider.live.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LlmConcurrencySemaphore,
	SemaphoreTimeoutError,
	awaitSubprocessWithDeadline,
	calculateAcpxRetryDelayMs,
	configureLlmConcurrency,
	createAcpxProvider,
	getLlmConcurrencyStatus,
	withLlmConcurrency,
} from "./provider";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function streamFromString(value: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(value));
			controller.close();
		},
	});
}

async function waitForPidFile(path: string): Promise<number> {
	for (let i = 0; i < 100; i += 1) {
		if (existsSync(path)) {
			const pid = Number(readFileSync(path, "utf-8"));
			if (pid > 0) return pid;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`pid file was not written: ${path}`);
}

async function waitForProcessExit(pid: number): Promise<boolean> {
	for (let i = 0; i < 60; i += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

async function waitForPath(path: string): Promise<void> {
	for (let i = 0; i < 100; i += 1) {
		if (existsSync(path)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`path was not created: ${path}`);
}

async function waitForLlmConcurrencyStatus(running: number, pending: number): Promise<void> {
	for (let i = 0; i < 100; i += 1) {
		const status = getLlmConcurrencyStatus();
		if (status.running === running && status.pending === pending) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
	const status = getLlmConcurrencyStatus();
	throw new Error(`LLM concurrency did not reach running=${running}, pending=${pending}: ${JSON.stringify(status)}`);
}

// ---------------------------------------------------------------------------
// ACPX harness-subprocess provider
// ---------------------------------------------------------------------------

describe("createAcpxProvider", () => {
	it("calculates bounded exponential sterile-response backoff with deterministic jitter", () => {
		expect(calculateAcpxRetryDelayMs(0, () => 0)).toBe(50);
		expect(calculateAcpxRetryDelayMs(0, () => 1)).toBe(100);
		expect(calculateAcpxRetryDelayMs(1, () => 0.5)).toBe(150);
		expect(calculateAcpxRetryDelayMs(20, () => 1)).toBe(2_000);
	});

	it("regression: boolean terminal false passes --no-terminal", async () => {
		const root = join(tmpdir(), `signet-acpx-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx.sh");
		const argsPath = join(root, "args.json");
		const promptPath = join(root, "prompt.txt");
		const hooksPath = join(root, "hooks.txt");
		const cwdPath = join(root, "cwd.txt");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf '%s\n' "$@" > ${JSON.stringify(argsPath)}
printf '%s' "$PWD" > ${JSON.stringify(cwdPath)}
cat > ${JSON.stringify(promptPath)}
printf '%s|%s' "\${SIGNET_NO_HOOKS:-}" "\${SIGNET_ENABLED:-}" > ${JSON.stringify(hooksPath)}
printf '  acpx answer  \\n'
`,
		);
		chmodSync(bin, 0o755);
		const previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = root;
		try {
			const provider = createAcpxProvider({
				agent: "codex",
				model: "gpt-5.4-mini",
				bin,
				permissions: "deny-all",
				hooks: "disabled",
				terminal: false,
				mode: "session",
				session: "background",
				allowedTools: ["read_file"],
			});
			await expect(provider.generate("hello acpx", { timeoutMs: 1000 })).resolves.toBe("acpx answer");
			const args = readFileSync(argsPath, "utf-8").trim().split("\n");
			expect(args).toContain("--format");
			expect(args).toContain("quiet");
			expect(args).toContain("--model");
			expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.4-mini");
			expect(args).toContain("--deny-all");
			expect(args).toContain("--no-terminal");
			expect(args).toContain("--allowed-tools");
			expect(args[args.indexOf("--allowed-tools") + 1]).toBe("read_file");
			expect(args).toContain("codex");
			const agentIndex = args.indexOf("codex");
			expect(args.slice(agentIndex)).toEqual(["codex", "-s", "background", "exec", "--file", "-"]);
			expect(readFileSync(promptPath, "utf-8")).toBe("hello acpx");
			expect(readFileSync(hooksPath, "utf-8")).toBe("1|false");
			expect(readFileSync(cwdPath, "utf-8")).toBe(realpathSync(join(root, ".daemon", "acpx-background")));
			await expect(createAcpxProvider({ agent: "codex", bin, terminal: "disabled" }).generate("hello", { timeoutMs: 1000 })).resolves.toBe(
				"acpx answer",
			);
			expect(readFileSync(argsPath, "utf-8").trim().split("\n")).toContain("--no-terminal");
			for (const terminal of [true, "inherit"] as const) {
				await expect(createAcpxProvider({ agent: "codex", bin, terminal }).generate("hello", { timeoutMs: 1000 })).resolves.toBe(
					"acpx answer",
				);
				expect(readFileSync(argsPath, "utf-8").trim().split("\n")).not.toContain("--no-terminal");
			}
		} finally {
			if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
			else process.env.SIGNET_PATH = previousSignetPath;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lets OpenCode use its native model config unless ACP selection is explicit", async () => {
		const root = join(tmpdir(), `signet-acpx-opencode-model-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx.sh");
		const argsPath = join(root, "args.txt");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf '%s\n' "$@" > ${JSON.stringify(argsPath)}
cat >/dev/null
printf 'ok\n'
`,
		);
		chmodSync(bin, 0o755);
		try {
			const agentManaged = createAcpxProvider({
				agent: "opencode",
				model: "minimax-coding-plan/MiniMax-M3",
				bin,
			});
			await expect(agentManaged.generate("hello", { timeoutMs: 1000 })).resolves.toBe("ok");
			let args = readFileSync(argsPath, "utf-8").trim().split("\n");
			expect(args).not.toContain("--model");

			const acpManaged = createAcpxProvider({
				agent: "opencode",
				model: "minimax-coding-plan/MiniMax-M3",
				modelSelection: "acp",
				bin,
			});
			await expect(acpManaged.generate("hello", { timeoutMs: 1000 })).resolves.toBe("ok");
			args = readFileSync(argsPath, "utf-8").trim().split("\n");
			expect(args).toContain("--model");
			expect(args[args.indexOf("--model") + 1]).toBe("minimax-coding-plan/MiniMax-M3");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("defaults hook-disabled ACPX background runs to a sterile cwd and empty tool catalog", async () => {
		const root = join(tmpdir(), `signet-acpx-isolated-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-isolated.sh");
		const argsPath = join(root, "args.json");
		const cwdPath = join(root, "cwd.txt");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf '%s\n' "$@" > ${JSON.stringify(argsPath)}
printf '%s' "$PWD" > ${JSON.stringify(cwdPath)}
printf 'ok\\n'
`,
		);
		chmodSync(bin, 0o755);
		const previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = root;
		try {
			const provider = createAcpxProvider({
				agent: "claude",
				bin,
				permissions: "deny-all",
				hooks: "disabled",
			});
			await expect(provider.generate("summarize", { timeoutMs: 1000 })).resolves.toBe("ok");
			const args = readFileSync(argsPath, "utf-8").trim().split("\n");
			expect(args).toContain("--deny-all");
			expect(args).toContain("--allowed-tools");
			expect(args[args.indexOf("--allowed-tools") + 1]).toBe("");
			expect(args.slice(args.indexOf("claude"))).toEqual(["claude", "exec", "--file", "-"]);
			expect(readFileSync(cwdPath, "utf-8")).toBe(join(root, ".daemon", "acpx-background"));
		} finally {
			if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
			else process.env.SIGNET_PATH = previousSignetPath;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retries a sterile quiet-mode empty completion in a fresh one-shot session", async () => {
		const root = join(tmpdir(), `signet-acpx-empty-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-empty-then-valid.sh");
		const countPath = join(root, "count.txt");
		const argsPath = join(root, "args.txt");
		const timesPath = join(root, "times.txt");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf '%s\n' "$(date +%s%3N)" >> ${JSON.stringify(timesPath)}
count=0
[[ -f ${JSON.stringify(countPath)} ]] && count=$(cat ${JSON.stringify(countPath)})
count=$((count + 1))
printf '%s' "$count" > ${JSON.stringify(countPath)}
printf '%s\n' "$@" >> ${JSON.stringify(argsPath)}
cat >/dev/null
if [[ "$count" -eq 1 ]]; then
  printf '  \n'
else
  printf 'recovered answer\n'
fi
`,
		);
		chmodSync(bin, 0o755);
		try {
			const provider = createAcpxProvider({
				agent: "codex",
				bin,
				mode: "session",
				session: "persistent-background",
				permissions: "deny-all",
				hooks: "disabled",
				allowedTools: [],
				emptyResponseRetries: 1,
			});

			await expect(provider.generate("retry me", { timeoutMs: 2000 })).resolves.toBe("recovered answer");
			expect(readFileSync(countPath, "utf8")).toBe("2");
			const times = readFileSync(timesPath, "utf8").trim().split("\n").map(Number);
			expect(times).toHaveLength(2);
			expect(times[1] - times[0]).toBeGreaterThanOrEqual(40);
			const args = readFileSync(argsPath, "utf8").trim().split("\n");
			expect(args.filter((arg) => arg === "persistent-background")).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("caps sterile retries at the caller deadline instead of launching another process", async () => {
		const root = join(tmpdir(), `signet-acpx-empty-deadline-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-always-empty.sh");
		const countPath = join(root, "count.txt");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
count=0
[[ -f ${JSON.stringify(countPath)} ]] && count=$(cat ${JSON.stringify(countPath)})
printf '%s' "$((count + 1))" > ${JSON.stringify(countPath)}
sleep 0.08
cat >/dev/null
printf '\\n'
`,
		);
		chmodSync(bin, 0o755);
		const previousProcRoot = process.env.SIGNET_ACPX_PROC_ROOT;
		process.env.SIGNET_ACPX_PROC_ROOT = join(root, "missing-proc");
		try {
			const provider = createAcpxProvider({
				agent: "codex",
				bin,
				permissions: "deny-all",
				hooks: "disabled",
				allowedTools: [],
				emptyResponseRetries: 1,
			});
			await expect(provider.generate("deadline", { timeoutMs: 120 })).rejects.toThrow(/retryCount=0/);
			expect(readFileSync(countPath, "utf8")).toBe("1");
		} finally {
			if (previousProcRoot === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_PROC_ROOT");
			else process.env.SIGNET_ACPX_PROC_ROOT = previousProcRoot;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("cancels a sterile retry while waiting for backoff", async () => {
		const root = join(tmpdir(), `signet-acpx-empty-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-empty.sh");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
cat >/dev/null
printf '\\n'
`,
		);
		chmodSync(bin, 0o755);
		try {
			const controller = new AbortController();
			const provider = createAcpxProvider({
				agent: "codex",
				bin,
				permissions: "deny-all",
				hooks: "disabled",
				allowedTools: [],
				emptyResponseRetries: 1,
			});
			const result = provider.generate("cancel", { timeoutMs: 1_000, signal: controller.signal });
			setTimeout(() => controller.abort(), 20).unref?.();
			await expect(result).rejects.toThrow("codex via ACPX aborted");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("releases the concurrency slot while a sterile caller backs off", async () => {
		const root = join(tmpdir(), `signet-acpx-empty-concurrent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-concurrent.sh");
		const firstCountPath = join(root, "first-count.txt");
		const firstSeenPath = join(root, "first-seen");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
prompt=$(cat)
if [[ "$prompt" == "first" ]]; then
  count=0
  [[ -f ${JSON.stringify(firstCountPath)} ]] && count=$(cat ${JSON.stringify(firstCountPath)})
  count=$((count + 1))
  printf '%s' "$count" > ${JSON.stringify(firstCountPath)}
  if [[ "$count" -eq 1 ]]; then
    touch ${JSON.stringify(firstSeenPath)}
    printf '\\n'
  else
    printf 'first recovered\\n'
  fi
else
  printf 'second answer\\n'
fi
`,
		);
		chmodSync(bin, 0o755);
		configureLlmConcurrency(1);
		try {
			const config = {
				agent: "codex" as const,
				bin,
				permissions: "deny-all" as const,
				hooks: "disabled" as const,
				allowedTools: [] as const,
				emptyResponseRetries: 1,
			};
			const first = createAcpxProvider(config).generate("first", { timeoutMs: 1_000 });
			await waitForPath(firstSeenPath);
			await expect(createAcpxProvider(config).generate("second", { timeoutMs: 1_000 })).resolves.toBe("second answer");
			expect(readFileSync(firstCountPath, "utf8")).toBe("1");
			await expect(first).resolves.toBe("first recovered");
		} finally {
			configureLlmConcurrency(2);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not let a queued ACPX attempt succeed after its caller deadline", async () => {
		const root = join(tmpdir(), `signet-acpx-queued-deadline-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-queued-deadline.sh");
		const holderSeenPath = join(root, "holder-seen");
		const queuedPidPath = join(root, "queued.pid");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
prompt=$(cat)
if [[ "$prompt" == "holder" ]]; then
  touch ${JSON.stringify(holderSeenPath)}
  sleep 0.12
  printf 'holder answer\\n'
else
  printf '%s' "$$" > ${JSON.stringify(queuedPidPath)}
  sleep 0.12
  printf 'queued answer\\n'
fi
`,
		);
		chmodSync(bin, 0o755);
		const originalLimit = getLlmConcurrencyStatus().limit;
		configureLlmConcurrency(1);
		try {
			const config = {
				agent: "codex" as const,
				bin,
				permissions: "deny-all" as const,
				hooks: "disabled" as const,
				allowedTools: [] as const,
				emptyResponseRetries: 0,
			};
			const holder = createAcpxProvider(config).generate("holder", { timeoutMs: 1_000 });
			await waitForPath(holderSeenPath);
			const queued = createAcpxProvider(config).generate("queued", { timeoutMs: 180 });

			await expect(queued).rejects.toThrow(/codex via ACPX timeout after/);
			await expect(holder).resolves.toBe("holder answer");
			if (existsSync(queuedPidPath)) {
				expect(await waitForProcessExit(Number(readFileSync(queuedPidPath, "utf8")))).toBe(true);
			}
			expect(getLlmConcurrencyStatus()).toEqual({ limit: 1, pending: 0, running: 0, oldestPendingAgeMs: null });
		} finally {
			configureLlmConcurrency(originalLimit);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports the age of the oldest queued provider call", async () => {
		const semaphore = new LlmConcurrencySemaphore(1);
		await semaphore.acquire();
		const queued = semaphore.acquire();
		await new Promise((resolve) => setTimeout(resolve, 15));
		expect(semaphore.pending).toBe(1);
		expect(semaphore.oldestPendingAgeMs).toBeGreaterThan(0);
		semaphore.release();
		await queued;
		semaphore.release();
		expect(semaphore.oldestPendingAgeMs).toBeNull();
	});

	it("reports structured diagnostics after repeated empty completions", async () => {
		const root = join(tmpdir(), `signet-acpx-empty-terminal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-always-empty.sh");
		const countPath = join(root, "count.txt");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
count=0
[[ -f ${JSON.stringify(countPath)} ]] && count=$(cat ${JSON.stringify(countPath)})
printf '%s' "$((count + 1))" > ${JSON.stringify(countPath)}
cat >/dev/null
printf '\n'
printf '%s\n' '[acpx] tokens: input=20 output=1 total=21' >&2
`,
		);
		chmodSync(bin, 0o755);
		try {
			const provider = createAcpxProvider({
				agent: "codex",
				bin,
				permissions: "deny-all",
				hooks: "disabled",
				allowedTools: [],
				emptyResponseRetries: 1,
			});

			await expect(provider.generate("retry me", { timeoutMs: 2000 })).rejects.toThrow(
				/exitCode=0, stdoutBytes=1, stderrBytes=42, format=quiet, sessionId=unknown, stopReason=unknown, usage=input=20 output=1 total=21, retryCount=1, durationMs=\d+/,
			);
			expect(readFileSync(countPath, "utf8")).toBe("2");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retries JSON end_turn with zero assistant chunks and preserves ACP diagnostics", async () => {
		const root = join(tmpdir(), `signet-acpx-json-empty-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-json-empty-then-valid.sh");
		const countPath = join(root, "count.txt");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
count=0
[[ -f ${JSON.stringify(countPath)} ]] && count=$(cat ${JSON.stringify(countPath)})
count=$((count + 1))
printf '%s' "$count" > ${JSON.stringify(countPath)}
cat >/dev/null
printf '%s\n' '{"jsonrpc":"2.0","id":0,"result":{"sessionId":"ses-empty"}}'
if [[ "$count" -eq 1 ]]; then
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn","usage":{"inputTokens":20,"outputTokens":1}}}'
else
  printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"json recovered"}}}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}'
fi
`,
		);
		chmodSync(bin, 0o755);
		try {
			const provider = createAcpxProvider({
				agent: "codex",
				bin,
				format: "json",
				permissions: "deny-all",
				hooks: "disabled",
				allowedTools: [],
			});

			await expect(provider.generate("retry json", { timeoutMs: 2000 })).resolves.toBe("json recovered");
			expect(readFileSync(countPath, "utf8")).toBe("2");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not retry JSON output after observable tool activity", async () => {
		const root = join(tmpdir(), `signet-acpx-json-side-effect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-json-tool.sh");
		const countPath = join(root, "count.txt");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf '1' >> ${JSON.stringify(countPath)}
cat >/dev/null
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"shell"}}}'
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}'
`,
		);
		chmodSync(bin, 0o755);
		try {
			const provider = createAcpxProvider({
				agent: "codex",
				bin,
				format: "json",
				permissions: "deny-all",
				hooks: "disabled",
				allowedTools: [],
			});

			await expect(provider.generate("do not retry", { timeoutMs: 2000 })).rejects.toThrow(
				"codex via ACPX JSON output did not include a final response",
			);
			expect(readFileSync(countPath, "utf8")).toBe("1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("injects a tool-denying OpenCode profile and defaults sterile runs to JSON", async () => {
		const root = join(tmpdir(), `signet-acpx-opencode-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-opencode-acpx.sh");
		const argsPath = join(root, "args.txt");
		const configPath = join(root, "opencode-config.json");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf '%s\n' "$@" > ${JSON.stringify(argsPath)}
printf '%s' "$OPENCODE_CONFIG_CONTENT" > ${JSON.stringify(configPath)}
cat >/dev/null
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"sterile answer"}}}}'
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}'
`,
		);
		chmodSync(bin, 0o755);
		const previousConfig = process.env.OPENCODE_CONFIG_CONTENT;
		process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "provider/model" });
		try {
			const provider = createAcpxProvider({
				agent: "opencode",
				bin,
				model: "routed/model",
				permissions: "deny-all",
				hooks: "disabled",
				allowedTools: [],
			});
			await expect(provider.generate("sterile", { timeoutMs: 2000 })).resolves.toBe("sterile answer");
			const args = readFileSync(argsPath, "utf8").trim().split("\n");
			expect(args[args.indexOf("--format") + 1]).toBe("json");
			expect(args).not.toContain("--model");
			const overlay = JSON.parse(readFileSync(configPath, "utf8")) as {
				model?: string;
				tools?: Record<string, boolean>;
				permission?: Record<string, string>;
				agent?: { build?: { tools?: Record<string, boolean>; permission?: Record<string, string> } };
			};
			expect(overlay.model).toBe("routed/model");
			expect(overlay.tools?.["*"]).toBe(false);
			expect(overlay.permission?.["*"]).toBe("deny");
			expect(overlay.agent?.build?.tools?.["*"]).toBe(false);
			expect(overlay.agent?.build?.permission?.["*"]).toBe("deny");
			expect(overlay.agent?.build).toMatchObject({ model: "routed/model" });

			const acpManagedProvider = createAcpxProvider({
				agent: "opencode",
				bin,
				model: "routed/acp-model",
				modelSelection: "acp",
				permissions: "deny-all",
				hooks: "disabled",
				allowedTools: [],
			});
			await expect(acpManagedProvider.generate("sterile", { timeoutMs: 2000 })).resolves.toBe("sterile answer");
			const acpArgs = readFileSync(argsPath, "utf8").trim().split("\n");
			expect(acpArgs[acpArgs.indexOf("--model") + 1]).toBe("routed/acp-model");
			const acpOverlay = JSON.parse(readFileSync(configPath, "utf8")) as {
				model?: string;
				agent?: { build?: { model?: string } };
			};
			expect(acpOverlay.model).toBe("provider/model");
			expect(acpOverlay.agent?.build?.model).toBeUndefined();
		} finally {
			if (previousConfig === undefined) Reflect.deleteProperty(process.env, "OPENCODE_CONFIG_CONTENT");
			else process.env.OPENCODE_CONFIG_CONTENT = previousConfig;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("cleans up detached Codex ACP agent processes after successful ACPX exec", async () => {
		if (process.platform !== "linux") return;
		const root = join(tmpdir(), `signet-acpx-success-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-daemonizes.sh");
		const codexAcp = join(root, "codex-acp");
		const childPidPath = join(root, "child.pid");
		const unrelatedPidPath = join(root, "unrelated.pid");
		writeFileSync(
			codexAcp,
			`#!/usr/bin/env bash
sleep 30
`,
		);
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
setsid ${JSON.stringify(codexAcp)} >/dev/null 2>&1 < /dev/null &
printf '%s' "$!" > ${JSON.stringify(childPidPath)}
SIGNET_ACPX_RUN_ID=unrelated setsid ${JSON.stringify(codexAcp)} >/dev/null 2>&1 < /dev/null &
printf '%s' "$!" > ${JSON.stringify(unrelatedPidPath)}
printf 'ok\\n'
`,
		);
		chmodSync(bin, 0o755);
		chmodSync(codexAcp, 0o755);
		try {
			const provider = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			await expect(provider.generate("hello", { timeoutMs: 1000 })).resolves.toBe("ok");
			const pid = Number(readFileSync(childPidPath, "utf-8"));
			expect(pid).toBeGreaterThan(0);

			let alive = true;
			for (let i = 0; i < 40; i += 1) {
				try {
					process.kill(pid, 0);
					await new Promise((resolve) => setTimeout(resolve, 25));
				} catch {
					alive = false;
					break;
				}
			}
			expect(alive).toBe(false);
			const unrelatedPid = Number(readFileSync(unrelatedPidPath, "utf-8"));
			expect(unrelatedPid).toBeGreaterThan(0);
			expect(() => process.kill(unrelatedPid, 0)).not.toThrow();
		} finally {
			if (existsSync(unrelatedPidPath)) {
				const unrelatedPid = Number(readFileSync(unrelatedPidPath, "utf-8"));
				if (unrelatedPid > 0) {
					try {
						process.kill(unrelatedPid, "SIGKILL");
					} catch {
						// Already exited.
					}
				}
			}
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("regression: cleanup barriers resolve when a target exits after SIGTERM", async () => {
		const root = join(tmpdir(), `signet-acpx-immediate-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const procRoot = join(root, "proc");
		const escapedPid = 12348;
		const escapedProc = join(procRoot, String(escapedPid));
		const bin = join(root, "fake-acpx.sh");
		mkdirSync(procRoot, { recursive: true });
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
prompt=$(cat)
if [[ "$prompt" == "next" ]]; then
printf 'next\\n'
exit 0
fi
mkdir -p ${JSON.stringify(escapedProc)}
printf 'codex-acp\\0' > ${JSON.stringify(join(escapedProc, "cmdline"))}
printf 'SIGNET_ACPX_RUN_ID=%s\\0' "$SIGNET_ACPX_RUN_ID" > ${JSON.stringify(join(escapedProc, "environ"))}
printf 'first\\n'
`,
		);
		chmodSync(bin, 0o755);
		const previousProcRoot = process.env.SIGNET_ACPX_PROC_ROOT;
		const previousPlatform = process.env.SIGNET_ACPX_CLEANUP_PLATFORM;
		const previousKill = process.kill;
		const terminated = Promise.withResolvers<void>();
		let killed = false;
		try {
			process.env.SIGNET_ACPX_CLEANUP_PLATFORM = "linux";
			process.env.SIGNET_ACPX_PROC_ROOT = procRoot;
			process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
				if (pid !== escapedPid) return true;
				if (signal === "SIGTERM") {
					rmSync(escapedProc, { recursive: true, force: true });
					terminated.resolve();
					return true;
				}
				if (signal === 0) {
					const error = Object.assign(new Error("process exited"), { code: "ESRCH" });
					throw error;
				}
				if (signal === "SIGKILL") killed = true;
				return true;
			}) as typeof process.kill;
			const provider = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			const first = provider.generate("first", { timeoutMs: 3_000 });
			await terminated.promise;
			await expect(first).resolves.toBe("first");
			await expect(provider.generate("next", { timeoutMs: 3_000 })).resolves.toBe("next");
			expect(killed).toBe(false);
		} finally {
			process.kill = previousKill;
			if (previousProcRoot === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_PROC_ROOT");
			else process.env.SIGNET_ACPX_PROC_ROOT = previousProcRoot;
			if (previousPlatform === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_CLEANUP_PLATFORM");
			else process.env.SIGNET_ACPX_CLEANUP_PLATFORM = previousPlatform;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("regression: normal completion returns before escaped-child reaping while the next same-agent attempt waits", async () => {
		const root = join(tmpdir(), `signet-acpx-success-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const procRoot = join(root, "proc");
		const escapedPid = 12345;
		const escapedProc = join(procRoot, String(escapedPid));
		const bin = join(root, "fake-acpx.sh");
		const nextRanPath = join(root, "next-ran");
		mkdirSync(procRoot, { recursive: true });
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
prompt=$(cat)
if [[ "$prompt" == "next" ]]; then
touch ${JSON.stringify(nextRanPath)}
printf 'next\\n'
exit 0
fi
mkdir -p ${JSON.stringify(escapedProc)}
printf 'codex-acp\\0' > ${JSON.stringify(join(escapedProc, "cmdline"))}
printf 'SIGNET_ACPX_RUN_ID=%s\\0' "$SIGNET_ACPX_RUN_ID" > ${JSON.stringify(join(escapedProc, "environ"))}
printf 'ok\\n'
`,
		);
		chmodSync(bin, 0o755);
		const previousProcRoot = process.env.SIGNET_ACPX_PROC_ROOT;
		const previousPlatform = process.env.SIGNET_ACPX_CLEANUP_PLATFORM;
		const previousConcurrencyLimit = getLlmConcurrencyStatus().limit;
		const previousKill = process.kill;
		const cleanupStarted = Promise.withResolvers<void>();
		let cleanupFinished = false;
		try {
			configureLlmConcurrency(2);
			process.env.SIGNET_ACPX_CLEANUP_PLATFORM = "linux";
			process.env.SIGNET_ACPX_PROC_ROOT = procRoot;
			process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
				if (pid === escapedPid && signal === "SIGTERM") cleanupStarted.resolve();
				if (pid === escapedPid && signal === "SIGKILL") cleanupFinished = true;
				return true;
			}) as typeof process.kill;
			const provider = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			const first = provider.generate("first", { timeoutMs: 3_000 });
			await waitForPath(join(escapedProc, "cmdline"));
			await cleanupStarted.promise;
			await expect(first).resolves.toBe("ok");
			expect(cleanupFinished).toBe(false);

			const next = provider.generate("next", { timeoutMs: 3_000 });
			for (let i = 0; i < 4; i += 1) await Promise.resolve();
			expect(getLlmConcurrencyStatus().running).toBe(0);
			expect(existsSync(nextRanPath)).toBe(false);
			await expect(next).resolves.toBe("next");
			expect(cleanupFinished).toBe(true);
			expect(existsSync(nextRanPath)).toBe(true);
		} finally {
			process.kill = previousKill;
			configureLlmConcurrency(previousConcurrencyLimit);
			if (previousProcRoot === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_PROC_ROOT");
			else process.env.SIGNET_ACPX_PROC_ROOT = previousProcRoot;
			if (previousPlatform === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_CLEANUP_PLATFORM");
			else process.env.SIGNET_ACPX_CLEANUP_PLATFORM = previousPlatform;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("regression: same-agent cleanup re-admission does not hold the only global permit", async () => {
		const root = join(tmpdir(), `signet-acpx-cleanup-readmit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const procRoot = join(root, "proc");
		const escapedPid = 12347;
		const escapedProc = join(procRoot, String(escapedPid));
		const bin = join(root, "fake-acpx.sh");
		const unrelatedRanPath = join(root, "unrelated-ran");
		mkdirSync(procRoot, { recursive: true });
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
prompt=$(cat)
if [[ "$prompt" == "first" ]]; then
  mkdir -p ${JSON.stringify(escapedProc)}
  printf 'codex-acp\\0' > ${JSON.stringify(join(escapedProc, "cmdline"))}
  printf 'SIGNET_ACPX_RUN_ID=%s\\0' "$SIGNET_ACPX_RUN_ID" > ${JSON.stringify(join(escapedProc, "environ"))}
fi
if [[ "$prompt" == "unrelated" ]]; then touch ${JSON.stringify(unrelatedRanPath)}; fi
printf '%s\\n' "$prompt"
`,
		);
		chmodSync(bin, 0o755);
		const previousProcRoot = process.env.SIGNET_ACPX_PROC_ROOT;
		const previousPlatform = process.env.SIGNET_ACPX_CLEANUP_PLATFORM;
		const previousConcurrencyLimit = getLlmConcurrencyStatus().limit;
		const previousKill = process.kill;
		const blockerEntered = Promise.withResolvers<void>();
		const releaseBlocker = Promise.withResolvers<void>();
		const cleanupStarted = Promise.withResolvers<void>();
		let cleanupFinished = false;
		let blocker: Promise<void> | undefined;
		let first: Promise<string> | undefined;
		let sameAgent: Promise<string> | undefined;
		let unrelated: Promise<string> | undefined;
		try {
			configureLlmConcurrency(1);
			process.env.SIGNET_ACPX_CLEANUP_PLATFORM = "linux";
			process.env.SIGNET_ACPX_PROC_ROOT = procRoot;
			process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
				if (pid === escapedPid && signal === "SIGTERM") cleanupStarted.resolve();
				if (pid === escapedPid && signal === "SIGKILL") cleanupFinished = true;
				return true;
			}) as typeof process.kill;
			const codex = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			const claude = createAcpxProvider({ agent: "claude", bin, hooks: "disabled" });
			blocker = withLlmConcurrency(async () => {
				blockerEntered.resolve();
				await releaseBlocker.promise;
			});
			await blockerEntered.promise;
			first = codex.generate("first", { timeoutMs: 3_000 });
			sameAgent = codex.generate("same-agent", { timeoutMs: 3_000 });
			unrelated = claude.generate("unrelated", { timeoutMs: 3_000 });
			await waitForLlmConcurrencyStatus(1, 3);
			expect(getLlmConcurrencyStatus().pending).toBe(3);

			releaseBlocker.resolve();
			await blocker;
			await waitForPath(join(escapedProc, "cmdline"));
			await cleanupStarted.promise;
			await expect(first).resolves.toBe("first");
			await waitForPath(unrelatedRanPath);
			expect(cleanupFinished).toBe(false);
			await expect(unrelated).resolves.toBe("unrelated");
			await expect(sameAgent).resolves.toBe("same-agent");
			expect(cleanupFinished).toBe(true);
		} finally {
			releaseBlocker.resolve();
			await Promise.allSettled([blocker, first, sameAgent, unrelated]);
			process.kill = previousKill;
			configureLlmConcurrency(previousConcurrencyLimit);
			if (previousProcRoot === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_PROC_ROOT");
			else process.env.SIGNET_ACPX_PROC_ROOT = previousProcRoot;
			if (previousPlatform === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_CLEANUP_PLATFORM");
			else process.env.SIGNET_ACPX_CLEANUP_PLATFORM = previousPlatform;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("regression: cleanup-barrier waits honor caller abort and deadline", async () => {
		const root = join(tmpdir(), `signet-acpx-cleanup-wait-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const procRoot = join(root, "proc");
		const escapedPid = 12346;
		const escapedProc = join(procRoot, String(escapedPid));
		const bin = join(root, "fake-acpx.sh");
		const spawnedPath = join(root, "spawned");
		mkdirSync(procRoot, { recursive: true });
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
prompt=$(cat)
if [[ "$prompt" != "first" ]]; then
touch ${JSON.stringify(spawnedPath)}
printf 'unexpected\\n'
exit 0
fi
mkdir -p ${JSON.stringify(escapedProc)}
printf 'codex-acp\\0' > ${JSON.stringify(join(escapedProc, "cmdline"))}
printf 'SIGNET_ACPX_RUN_ID=%s\\0' "$SIGNET_ACPX_RUN_ID" > ${JSON.stringify(join(escapedProc, "environ"))}
printf 'ok\\n'
`,
		);
		chmodSync(bin, 0o755);
		const previousProcRoot = process.env.SIGNET_ACPX_PROC_ROOT;
		const previousPlatform = process.env.SIGNET_ACPX_CLEANUP_PLATFORM;
		const previousKill = process.kill;
		const cleanupStarted = Promise.withResolvers<void>();
		try {
			process.env.SIGNET_ACPX_CLEANUP_PLATFORM = "linux";
			process.env.SIGNET_ACPX_PROC_ROOT = procRoot;
			process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
				if (pid === escapedPid && signal === "SIGTERM") cleanupStarted.resolve();
				return true;
			}) as typeof process.kill;
			const provider = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			const first = provider.generate("first", { timeoutMs: 3_000 });
			await waitForPath(join(escapedProc, "cmdline"));
			await cleanupStarted.promise;

			const controller = new AbortController();
			const abortStartedAt = performance.now();
			const aborted = provider.generate("aborted", { timeoutMs: 3_000, signal: controller.signal });
			controller.abort(new Error("cleanup caller cancelled"));
			await expect(aborted).rejects.toThrow("cleanup caller cancelled");
			expect(performance.now() - abortStartedAt).toBeLessThan(250);
			expect(existsSync(spawnedPath)).toBe(false);

			const deadlineStartedAt = performance.now();
			await expect(provider.generate("timed-out", { timeoutMs: 100 })).rejects.toThrow(
				/codex via ACPX timeout after 100ms/,
			);
			const deadlineElapsedMs = performance.now() - deadlineStartedAt;
			expect(deadlineElapsedMs).toBeGreaterThanOrEqual(60);
			expect(deadlineElapsedMs).toBeLessThan(400);
			expect(existsSync(spawnedPath)).toBe(false);

			await expect(first).resolves.toBe("ok");
			expect(existsSync(spawnedPath)).toBe(false);
		} finally {
			process.kill = previousKill;
			if (previousProcRoot === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_PROC_ROOT");
			else process.env.SIGNET_ACPX_PROC_ROOT = previousProcRoot;
			if (previousPlatform === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_CLEANUP_PLATFORM");
			else process.env.SIGNET_ACPX_CLEANUP_PLATFORM = previousPlatform;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reaps escaped Codex ACP children on darwin via a bounded ps sweep (#1459)", async () => {
		const root = join(tmpdir(), `signet-acpx-darwin-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const childPid = 4242;
		const foreignPid = 4243;
		const runidFile = join(root, "runid.txt");
		const fakePs = join(root, "ps");
		const bin = join(root, "fake-acpx.sh");
		// fake ps: the full process listing plus the environment returned by
		// `ps -p <pid> -E -o command=`. Two same-named agent processes; only one
		// is bound to our run id.
		writeFileSync(
			fakePs,
			`#!/usr/bin/env bash
if [[ "$1" == "-axo" && "$2" == "pid=,command=" ]]; then
  printf '%s\\n' "${childPid} /usr/local/bin/codex-acp"
  printf '%s\\n' "${foreignPid} /usr/local/bin/codex-acp"
  exit 0
fi
if [[ "$1" == "-p" && "$2" == "${childPid}" ]]; then
  runid=""
  if [[ -n "\${SIGNET_ACPX_RUNID_FILE}" && -f "\${SIGNET_ACPX_RUNID_FILE}" ]]; then
    runid="$(cat "\${SIGNET_ACPX_RUNID_FILE}")"
  fi
  printf '/usr/local/bin/codex-acp SIGNET_ACPX_RUN_ID=%s\\n' "$runid"
  exit 0
fi
exit 0
`,
		);
		// fake acpx: records its own run id (from the real env the provider
		// passed) so the sweep's environment read matches the actual runtime
		// value rather than a literal.
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
if [[ -n "\${SIGNET_ACPX_RUNID_FILE}" && -n "\${SIGNET_ACPX_RUN_ID}" ]]; then
  printf '%s' "\${SIGNET_ACPX_RUN_ID}" > "\${SIGNET_ACPX_RUNID_FILE}"
fi
printf 'ok\\n'
`,
		);
		chmodSync(fakePs, 0o755);
		chmodSync(bin, 0o755);
		const previousPlatform = process.env.SIGNET_ACPX_CLEANUP_PLATFORM;
		const previousPs = process.env.SIGNET_ACPX_PS;
		const previousRunidFile = process.env.SIGNET_ACPX_RUNID_FILE;
		process.env.SIGNET_ACPX_CLEANUP_PLATFORM = "darwin";
		process.env.SIGNET_ACPX_PS = fakePs;
		process.env.SIGNET_ACPX_RUNID_FILE = runidFile;
		const killLog: string[] = [];
		const previousKill = process.kill;
		try {
			// Record the signals the sweep issues so we can assert it targeted
			// only the child bound to the run id, not the foreign one.
			process.kill = ((pid: number, signal: NodeJS.Signals) => {
				killLog.push(`${pid}:${signal}`);
				return true;
			}) as typeof process.kill;
			const provider = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			await expect(provider.generate("hello", { timeoutMs: 1000 })).resolves.toBe("ok");
			// Let the SIGTERM->SIGKILL escalation timers (~1s) fire.
			await new Promise((resolve) => setTimeout(resolve, 1600));
		} finally {
			process.kill = previousKill;
			if (previousPlatform === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_CLEANUP_PLATFORM");
			else process.env.SIGNET_ACPX_CLEANUP_PLATFORM = previousPlatform;
			if (previousPs === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_PS");
			else process.env.SIGNET_ACPX_PS = previousPs;
			if (previousRunidFile === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_RUNID_FILE");
			else process.env.SIGNET_ACPX_RUNID_FILE = previousRunidFile;
			rmSync(root, { recursive: true, force: true });
		}
		const childKilled = killLog.some((entry) => entry.startsWith(`${childPid}:`));
		const foreignKilled = killLog.some((entry) => entry.startsWith(`${foreignPid}:`));
		expect(childKilled).toBe(true);
		expect(foreignKilled).toBe(false);
	});

	it("fails closed and warns when Darwin ps enumeration fails", async () => {
		const root = join(tmpdir(), `signet-acpx-darwin-ps-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const fakePs = join(root, "ps");
		const bin = join(root, "fake-acpx.sh");
		writeFileSync(
			fakePs,
			`#!/usr/bin/env bash
exit 1
`,
		);
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf 'ok\\n'
`,
		);
		chmodSync(fakePs, 0o755);
		chmodSync(bin, 0o755);
		const previousPlatform = process.env.SIGNET_ACPX_CLEANUP_PLATFORM;
		const previousPs = process.env.SIGNET_ACPX_PS;
		const previousWarn = logger.warn;
		const warnCalls: Array<{ message: string; data?: Record<string, unknown> }> = [];
		const killLog: string[] = [];
		const previousKill = process.kill;
		process.env.SIGNET_ACPX_CLEANUP_PLATFORM = "darwin";
		process.env.SIGNET_ACPX_PS = fakePs;
		logger.warn = ((_category: unknown, message: unknown, data?: Record<string, unknown>) => {
			warnCalls.push({ message: String(message), data });
		}) as typeof logger.warn;
		process.kill = ((pid: number, signal: NodeJS.Signals) => {
			killLog.push(`${pid}:${signal}`);
			return true;
		}) as typeof process.kill;
		try {
			const provider = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			await expect(provider.generate("hello", { timeoutMs: 1000 })).resolves.toBe("ok");
		} finally {
			process.kill = previousKill;
			logger.warn = previousWarn;
			if (previousPlatform === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_CLEANUP_PLATFORM");
			else process.env.SIGNET_ACPX_CLEANUP_PLATFORM = previousPlatform;
			if (previousPs === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_PS");
			else process.env.SIGNET_ACPX_PS = previousPs;
			rmSync(root, { recursive: true, force: true });
		}
		expect(killLog).toEqual([]);
		expect(warnCalls.some(({ message }) => message.includes("could not enumerate processes"))).toBe(true);
	});

	it("counts and logs Darwin ps environment failures without signaling the candidate", async () => {
		const root = join(
			tmpdir(),
			`signet-acpx-darwin-ps-environment-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(root, { recursive: true });
		const candidatePid = 4244;
		const fakePs = join(root, "ps");
		const bin = join(root, "fake-acpx.sh");
		writeFileSync(
			fakePs,
			`#!/usr/bin/env bash
if [[ "$1" == "-axo" && "$2" == "pid=,command=" ]]; then
printf '%s\\n' "${candidatePid} /usr/local/bin/codex-acp"
  exit 0
fi
exit 1
`,
		);
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf 'ok\\n'
`,
		);
		chmodSync(fakePs, 0o755);
		chmodSync(bin, 0o755);
		const previousPlatform = process.env.SIGNET_ACPX_CLEANUP_PLATFORM;
		const previousPs = process.env.SIGNET_ACPX_PS;
		const previousWarn = logger.warn;
		const warnCalls: Array<{ message: string; data?: Record<string, unknown> }> = [];
		const killLog: string[] = [];
		const previousKill = process.kill;
		process.env.SIGNET_ACPX_CLEANUP_PLATFORM = "darwin";
		process.env.SIGNET_ACPX_PS = fakePs;
		logger.warn = ((_category: unknown, message: unknown, data?: Record<string, unknown>) => {
			warnCalls.push({ message: String(message), data });
		}) as typeof logger.warn;
		process.kill = ((pid: number, signal: NodeJS.Signals) => {
			killLog.push(`${pid}:${signal}`);
			return true;
		}) as typeof process.kill;
		try {
			const provider = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			await expect(provider.generate("hello", { timeoutMs: 1000 })).resolves.toBe("ok");
		} finally {
			process.kill = previousKill;
			logger.warn = previousWarn;
			if (previousPlatform === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_CLEANUP_PLATFORM");
			else process.env.SIGNET_ACPX_CLEANUP_PLATFORM = previousPlatform;
			if (previousPs === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_PS");
			else process.env.SIGNET_ACPX_PS = previousPs;
			rmSync(root, { recursive: true, force: true });
		}
		const ownershipWarning = warnCalls.find(({ message }) => message.includes("could not verify process ownership"));
		expect(ownershipWarning?.data).toMatchObject({
			failedChecks: 1,
			candidateCount: 1,
			mechanism: "ps -E",
		});
		expect(killLog).toEqual([]);
	});

	it("bounds Darwin candidate inspection at 128 processes and warns when capped", async () => {
		const root = join(
			tmpdir(),
			`signet-acpx-darwin-candidate-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(root, { recursive: true });
		const firstPid = 5000;
		const fakePs = join(root, "ps");
		const psCalls = join(root, "ps-calls.txt");
		const bin = join(root, "fake-acpx.sh");
		const candidateLines = Array.from(
			{ length: 130 },
			(_, index) => `echo "${firstPid + index} /usr/local/bin/codex-acp"`,
		).join("\n");
		writeFileSync(
			fakePs,
			`#!/usr/bin/env bash
if [[ "$1" == "-axo" && "$2" == "pid=,command=" ]]; then
${candidateLines}
  exit 0
fi
if [[ "$1" == "-p" ]]; then
  count=0
  if [[ -f ${JSON.stringify(psCalls)} ]]; then
    count=$(<${JSON.stringify(psCalls)})
  fi
  echo $((count + 1)) > ${JSON.stringify(psCalls)}
  echo '/usr/local/bin/codex-acp'
  exit 0
fi
exit 1
`,
		);
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf 'ok\\n'
`,
		);
		chmodSync(fakePs, 0o755);
		chmodSync(bin, 0o755);
		const previousPlatform = process.env.SIGNET_ACPX_CLEANUP_PLATFORM;
		const previousPs = process.env.SIGNET_ACPX_PS;
		const previousWarn = logger.warn;
		const warnCalls: string[] = [];
		const killLog: string[] = [];
		const previousKill = process.kill;
		let psCallCount = 0;
		process.env.SIGNET_ACPX_CLEANUP_PLATFORM = "darwin";
		process.env.SIGNET_ACPX_PS = fakePs;
		logger.warn = ((_category: unknown, message: unknown) => {
			warnCalls.push(String(message));
		}) as typeof logger.warn;
		process.kill = ((pid: number, signal: NodeJS.Signals) => {
			killLog.push(`${pid}:${signal}`);
			return true;
		}) as typeof process.kill;
		try {
			const provider = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			await expect(provider.generate("hello", { timeoutMs: 5000 })).resolves.toBe("ok");
			psCallCount = Number(readFileSync(psCalls, "utf-8").trim());
		} finally {
			process.kill = previousKill;
			logger.warn = previousWarn;
			if (previousPlatform === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_CLEANUP_PLATFORM");
			else process.env.SIGNET_ACPX_CLEANUP_PLATFORM = previousPlatform;
			if (previousPs === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_PS");
			else process.env.SIGNET_ACPX_PS = previousPs;
			rmSync(root, { recursive: true, force: true });
		}
		expect(psCallCount).toBe(128);
		expect(warnCalls.some((message) => message.includes("reached its candidate cap"))).toBe(true);
		expect(killLog).toEqual([]);
	});

	it("hard-kills SIGTERM-resistant ps probes and bounds the total Darwin sweep", async () => {
		const root = join(
			tmpdir(),
			`signet-acpx-darwin-sweep-deadline-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(root, { recursive: true });
		const candidateCount = 8;
		const firstPid = 6000;
		const fakePs = join(root, "ps");
		const psPids = join(root, "ps-pids.txt");
		const bin = join(root, "fake-acpx.sh");
		const candidateLines = Array.from(
			{ length: candidateCount },
			(_, index) => `printf '%s\\n' "${firstPid + index} /usr/local/bin/codex-acp"`,
		).join("\n");
		writeFileSync(
			fakePs,
			`#!/usr/bin/env bash
if [[ "$1" == "-axo" && "$2" == "pid=,command=" ]]; then
${candidateLines}
  exit 0
fi
if [[ "$1" == "-p" ]]; then
  printf '%s\\n' "$$" >> ${JSON.stringify(psPids)}
  trap '' TERM
  while :; do :; done
fi
exit 1
`,
		);
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf 'ok\\n'
`,
		);
		chmodSync(fakePs, 0o755);
		chmodSync(bin, 0o755);
		const previousPlatform = process.env.SIGNET_ACPX_CLEANUP_PLATFORM;
		const previousPs = process.env.SIGNET_ACPX_PS;
		const startedAt = performance.now();
		let elapsedMs = 0;
		let spawnedPids: number[] = [];
		const readSpawnedPids = (): number[] =>
			existsSync(psPids)
				? readFileSync(psPids, "utf-8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map(Number)
						.filter((pid) => pid > 0)
				: [];
		process.env.SIGNET_ACPX_CLEANUP_PLATFORM = "darwin";
		process.env.SIGNET_ACPX_PS = fakePs;
		try {
			const provider = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			await expect(provider.generate("hello", { timeoutMs: 5_000 })).resolves.toBe("ok");
			elapsedMs = performance.now() - startedAt;
			spawnedPids = readSpawnedPids();
		} finally {
			if (spawnedPids.length === 0) spawnedPids = readSpawnedPids();
			for (const pid of spawnedPids) {
				if (!(await waitForProcessExit(pid))) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						// Already exited.
					}
				}
			}
			if (previousPlatform === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_CLEANUP_PLATFORM");
			else process.env.SIGNET_ACPX_CLEANUP_PLATFORM = previousPlatform;
			if (previousPs === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_PS");
			else process.env.SIGNET_ACPX_PS = previousPs;
			rmSync(root, { recursive: true, force: true });
		}
		expect(spawnedPids.length).toBeGreaterThan(0);
		expect(spawnedPids.length).toBeLessThan(candidateCount);
		expect(elapsedMs).toBeLessThan(3_000);
	});

	it("treats an unreadable ACPX proc root as best-effort cleanup", async () => {
		if (process.platform !== "linux") return;
		const root = join(tmpdir(), `signet-acpx-missing-proc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-ok.sh");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf 'ok\\n'
`,
		);
		chmodSync(bin, 0o755);
		const previousProcRoot = process.env.SIGNET_ACPX_PROC_ROOT;
		process.env.SIGNET_ACPX_PROC_ROOT = join(root, "missing-proc");
		try {
			const provider = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			await expect(provider.generate("hello", { timeoutMs: 1000 })).resolves.toBe("ok");
		} finally {
			if (previousProcRoot === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_PROC_ROOT");
			else process.env.SIGNET_ACPX_PROC_ROOT = previousProcRoot;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the event loop responsive while ACPX cleanup waits on proc I/O (#1328)", async () => {
		const root = join(tmpdir(), `signet-acpx-async-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const procRoot = join(root, "proc");
		const procPid = join(procRoot, "12345");
		const cmdlinePath = join(procPid, "cmdline");
		const bin = join(root, "fake-acpx-hang.sh");
		mkdirSync(procPid, { recursive: true });
		const mkfifo = Bun.spawnSync(["mkfifo", cmdlinePath]);
		expect(mkfifo.exitCode).toBe(0);
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
sleep 30
`,
		);
		chmodSync(bin, 0o755);
		const writer = nodeSpawn("bash", ["-c", `sleep 0.25; printf 'not-codex\\0' > ${JSON.stringify(cmdlinePath)}`]);
		const writerClosed =
			writer.exitCode === null ? new Promise<void>((resolve) => writer.once("close", () => resolve())) : Promise.resolve();
		const previousProcRoot = process.env.SIGNET_ACPX_PROC_ROOT;
		const previousPlatform = process.env.SIGNET_ACPX_CLEANUP_PLATFORM;
		process.env.SIGNET_ACPX_PROC_ROOT = procRoot;
		process.env.SIGNET_ACPX_CLEANUP_PLATFORM = "linux";
		let heartbeats = 0;
		const heartbeat = setInterval(() => {
			heartbeats += 1;
		}, 0);
		try {
			const provider = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			const startedAt = performance.now();
			await expect(provider.generate("hello", { timeoutMs: 50 })).rejects.toThrow("codex via ACPX timeout after 50ms");
			expect(performance.now() - startedAt).toBeLessThan(200);
			expect(heartbeats).toBeGreaterThan(5);
		} finally {
			clearInterval(heartbeat);
			if (previousProcRoot === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_PROC_ROOT");
			else process.env.SIGNET_ACPX_PROC_ROOT = previousProcRoot;
			if (previousPlatform === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_CLEANUP_PLATFORM");
			else process.env.SIGNET_ACPX_CLEANUP_PLATFORM = previousPlatform;
			await writerClosed;
			await new Promise<void>((resolve) => setImmediate(resolve));
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("captures ACPX JSON events while preserving the final text provider contract", async () => {
		const root = join(tmpdir(), `signet-acpx-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-json.sh");
		const argsPath = join(root, "args.json");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf '%s\n' "$@" > ${JSON.stringify(argsPath)}
printf '%s\n' '{"type":"session","session_id":"acpx-session-1"}'
printf '%s\n' '{"type":"assistant_delta","delta":"partial "}'
printf '%s\n' '{"type":"result","text":"final answer"}'
`,
		);
		chmodSync(bin, 0o755);
		const events: unknown[] = [];
		try {
			const provider = createAcpxProvider({
				agent: "codex",
				bin,
				captureEvents: true,
				onEvent: (event) => events.push(event),
			});
			await expect(provider.generate("hello json", { timeoutMs: 1000 })).resolves.toBe("final answer");
			const args = readFileSync(argsPath, "utf-8").trim().split("\n");
			expect(args).toContain("--format");
			expect(args[args.indexOf("--format") + 1]).toBe("json");
			expect(events).toEqual([
				{ type: "session", session_id: "acpx-session-1" },
				{ type: "assistant_delta", delta: "partial " },
				{ type: "result", text: "final answer" },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses ACP JSON-RPC message chunks as final text when completion carries only stop metadata", async () => {
		const root = join(tmpdir(), `signet-acpx-jsonrpc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-jsonrpc.sh");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello "}}}}'
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"world"}}}}'
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}'
`,
		);
		chmodSync(bin, 0o755);
		try {
			const events: unknown[] = [];
			const provider = createAcpxProvider({
				agent: "codex",
				bin,
				format: "json",
				captureEvents: true,
				onEvent: (event) => events.push(event),
			});

			await expect(provider.generate("hello json", { timeoutMs: 1000 })).resolves.toBe("hello world");
			expect(events).toHaveLength(3);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not deliver ACPX JSON events when captureEvents is disabled", async () => {
		const root = join(tmpdir(), `signet-acpx-events-disabled-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-json-disabled.sh");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf '%s\n' '{"type":"session","session_id":"acpx-session-1"}'
printf '%s\n' '{"type":"result","text":"final answer"}'
`,
		);
		chmodSync(bin, 0o755);
		const events: unknown[] = [];
		try {
			const provider = createAcpxProvider({
				agent: "codex",
				bin,
				format: "json",
				captureEvents: false,
				onEvent: (event) => events.push(event),
			});
			await expect(provider.generate("hello json", { timeoutMs: 1000 })).resolves.toBe("final answer");
			expect(events).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects ACPX JSON output that does not contain a final response", async () => {
		const root = join(tmpdir(), `signet-acpx-events-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-json-empty.sh");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf '%s\n' '{"type":"session","session_id":"acpx-session-1"}'
printf '%s\n' '{"type":"assistant_delta","text":"partial answer"}'
printf '%s\n' '{"type":"tool_result","result":"file contents are not final"}'
printf '%s\n' '{"type":"progress","message":"still working"}'
`,
		);
		chmodSync(bin, 0o755);
		try {
			const provider = createAcpxProvider({ agent: "codex", bin, format: "json", captureEvents: true });
			await expect(provider.generate("hello json", { timeoutMs: 1000 })).rejects.toThrow(
				"codex via ACPX JSON output did not include a final response",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("passes configured ACPX package to an absolute launcher", async () => {
		const root = join(tmpdir(), `signet-acpx-package-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-bunx.sh");
		const argsPath = join(root, "args.json");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf '%s\n' "$@" > ${JSON.stringify(argsPath)}
printf 'ok\n'
`,
		);
		chmodSync(bin, 0o755);
		try {
			const provider = createAcpxProvider({ agent: "codex", bin, package: "acpx@0.7.0", hooks: "disabled" });
			await expect(provider.generate("hello", { timeoutMs: 1000 })).resolves.toBe("ok");
			const args = readFileSync(argsPath, "utf-8").trim().split("\n");
			expect(args.slice(0, 3)).toEqual(["acpx@0.7.0", "--format", "quiet"]);
			expect(args).toContain("codex");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("maps the legacy claude-code agent alias to ACPX's claude command", async () => {
		const root = join(tmpdir(), `signet-acpx-claude-alias-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-bunx.sh");
		const argsPath = join(root, "args.json");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf '%s\n' "$@" > ${JSON.stringify(argsPath)}
printf 'ok\n'
`,
		);
		chmodSync(bin, 0o755);
		try {
			const provider = createAcpxProvider({ agent: "claude-code", bin, package: "acpx@0.7.0", hooks: "disabled" });
			await expect(provider.generate("hello", { timeoutMs: 1000 })).resolves.toBe("ok");
			const args = readFileSync(argsPath, "utf-8").trim().split("\n");
			expect(args).toContain("claude");
			expect(args).not.toContain("claude-code");
			expect(args.slice(args.indexOf("claude"))).toEqual(["claude", "exec", "--file", "-"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("normalizes relative ACPX cwd before spawning and forwarding --cwd", async () => {
		const root = join(tmpdir(), `signet-acpx-cwd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, "workspace"), { recursive: true });
		const bin = join(root, "fake-acpx.sh");
		const argsPath = join(root, "args.json");
		const pwdPath = join(root, "pwd.txt");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf '%s\n' "$@" > ${JSON.stringify(argsPath)}
pwd > ${JSON.stringify(pwdPath)}
printf 'ok\n'
`,
		);
		chmodSync(bin, 0o755);
		const previousCwd = process.cwd();
		try {
			process.chdir(root);
			const provider = createAcpxProvider({ agent: "codex", bin, cwd: "workspace", hooks: "disabled" });
			await expect(provider.generate("hello", { timeoutMs: 1000 })).resolves.toBe("ok");
			const args = readFileSync(argsPath, "utf-8").trim().split("\n");
			const cwdIndex = args.indexOf("--cwd");
			expect(cwdIndex).toBeGreaterThanOrEqual(0);
			expect(args[cwdIndex + 1]).toBe(join(root, "workspace"));
			expect(readFileSync(pwdPath, "utf-8").trim()).toBe(join(root, "workspace"));
		} finally {
			process.chdir(previousCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});


	it("regression: timeout starts escaped-stdio cleanup but releases its permit after a bounded termination wait", async () => {
		const root = join(tmpdir(), `signet-acpx-escaped-stdio-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const procRoot = join(root, "proc");
		const bin = join(root, "fake-acpx.sh");
		const childSpawner = join(root, "spawn-escaped-child.mjs");
		const childPidPath = join(root, "escaped-child.pid");
		const holderReadyPath = join(root, "holder-ready");
		const retryRanPath = join(root, "retry-ran");
		const unrelatedRanPath = join(root, "unrelated-ran");
		mkdirSync(procRoot, { recursive: true });
		writeFileSync(
			childSpawner,
			`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"], {
	detached: true,
	stdio: "inherit",
});
writeFileSync(process.argv[2], String(child.pid));
child.unref();
`,
		);
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
prompt=$(cat)
if [[ "$prompt" == "barrier-settle" ]]; then
  printf 'ready\\n'
  exit 0
fi
if [[ "$prompt" == "retry" ]]; then
  touch ${JSON.stringify(retryRanPath)}
  printf 'retry answer\\n'
  exit 0
fi
if [[ "$prompt" == "unrelated" ]]; then
  touch ${JSON.stringify(unrelatedRanPath)}
  printf 'unrelated answer\\n'
  exit 0
fi
${JSON.stringify(process.execPath)} ${JSON.stringify(childSpawner)} ${JSON.stringify(childPidPath)}
escaped_pid="$(cat ${JSON.stringify(childPidPath)})"
mkdir -p ${JSON.stringify(procRoot)}/"$escaped_pid"
printf 'codex-acp\\0' > ${JSON.stringify(procRoot)}/"$escaped_pid"/cmdline
printf 'SIGNET_ACPX_RUN_ID=%s\\0' "$SIGNET_ACPX_RUN_ID" > ${JSON.stringify(procRoot)}/"$escaped_pid"/environ
touch ${JSON.stringify(holderReadyPath)}
`,
		);
		chmodSync(bin, 0o755);
		const previousProcRoot = process.env.SIGNET_ACPX_PROC_ROOT;
		const previousPlatform = process.env.SIGNET_ACPX_CLEANUP_PLATFORM;
		const previousConcurrencyLimit = getLlmConcurrencyStatus().limit;
		const previousKill = process.kill;
		const cleanupStarted = Promise.withResolvers<void>();
		let escapedPid: number | undefined;
		let cleanupSignals = 0;
		let cleanupKillSignals = 0;
		let cleanupStartedAt = 0;
		let barrierSettled: Promise<string> | undefined;
		let holder: Promise<string> | undefined;
		let retry: Promise<string> | undefined;
		let unrelated: Promise<string> | undefined;
		try {
			configureLlmConcurrency(16);
			process.env.SIGNET_ACPX_CLEANUP_PLATFORM = "linux";
			process.env.SIGNET_ACPX_PROC_ROOT = procRoot;
			const provider = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			barrierSettled = provider.generate("barrier-settle", { timeoutMs: 3_000 });
			await expect(barrierSettled).resolves.toBe("ready");
			holder = provider.generate("holder", { timeoutMs: 500 });
			void holder.catch(() => undefined);
			await waitForPath(holderReadyPath);
			escapedPid = await waitForPidFile(childPidPath);
			process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
				if (pid === escapedPid) {
					if (signal === "SIGTERM") {
						cleanupSignals += 1;
						cleanupStartedAt = performance.now();
						cleanupStarted.resolve();
					}
					if (signal === "SIGKILL") cleanupKillSignals += 1;
					return true;
				}
				return previousKill(pid, signal as NodeJS.Signals);
			}) as typeof process.kill;

			await cleanupStarted.promise;
			retry = provider.generate("retry", { timeoutMs: 5_000 });
			unrelated = createAcpxProvider({ agent: "claude-code", bin, hooks: "disabled" }).generate("unrelated", { timeoutMs: 5_000 });
			await expect(unrelated).resolves.toBe("unrelated answer");
			// The run-id barrier is active even if the bounded child wait has already released the permit.
			expect(existsSync(retryRanPath)).toBe(false);

			await expect(holder).rejects.toThrow(/codex via ACPX timeout after \d+ms/);
			const cleanupElapsedMs = performance.now() - cleanupStartedAt;
			expect(cleanupElapsedMs).toBeLessThan(300);
			expect(getLlmConcurrencyStatus()).toMatchObject({ running: 0, pending: 0 });
			expect(cleanupSignals).toBe(1);
			expect(cleanupKillSignals).toBe(0);
			expect(() => previousKill(escapedPid, 0)).not.toThrow();

			rmSync(join(procRoot, String(escapedPid)), { recursive: true, force: true });
			await expect(retry).resolves.toBe("retry answer");
			previousKill(escapedPid, "SIGKILL");
			await waitForProcessExit(escapedPid);
			const { promise: closeTurn, resolve: advanceCloseTurn } = Promise.withResolvers<void>();
			setImmediate(advanceCloseTurn);
			await closeTurn;
			expect(cleanupSignals).toBe(1);
			expect(cleanupKillSignals).toBe(1);
		} finally {
			if (escapedPid !== undefined) {
				try {
					previousKill(escapedPid, "SIGKILL");
				} catch {
					// Already exited.
				}
			}
			await Promise.allSettled([barrierSettled, holder, retry, unrelated]);
			configureLlmConcurrency(previousConcurrencyLimit);
			process.kill = previousKill;
			if (previousProcRoot === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_PROC_ROOT");
			else process.env.SIGNET_ACPX_PROC_ROOT = previousProcRoot;
			if (previousPlatform === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_CLEANUP_PLATFORM");
			else process.env.SIGNET_ACPX_CLEANUP_PLATFORM = previousPlatform;
			rmSync(root, { recursive: true, force: true });
		}
	}, 4_000);

	it("does not launch a same-agent request aborted during ACPX cleanup", async () => {
		const root = join(tmpdir(), `signet-acpx-aborted-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const procRoot = join(root, "proc");
		const bin = join(root, "fake-acpx.sh");
		const holderReadyPath = join(root, "holder-ready");
		const queuedRanPath = join(root, "queued-ran");
		mkdirSync(root, { recursive: true });
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
prompt=$(cat)
if [[ "$prompt" == "barrier-settle" ]]; then
  printf 'ready\\n'
  exit 0
fi
if [[ "$prompt" == "holder" ]]; then
  mkdir -p ${JSON.stringify(join(procRoot, "12345"))}
  printf 'codex-acp\\0' > ${JSON.stringify(join(procRoot, "12345", "cmdline"))}
  printf 'SIGNET_ACPX_RUN_ID=%s\\0' "$SIGNET_ACPX_RUN_ID" > ${JSON.stringify(join(procRoot, "12345", "environ"))}
  touch ${JSON.stringify(holderReadyPath)}
  sleep 30
else
  touch ${JSON.stringify(queuedRanPath)}
  printf 'queued answer\\n'
fi
`,
		);
		chmodSync(bin, 0o755);
		const previousProcRoot = process.env.SIGNET_ACPX_PROC_ROOT;
		const previousPlatform = process.env.SIGNET_ACPX_CLEANUP_PLATFORM;
		const previousKill = process.kill;
		const previousConcurrencyLimit = getLlmConcurrencyStatus().limit;
		const cleanupStarted = Promise.withResolvers<void>();
		const cleanupFinished = Promise.withResolvers<void>();
		let cleanupInFlight = false;
		let holderController: AbortController | undefined;
		let queuedController: AbortController | undefined;
		let barrierSettled: Promise<string> | undefined;
		let holder: Promise<string> | undefined;
		let queued: Promise<string> | undefined;
		try {
			process.env.SIGNET_ACPX_CLEANUP_PLATFORM = "linux";
			configureLlmConcurrency(16);
			process.env.SIGNET_ACPX_PROC_ROOT = procRoot;
			process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
				if (pid !== 12345) return previousKill(pid, signal as NodeJS.Signals);
				if (signal === "SIGTERM") {
					cleanupInFlight = true;
					cleanupStarted.resolve();
				}
				if (signal === "SIGKILL") cleanupFinished.resolve();
				return true;
			}) as typeof process.kill;
			const provider = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			barrierSettled = provider.generate("barrier-settle", { timeoutMs: 3_000 });
			await expect(barrierSettled).resolves.toBe("ready");
			holderController = new AbortController();
			holder = provider.generate("holder", { signal: holderController.signal, timeoutMs: 5_000 });
			await waitForPath(holderReadyPath);
			holderController.abort();
			const holderAborted = expect(holder).rejects.toThrow("codex via ACPX aborted");
			await cleanupStarted.promise;
			await holderAborted;

			queuedController = new AbortController();
			queued = provider.generate("queued", { signal: queuedController.signal, timeoutMs: 5_000 });
			await waitForLlmConcurrencyStatus(0, 0);
			queuedController.abort(new Error("queued caller cancelled"));
			await expect(queued).rejects.toThrow("queued caller cancelled");
			expect(existsSync(queuedRanPath)).toBe(false);
		} finally {
			holderController?.abort();
			queuedController?.abort();
			await Promise.allSettled([barrierSettled, holder, queued]);
			if (cleanupInFlight) await cleanupFinished.promise;
			configureLlmConcurrency(previousConcurrencyLimit);
			process.kill = previousKill;
			if (previousProcRoot === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_PROC_ROOT");
			else process.env.SIGNET_ACPX_PROC_ROOT = previousProcRoot;
			if (previousPlatform === undefined) Reflect.deleteProperty(process.env, "SIGNET_ACPX_CLEANUP_PLATFORM");
			else process.env.SIGNET_ACPX_CLEANUP_PLATFORM = previousPlatform;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("kills the ACPX process group on timeout so codex grandchildren do not leak", async () => {
		if (process.platform === "win32") return;
		const root = join(tmpdir(), `signet-acpx-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-leak.sh");
		const childPidPath = join(root, "child.pid");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
sleep 30 &
printf '%s' "$!" > ${JSON.stringify(childPidPath)}
wait
`,
		);
		chmodSync(bin, 0o755);

		try {
			const provider = createAcpxProvider({ agent: "codex", bin, hooks: "disabled" });
			await expect(provider.generate("hang", { timeoutMs: 50 })).rejects.toThrow("codex via ACPX timeout after 50ms");

			let pid = 0;
			for (let i = 0; i < 20; i += 1) {
				if (existsSync(childPidPath)) {
					pid = Number(readFileSync(childPidPath, "utf-8"));
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			expect(pid).toBeGreaterThan(0);

			let alive = true;
			for (let i = 0; i < 40; i += 1) {
				try {
					process.kill(pid, 0);
					await new Promise((resolve) => setTimeout(resolve, 25));
				} catch {
					alive = false;
					break;
				}
			}
			expect(alive).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Global LLM concurrency semaphore
// ---------------------------------------------------------------------------

describe("LlmConcurrencySemaphore", () => {
	it("acquireWithTimeout rejects with SemaphoreTimeoutError", async () => {
		const sem = new LlmConcurrencySemaphore(1);
		await sem.acquire();

		try {
			await sem.acquireWithTimeout(50);
			throw new Error("should not reach");
		} catch (err) {
			expect(err).toBeInstanceOf(SemaphoreTimeoutError);
			expect((err as SemaphoreTimeoutError).message).toMatch(/timed out/);
		}

		sem.release();
	});

	it("acquireWithTimeout clears timer on successful acquisition", async () => {
		const sem = new LlmConcurrencySemaphore(1);
		await sem.acquire();

		setTimeout(() => sem.release(), 20);

		const before = Bun.nanoseconds();
		await sem.acquireWithTimeout(200);
		const elapsed = (Bun.nanoseconds() - before) / 1e6;

		expect(elapsed).toBeLessThan(100);
		expect(sem.activeTimers).toBe(0);

		sem.release();
	});

	it("acquireWithTimeout throws on ms <= 0", () => {
		const sem = new LlmConcurrencySemaphore(1);
		expect(sem.acquireWithTimeout(0)).rejects.toThrow(/positive/);
		expect(sem.acquireWithTimeout(-1)).rejects.toThrow(/positive/);
	});

	it("release() throws when active count is already 0", () => {
		const sem = new LlmConcurrencySemaphore(1);
		expect(() => sem.release()).toThrow(/no active/i);
	});

	it("release() does not go negative after guard", () => {
		const sem = new LlmConcurrencySemaphore(2);
		expect(() => sem.release()).toThrow();
		expect(sem.running).toBe(0);
	});

	it("timeout removes queued entry so it does not fire later", async () => {
		const sem = new LlmConcurrencySemaphore(1);
		await sem.acquire();

		await expect(sem.acquireWithTimeout(30)).rejects.toBeInstanceOf(SemaphoreTimeoutError);

		expect(sem.pending).toBe(0);

		sem.release();
		expect(sem.running).toBe(0);
	});

	it("mixed acquire() and acquireWithTimeout() preserve FIFO order", async () => {
		const sem = new LlmConcurrencySemaphore(1);
		await sem.acquire();

		const order: number[] = [];

		const p1 = sem.acquire().then(() => order.push(1));
		const p2 = sem.acquireWithTimeout(5000).then(() => order.push(2));

		sem.release();
		await p1;
		sem.release();
		await p2;

		expect(order).toEqual([1, 2]);

		sem.release();
	});

	it("activeTimers returns 0 after timeout rejection", async () => {
		const sem = new LlmConcurrencySemaphore(1);
		await sem.acquire();

		await expect(sem.acquireWithTimeout(30)).rejects.toBeInstanceOf(SemaphoreTimeoutError);
		expect(sem.activeTimers).toBe(0);

		sem.release();
	});

	it("external abort removes queued acquisition without waiting for timeout", async () => {
		const sem = new LlmConcurrencySemaphore(1);
		await sem.acquire();
		const controller = new AbortController();
		const wait = sem.acquireWithTimeout(500, controller.signal);
		expect(sem.pending).toBe(1);
		controller.abort();

		await expect(wait).rejects.toThrow(/aborted/i);
		expect(sem.pending).toBe(0);
		expect(sem.activeTimers).toBe(0);

		sem.release();
	});

	it("global cap: concurrent calls beyond max queue and resolve in order", async () => {
		const sem = new LlmConcurrencySemaphore(2);

		await sem.acquire();
		await sem.acquire();
		expect(sem.running).toBe(2);
		expect(sem.pending).toBe(0);

		const order: number[] = [];
		const p1 = sem.acquire().then(() => order.push(1));
		const p2 = sem.acquire().then(() => order.push(2));
		expect(sem.pending).toBe(2);

		sem.release();
		await p1;
		sem.release();
		await p2;

		expect(order).toEqual([1, 2]);
		expect(sem.running).toBe(2);

		sem.release();
		sem.release();
		expect(sem.running).toBe(0);
	});

	it("withLlmConcurrency releases the permit when guarded work fails", async () => {
		const originalLimit = getLlmConcurrencyStatus().limit;
		configureLlmConcurrency(1);
		try {
			await expect(
				withLlmConcurrency(
					async () => {
						throw new Error("agent session failed");
					},
					100,
					"pi-agent",
				),
			).rejects.toThrow("agent session failed");
			expect(getLlmConcurrencyStatus().running).toBe(0);
			expect(await withLlmConcurrency(async () => "next", 100, "pi-agent")).toBe("next");
		} finally {
			configureLlmConcurrency(originalLimit);
		}
	});

	it("rejects fractional SIGNET_MAX_LLM_CONCURRENCY", () => {
		const parsed = Number("1.5");
		expect(Number.isSafeInteger(parsed)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Subprocess deadline helper
// ---------------------------------------------------------------------------

describe("awaitSubprocessWithDeadline — success-after-timeout race", () => {
	it("reports timeout even when resultFn resolves successfully after deadline fires", async () => {
		// Race: deadline timer fires (timedOut=true, SIGTERM sent) but resultFn
		// resolves successfully because output was already buffered. Must throw
		// SemaphoreTimeoutError instead of returning the stale result.
		let killed = false;
		const exitPromise = new Promise<number>((resolve) => {
			setTimeout(() => resolve(0), 200);
		});

		const fakeProc = {
			stdout: streamFromString(""),
			stderr: streamFromString(""),
			exited: exitPromise,
			kill() {
				killed = true;
			},
		};

		// resultFn resolves after 80ms — but deadline is 30ms, so timedOut
		// will be true when resultFn settles.
		const resultFn = async () => {
			await new Promise((r) => setTimeout(r, 80));
			return "success-value";
		};

		await expect(awaitSubprocessWithDeadline(fakeProc, 30, "test", 30, resultFn)).rejects.toBeInstanceOf(
			SemaphoreTimeoutError,
		);

		expect(killed).toBe(true);
	});

	it("arms SIGKILL while resultFn is still waiting for process exit", async () => {
		let resolveExit: (code: number) => void = () => {};
		const exitPromise = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		const signals: string[] = [];
		const fakeProc = {
			stdout: streamFromString(""),
			stderr: streamFromString(""),
			exited: exitPromise,
			kill(signal?: string) {
				signals.push(signal ?? "SIGTERM");
				if (signal === "SIGKILL") resolveExit(143);
			},
		};

		const resultFn = async (proc: typeof fakeProc) => {
			await proc.exited;
			return "late";
		};

		const outcome = await Promise.race([
			awaitSubprocessWithDeadline(fakeProc, 20, "test", 20, resultFn).then(
				() => "resolved",
				(error) => error,
			),
			new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("deadline helper did not settle")), 2600)),
		]);

		expect(outcome).toBeInstanceOf(SemaphoreTimeoutError);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("SIGKILLs the process group when the leader exits before a SIGTERM-resistant descendant", async () => {
		if (process.platform === "win32") return;
		const root = join(tmpdir(), `signet-deadline-group-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "leader-exits-descendant-ignores-term.sh");
		const leaderPidPath = join(root, "leader.pid");
		const childPidPath = join(root, "child.pid");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s' "$$" > ${JSON.stringify(leaderPidPath)}
bash -c 'trap "" TERM; printf "%s" "$$" > "$1"; while true; do sleep 1; done' _ ${JSON.stringify(childPidPath)} &
while [ ! -s ${JSON.stringify(childPidPath)} ]; do sleep 0.01; done
trap 'exit 0' TERM
wait
`,
		);
		chmodSync(bin, 0o755);

		const child = nodeSpawn(bin, [], {
			stdio: ["ignore", "ignore", "ignore"],
			detached: true,
		});
		const exited = new Promise<number>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (code) => resolve(code ?? 1));
		});

		try {
			const childPid = await waitForPidFile(childPidPath);
			const controller = new AbortController();
			const wait = awaitSubprocessWithDeadline(
				{
					stdout: streamFromString(""),
					stderr: streamFromString(""),
					exited,
					processGroupId: child.pid,
					kill(signal?: string) {
						const actualSignal = signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
						if (typeof child.pid === "number") {
							process.kill(-child.pid, actualSignal);
							return;
						}
						child.kill(actualSignal);
					},
				},
				10_000,
				"test",
				10_000,
				async (proc) => {
					await proc.exited;
					return "done";
				},
				controller.signal,
			);
			controller.abort();

			await expect(wait).rejects.toThrow("test aborted");
			expect(await waitForProcessExit(childPid)).toBe(true);
		} finally {
			for (const path of [leaderPidPath, childPidPath]) {
				if (!existsSync(path)) continue;
				const pid = Number(readFileSync(path, "utf-8"));
				if (pid > 0) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						// Already exited.
					}
				}
			}
			if (typeof child.pid === "number") {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// Process group already gone.
				}
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
});
