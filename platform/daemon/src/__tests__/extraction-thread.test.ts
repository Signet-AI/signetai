import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { WorkerOptions } from "node:worker_threads";
import {
	type ExtractionWorker,
	type ExtractionWorkerFactory,
	startExtractionThread,
} from "../pipeline/extraction-thread-handle";
import type {
	MainToWorkerMessage,
	SerializedEmbeddingConfig,
	WorkerInit,
	WorkerToMainMessage,
} from "../pipeline/extraction-thread-protocol";
import type { LogSink, WorkerStats } from "../pipeline/worker";

class FakeExtractionWorker implements ExtractionWorker {
	readonly messages: MainToWorkerMessage[] = [];
	terminateCalls = 0;
	readonly paths: string[] = [];
	readonly inits: WorkerInit[] = [];
	readonly options: WorkerOptions[] = [];

	private readonly emitter = new EventEmitter();

	on(event: "message", listener: (msg: WorkerToMainMessage) => void): ExtractionWorker;
	on(event: "error", listener: (err: Error) => void): ExtractionWorker;
	on(event: "exit", listener: (code: number) => void): ExtractionWorker;
	on(
		event: "message" | "error" | "exit",
		listener: ((msg: WorkerToMainMessage) => void) | ((err: Error) => void) | ((code: number) => void),
	): ExtractionWorker {
		this.emitter.on(event, listener);
		return this;
	}

	postMessage(msg: MainToWorkerMessage): void {
		this.messages.push(msg);
	}

	terminate(): Promise<number> {
		this.terminateCalls++;
		return Promise.resolve(0);
	}

	emitMessage(msg: WorkerToMainMessage): void {
		this.emitter.emit("message", msg);
	}

	emitError(err: Error): void {
		this.emitter.emit("error", err);
	}

	emitExit(code: number): void {
		this.emitter.emit("exit", code);
	}
}

function testInit(): WorkerInit {
	return {
		dbPath: "/tmp/signet-test.db",
		vecExtensionPath: "",
		agentsDir: "/tmp/agents",
		agentId: "default",
		embeddingConfig: {
			provider: "none",
			model: "none",
			dimensions: 768,
		},
		pipelineConfig: {},
		searchConfig: {},
	};
}

function fakeFactory(worker: FakeExtractionWorker): ExtractionWorkerFactory {
	return (path, init, options) => {
		worker.paths.push(path);
		worker.inits.push(init);
		worker.options.push(options);
		return worker;
	};
}

describe("extraction-thread-protocol", () => {
	describe("MainToWorkerMessage", () => {
		it("accepts stop message", () => {
			const msg: MainToWorkerMessage = { type: "stop" };
			expect(msg.type).toBe("stop");
		});

		it("accepts nudge message", () => {
			const msg: MainToWorkerMessage = { type: "nudge" };
			expect(msg.type).toBe("nudge");
		});
	});

	describe("WorkerToMainMessage", () => {
		it("accepts ready message", () => {
			const msg: WorkerToMainMessage = { type: "ready" };
			expect(msg.type).toBe("ready");
		});

		it("accepts stopped message", () => {
			const msg: WorkerToMainMessage = { type: "stopped" };
			expect(msg.type).toBe("stopped");
		});

		it("accepts stats message with WorkerStats", () => {
			const stats: WorkerStats = {
				failures: 0,
				lastProgressAt: Date.now(),
				pending: 5,
				processed: 100,
				backoffMs: 0,
				overloaded: false,
				loadPerCpu: 0.5,
				maxLoadPerCpu: 2.0,
				overloadBackoffMs: 1000,
				overloadSince: null,
				nextTickInMs: 100,
			};
			const msg: WorkerToMainMessage = { type: "stats", stats };
			expect(msg.type).toBe("stats");
			expect(msg.stats.processed).toBe(100);
		});

		it("accepts log message with all fields", () => {
			const msg: WorkerToMainMessage = {
				type: "log",
				level: "info",
				category: "extraction",
				message: "Processing started",
				data: { jobId: "123" },
			};
			expect(msg.type).toBe("log");
			expect(msg.level).toBe("info");
			expect(msg.category).toBe("extraction");
		});

		it("accepts log message without data", () => {
			const msg: WorkerToMainMessage = {
				type: "log",
				level: "warn",
				category: "decision",
				message: "Low confidence",
			};
			expect(msg.type).toBe("log");
			expect(msg.data).toBeUndefined();
		});

		it("accepts telemetry message", () => {
			const msg: WorkerToMainMessage = {
				type: "telemetry",
				event: "extraction_complete",
				data: { duration: 150 },
			};
			expect(msg.type).toBe("telemetry");
		});

		it("accepts analytics message", () => {
			const msg: WorkerToMainMessage = {
				type: "analytics",
				method: "track",
				args: ["event_name", { prop: "value" }],
			};
			expect(msg.type).toBe("analytics");
		});

		it("accepts error message with stack", () => {
			const msg: WorkerToMainMessage = {
				type: "error",
				error: "Database connection failed",
				stack: "Error: at worker.ts:123",
			};
			expect(msg.type).toBe("error");
			expect(msg.stack).toBeDefined();
		});

		it("accepts error message without stack", () => {
			const msg: WorkerToMainMessage = {
				type: "error",
				error: "Unknown error",
			};
			expect(msg.type).toBe("error");
			expect(msg.stack).toBeUndefined();
		});
	});

	describe("WorkerInit", () => {
		it("accepts valid WorkerInit with all required fields", () => {
			const embeddingConfig: SerializedEmbeddingConfig = {
				provider: "ollama",
				model: "nomic-embed-text",
				dimensions: 768,
				base_url: "http://localhost:11434",
			};

			const init: WorkerInit = {
				dbPath: "/path/to/db.sqlite",
				vecExtensionPath: "/path/to/vec.so",
				agentsDir: "/home/user/.agents",
				agentId: "default",
				embeddingConfig,
				pipelineConfig: { mode: "normal" },
				searchConfig: { limit: 10 },
			};

			expect(init.dbPath).toBe("/path/to/db.sqlite");
			expect(init.agentId).toBe("default");
			expect(init.embeddingConfig.model).toBe("nomic-embed-text");
		});

		it("accepts WorkerInit with optional api_key in embedding config", () => {
			const embeddingConfig: SerializedEmbeddingConfig = {
				provider: "openai",
				model: "text-embedding-3-small",
				dimensions: 1536,
				api_key: "sk-...",
			};

			const init: WorkerInit = {
				dbPath: "/path/to/db.sqlite",
				vecExtensionPath: "/path/to/vec.so",
				agentsDir: "/home/user/.agents",
				agentId: "alice",
				embeddingConfig,
				pipelineConfig: {},
				searchConfig: {},
			};

			expect(init.embeddingConfig.api_key).toBe("sk-...");
		});
	});
});

describe("worker LogSink injection", () => {
	it("accepts LogSink interface with all methods", () => {
		const sink: LogSink = {
			info: (category: string, message: string, data?: Record<string, unknown>) => {
				void category;
				void message;
				void data;
			},
			warn: (category: string, message: string, data?: Record<string, unknown>) => {
				void category;
				void message;
				void data;
			},
			error: (category: string, message: string, error?: Error | unknown, data?: Record<string, unknown>) => {
				void category;
				void message;
				void error;
				void data;
			},
		};

		expect(sink).toBeDefined();
		expect(typeof sink.info).toBe("function");
		expect(typeof sink.warn).toBe("function");
		expect(typeof sink.error).toBe("function");
	});

	it("LogSink can be called with all parameter combinations", () => {
		const calls: Array<{ method: string; args: unknown[] }> = [];

		const sink: LogSink = {
			info: (category, message, data) => {
				calls.push({ method: "info", args: [category, message, data] });
			},
			warn: (category, message, data) => {
				calls.push({ method: "warn", args: [category, message, data] });
			},
			error: (category, message, error, data) => {
				calls.push({ method: "error", args: [category, message, error, data] });
			},
		};

		sink.info("test", "message");
		sink.info("test", "message", { key: "value" });
		sink.warn("test", "warning");
		sink.error("test", "error");
		sink.error("test", "error", new Error("test"), { context: "data" });

		expect(calls).toHaveLength(5);
		expect(calls[0].method).toBe("info");
		expect(calls[1].method).toBe("info");
		expect(calls[2].method).toBe("warn");
		expect(calls[3].method).toBe("error");
		expect(calls[4].method).toBe("error");
	});
});

describe("startExtractionThread lifecycle", () => {
	it("resolves on ready, forwards nudge, updates stats, and stops cleanly", async () => {
		const worker = new FakeExtractionWorker();
		const starting = startExtractionThread({
			init: testInit(),
			workerFactory: fakeFactory(worker),
			readyTimeoutMs: 50,
			stopTimeoutMs: 50,
		});
		const stats: WorkerStats = {
			failures: 0,
			lastProgressAt: 123,
			pending: 2,
			processed: 7,
			backoffMs: 0,
			overloaded: false,
			loadPerCpu: null,
			maxLoadPerCpu: 0,
			overloadBackoffMs: 0,
			overloadSince: null,
			nextTickInMs: 0,
		};

		worker.emitMessage({ type: "stats", stats });
		worker.emitMessage({ type: "ready" });

		const handle = await starting;
		expect(handle.running).toBe(true);
		expect(handle.stats.processed).toBe(7);
		expect(worker.inits).toHaveLength(1);
		expect(worker.options[0]?.type).toBe("module");
		expect(worker.options[0]?.workerData).toEqual(testInit());

		handle.nudge();
		expect(worker.messages).toContainEqual({ type: "nudge" });

		const stopping = handle.stop();
		expect(worker.messages).toContainEqual({ type: "stop" });
		worker.emitMessage({ type: "stopped" });
		await stopping;

		expect(handle.running).toBe(false);
		expect(worker.terminateCalls).toBe(1);
	});

	it("rejects immediately when the worker exits before ready", async () => {
		const worker = new FakeExtractionWorker();
		const starting = startExtractionThread({
			init: testInit(),
			workerFactory: fakeFactory(worker),
			readyTimeoutMs: 100,
		});

		worker.emitExit(1);

		await expect(starting).rejects.toThrow("exited with code 1 before becoming ready");
	});

	it("rejects and terminates when ready timeout expires", async () => {
		const worker = new FakeExtractionWorker();
		const starting = startExtractionThread({
			init: testInit(),
			workerFactory: fakeFactory(worker),
			readyTimeoutMs: 1,
		});

		await expect(starting).rejects.toThrow("failed to become ready within 1ms");
		expect(worker.terminateCalls).toBe(1);
	});

	it("terminates when stop handshake times out", async () => {
		const worker = new FakeExtractionWorker();
		const starting = startExtractionThread({
			init: testInit(),
			workerFactory: fakeFactory(worker),
			readyTimeoutMs: 50,
			stopTimeoutMs: 1,
		});
		worker.emitMessage({ type: "ready" });
		const handle = await starting;

		await handle.stop();

		expect(worker.messages).toContainEqual({ type: "stop" });
		expect(worker.terminateCalls).toBeGreaterThanOrEqual(2);
		expect(handle.running).toBe(false);
	});
});
