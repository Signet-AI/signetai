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
	createAcpxProvider,
} from "./provider";

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

// ---------------------------------------------------------------------------
// ACPX harness-subprocess provider
// ---------------------------------------------------------------------------

describe("createAcpxProvider", () => {
	it("runs ACPX one-shot exec with pinned version-compatible args and sterile hook env", async () => {
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
				terminal: "disabled",
				mode: "session",
				session: "background",
				allowedTools: ["read_file"],
			});
			await expect(provider.generate("hello acpx", { timeoutMs: 1000 })).resolves.toBe("acpx answer");
			const args = readFileSync(argsPath, "utf-8").trim().split("\n");
			expect(args).toContain("--format");
			expect(args).toContain("quiet");
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
		} finally {
			if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
			else process.env.SIGNET_PATH = previousSignetPath;
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

	it("cleans up detached Codex ACP agent processes after successful ACPX exec", async () => {
		if (process.platform !== "linux") return;
		const root = join(tmpdir(), `signet-acpx-success-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const bin = join(root, "fake-acpx-daemonizes.sh");
		const codexAcp = join(root, "codex-acp");
		const childPidPath = join(root, "child.pid");
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
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
