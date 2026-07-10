import { describe, expect, it } from "bun:test";
import type { LlmProvider } from "@signet/core";
import { type ExtractionWorker, startExtractionThread } from "./extraction-thread-handle";
import type { MainToWorkerMessage, WorkerInit, WorkerToMainMessage } from "./extraction-thread-protocol";

class FakeExtractionWorker implements ExtractionWorker {
	readonly posted: MainToWorkerMessage[] = [];
	private readonly listeners: {
		message: Array<(msg: WorkerToMainMessage) => void>;
		error: Array<(err: Error) => void>;
		exit: Array<(code: number) => void>;
	} = { message: [], error: [], exit: [] };

	on(event: "message", listener: (msg: WorkerToMainMessage) => void): ExtractionWorker;
	on(event: "error", listener: (err: Error) => void): ExtractionWorker;
	on(event: "exit", listener: (code: number) => void): ExtractionWorker;
	on(
		event: "message" | "error" | "exit",
		listener: ((msg: WorkerToMainMessage) => void) | ((err: Error) => void) | ((code: number) => void),
	): ExtractionWorker {
		this.listeners[event].push(listener as never);
		return this;
	}

	postMessage(msg: MainToWorkerMessage): void {
		this.posted.push(msg);
	}

	terminate(): Promise<number> {
		return Promise.resolve(0);
	}

	emitMessage(msg: WorkerToMainMessage): void {
		for (const listener of this.listeners.message) listener(msg);
	}

	emitError(err: Error): void {
		for (const listener of this.listeners.error) listener(err);
	}

	emitExit(code: number): void {
		for (const listener of this.listeners.exit) listener(code);
	}
}

const init: WorkerInit = {
	dbPath: "/tmp/signet-test.db",
	vecExtensionPath: "/tmp/vec0.so",
	agentsDir: "/tmp/agents",
	agentId: "default",
	embeddingConfig: { provider: "ollama", model: "embed", dimensions: 768 },
	pipelineConfig: {},
	searchConfig: {},
};

describe("startExtractionThread inference proxy", () => {
	it("executes worker generate requests on the main-thread provider", async () => {
		const fake = new FakeExtractionWorker();
		const provider: LlmProvider = {
			name: "test-provider",
			async generate(prompt, opts) {
				expect(prompt).toBe("extract this");
				expect(opts?.responseFormat).toBe("json");
				expect(opts?.think).toBe(false);
				return '{"ok":true}';
			},
			async available() {
				return true;
			},
		};

		const handlePromise = startExtractionThread({
			init,
			provider,
			workerFactory: () => fake,
			readyTimeoutMs: 1000,
		});
		fake.emitMessage({ type: "ready" });
		await handlePromise;
		fake.emitMessage({
			type: "generate",
			id: "req-1",
			prompt: "extract this",
			options: { responseFormat: "json", think: false },
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fake.posted).toContainEqual({ type: "generateResult", id: "req-1", text: '{"ok":true}' });
	});

	it("aborts in-flight worker generate requests before stopping the worker", async () => {
		const fake = new FakeExtractionWorker();
		let observedSignal: AbortSignal | undefined;
		const provider: LlmProvider = {
			name: "test-provider",
			generate(_prompt, opts) {
				observedSignal = opts?.signal;
				return new Promise((_resolve, reject) => {
					opts?.signal?.addEventListener("abort", () => reject(new Error("provider aborted")));
				});
			},
			async available() {
				return true;
			},
		};

		const handlePromise = startExtractionThread({
			init,
			provider,
			workerFactory: () => fake,
			readyTimeoutMs: 1000,
			stopTimeoutMs: 1000,
		});
		fake.emitMessage({ type: "ready" });
		const handle = await handlePromise;
		fake.emitMessage({ type: "generate", id: "req-2", prompt: "slow", options: { timeoutMs: 5000 } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		const stopPromise = handle.stop();
		expect(observedSignal?.aborted).toBe(true);
		for (let i = 0; i < 20 && !fake.posted.some((msg) => msg.type === "stop"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		fake.emitMessage({ type: "stopped" });
		await stopPromise;
		expect(fake.posted).toContainEqual({ type: "generateError", id: "req-2", error: "provider aborted" });
	});

	it("aborts in-flight provider work when the extraction worker crashes", async () => {
		const fake = new FakeExtractionWorker();
		let observedSignal: AbortSignal | undefined;
		const provider: LlmProvider = {
			name: "test-provider",
			generate(_prompt, opts) {
				observedSignal = opts?.signal;
				return new Promise((_resolve, reject) => {
					opts?.signal?.addEventListener("abort", () => reject(new Error("provider aborted")));
				});
			},
			async available() {
				return true;
			},
		};

		const handlePromise = startExtractionThread({
			init,
			provider,
			workerFactory: () => fake,
			readyTimeoutMs: 1000,
		});
		fake.emitMessage({ type: "ready" });
		await handlePromise;
		fake.emitMessage({ type: "generate", id: "req-crash", prompt: "slow", options: { timeoutMs: 5000 } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		fake.emitError(new Error("worker crashed"));

		expect(observedSignal?.aborted).toBe(true);
	});

	it("aborts in-flight provider work when the extraction worker exits unexpectedly", async () => {
		const fake = new FakeExtractionWorker();
		let observedSignal: AbortSignal | undefined;
		const provider: LlmProvider = {
			name: "test-provider",
			generate(_prompt, opts) {
				observedSignal = opts?.signal;
				return new Promise((_resolve, reject) => {
					opts?.signal?.addEventListener("abort", () => reject(new Error("provider aborted")));
				});
			},
			async available() {
				return true;
			},
		};

		const handlePromise = startExtractionThread({
			init,
			provider,
			workerFactory: () => fake,
			readyTimeoutMs: 1000,
		});
		fake.emitMessage({ type: "ready" });
		await handlePromise;
		fake.emitMessage({ type: "generate", id: "req-exit", prompt: "slow", options: { timeoutMs: 5000 } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		fake.emitExit(1);

		expect(observedSignal?.aborted).toBe(true);
	});

	it("aborts early proxied generate work when readiness times out", async () => {
		const fake = new FakeExtractionWorker();
		let observedSignal: AbortSignal | undefined;
		const provider: LlmProvider = {
			name: "test-provider",
			generate(_prompt, opts) {
				observedSignal = opts?.signal;
				return new Promise((_resolve, reject) => {
					opts?.signal?.addEventListener("abort", () => reject(new Error("provider aborted")));
				});
			},
			async available() {
				return true;
			},
		};

		const handlePromise = startExtractionThread({
			init,
			provider,
			workerFactory: () => fake,
			readyTimeoutMs: 10,
		});
		fake.emitMessage({ type: "generate", id: "req-ready-timeout", prompt: "early", options: { timeoutMs: 5000 } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		await expect(handlePromise).rejects.toThrow("failed to become ready");
		expect(observedSignal?.aborted).toBe(true);
	});
});
