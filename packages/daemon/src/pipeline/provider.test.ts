/**
 * Tests for the LlmProvider interface and OllamaProvider implementation.
 *
 * OllamaProvider uses Bun.spawn internally, so we mock it at the
 * module level using bun:test's mock() utility.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { createOllamaProvider } from "./provider";

// ---------------------------------------------------------------------------
// Minimal process mock factory
// ---------------------------------------------------------------------------

/**
 * Build a mock process object matching the shape that OllamaProvider
 * consumes from Bun.spawn: stdout (ReadableStream), stderr
 * (ReadableStream), exited (Promise<number>), exitCode (number).
 */
function makeProc(
	stdout: string,
	stderr: string,
	exitCode: number,
	exitDelay = 0,
): ReturnType<typeof Bun.spawn> {
	const encoder = new TextEncoder();

	// Simulated exited promise
	const exitedPromise = exitDelay > 0
		? new Promise<number>((res) => setTimeout(() => res(exitCode), exitDelay))
		: Promise.resolve(exitCode);

	return {
		stdout: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(stdout));
				controller.close();
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(stderr));
				controller.close();
			},
		}),
		exited: exitedPromise,
		exitCode,
		// The rest of the Bun.spawn surface area isn't used by provider.ts
		pid: 99999,
		stdin: null,
		kill() {},
		ref() {},
		unref() {},
	} as unknown as ReturnType<typeof Bun.spawn>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOllamaProvider", () => {
	it("returns a provider with the correct name", () => {
		const provider = createOllamaProvider({ model: "llama3" });
		expect(provider.name).toBe("ollama:llama3");
	});

	it("uses the default model name when none is supplied", () => {
		const provider = createOllamaProvider();
		expect(provider.name).toContain("ollama:");
		expect(provider.name.length).toBeGreaterThan("ollama:".length);
	});

	it("generate() returns trimmed stdout on success", async () => {
		const originalSpawn = Bun.spawn;
		try {
			(Bun as unknown as Record<string, unknown>).spawn = mock(() =>
				makeProc("  hello world  \n", "", 0),
			);

			const provider = createOllamaProvider({ model: "test-model" });
			const result = await provider.generate("test prompt");
			expect(result).toBe("hello world");
		} finally {
			(Bun as unknown as Record<string, unknown>).spawn = originalSpawn;
		}
	});

	it("generate() throws on non-zero exit code", async () => {
		const originalSpawn = Bun.spawn;
		try {
			(Bun as unknown as Record<string, unknown>).spawn = mock(() =>
				makeProc("", "model not found", 1),
			);

			const provider = createOllamaProvider({ model: "test-model" });
			await expect(provider.generate("test prompt")).rejects.toThrow(
				/exited with code 1/,
			);
		} finally {
			(Bun as unknown as Record<string, unknown>).spawn = originalSpawn;
		}
	});

	it("generate() throws a timeout error and kills the subprocess", async () => {
		const originalSpawn = Bun.spawn;
		try {
			let killCalled = false;
			const proc = {
				stdout: new ReadableStream({
					// never enqueues / closes — simulates a hung process
				}),
				stderr: new ReadableStream({
					start(c) {
						c.close();
					},
				}),
				exited: new Promise<number>(() => {}), // never resolves
				exitCode: null,
				pid: 99999,
				stdin: null,
				kill() {
					killCalled = true;
				},
				ref() {},
				unref() {},
			} as unknown as ReturnType<typeof Bun.spawn>;

			(Bun as unknown as Record<string, unknown>).spawn = mock(() => proc);

			const provider = createOllamaProvider({
				model: "slow-model",
				defaultTimeoutMs: 50,
			});

			await expect(
				provider.generate("test prompt", { timeoutMs: 50 }),
			).rejects.toThrow(/timeout/i);

			expect(killCalled).toBe(true);
		} finally {
			(Bun as unknown as Record<string, unknown>).spawn = originalSpawn;
		}
	});

	it("available() returns true when ollama list exits with 0", async () => {
		const originalSpawn = Bun.spawn;
		try {
			(Bun as unknown as Record<string, unknown>).spawn = mock(() =>
				makeProc("NAME\nllama3:latest", "", 0),
			);

			const provider = createOllamaProvider();
			const result = await provider.available();
			expect(result).toBe(true);
		} finally {
			(Bun as unknown as Record<string, unknown>).spawn = originalSpawn;
		}
	});

	it("available() returns false when spawn throws", async () => {
		const originalSpawn = Bun.spawn;
		try {
			(Bun as unknown as Record<string, unknown>).spawn = mock(() => {
				throw new Error("ollama: command not found");
			});

			const provider = createOllamaProvider();
			const result = await provider.available();
			expect(result).toBe(false);
		} finally {
			(Bun as unknown as Record<string, unknown>).spawn = originalSpawn;
		}
	});

	it("available() returns false when ollama list exits non-zero", async () => {
		const originalSpawn = Bun.spawn;
		try {
			(Bun as unknown as Record<string, unknown>).spawn = mock(() =>
				makeProc("", "connection refused", 1),
			);

			const provider = createOllamaProvider();
			const result = await provider.available();
			expect(result).toBe(false);
		} finally {
			(Bun as unknown as Record<string, unknown>).spawn = originalSpawn;
		}
	});
});
