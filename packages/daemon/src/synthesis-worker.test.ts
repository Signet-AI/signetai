import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { findSqliteVecExtension } from "@signet/core";
import { closeDbAccessor, getDbAccessor, hasDbAccessor, initDbAccessorLite } from "./db-accessor";
import { type SynthesisRequest, getSynthesisWorker, handleSynthesisRequest, setSynthesisWorker } from "./hooks";

const AGENTS_DIR = process.env.SIGNET_PATH?.trim() || join(homedir(), ".agents");
const DB_PATH = join(AGENTS_DIR, "memory", "memories.db");
const VEC_EXT_PATH = findSqliteVecExtension();
const DB_AVAILABLE = existsSync(DB_PATH) && VEC_EXT_PATH !== null;
const WORKER_PATH = join(import.meta.dir, "synthesis-render-worker.ts");

function waitForWorkerMessage<T>(worker: Worker, pred: (m: T) => boolean, timeout = 10_000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			worker.off("message", handler);
			reject(new Error(`waitForWorkerMessage timed out after ${timeout}ms`));
		}, timeout);

		function handler(msg: unknown): void {
			if (pred(msg as T)) {
				clearTimeout(timer);
				worker.off("message", handler);
				resolve(msg as T);
			}
		}

		worker.on("message", handler);
	});
}

describe("initDbAccessorLite", () => {
	afterEach(() => {
		closeDbAccessor();
	});

	test("initializes without error on real DB", () => {
		if (!DB_AVAILABLE) {
			console.warn("SKIP: real DB not available");
			return;
		}
		expect(() => initDbAccessorLite(DB_PATH, VEC_EXT_PATH as string)).not.toThrow();
		expect(hasDbAccessor()).toBe(true);
	});

	test("getDbAccessor returns accessor after init", () => {
		if (!DB_AVAILABLE) {
			console.warn("SKIP: real DB not available");
			return;
		}
		initDbAccessorLite(DB_PATH, VEC_EXT_PATH as string);
		const acc = getDbAccessor();
		expect(acc).toBeTruthy();
	});

	test("withReadDb can query memories table", () => {
		if (!DB_AVAILABLE) {
			console.warn("SKIP: real DB not available");
			return;
		}
		initDbAccessorLite(DB_PATH, VEC_EXT_PATH as string);
		const acc = getDbAccessor();
		const result = acc.withReadDb((db) => {
			return db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number } | undefined;
		});
		expect(result).toBeTruthy();
		expect(typeof result?.n).toBe("number");
	});

	test("withReadDb can call vec_version() after extension load", () => {
		if (!DB_AVAILABLE) {
			console.warn("SKIP: real DB not available");
			return;
		}
		initDbAccessorLite(DB_PATH, VEC_EXT_PATH as string);
		const acc = getDbAccessor();
		const result = acc.withReadDb((db) => {
			return db.prepare("SELECT vec_version() AS v").get() as { v: string } | undefined;
		});
		expect(result).toBeTruthy();
		expect(typeof result?.v).toBe("string");
		expect((result?.v ?? "").length).toBeGreaterThan(0);
	});

	test("throws if called twice without closeDbAccessor", () => {
		if (!DB_AVAILABLE) {
			console.warn("SKIP: real DB not available");
			return;
		}
		initDbAccessorLite(DB_PATH, VEC_EXT_PATH as string);
		expect(() => initDbAccessorLite(DB_PATH, VEC_EXT_PATH as string)).toThrow("DbAccessor already initialised");
	});
});

describe("synthesis-render-worker message protocol", () => {
	let worker: Worker | null = null;

	beforeAll(() => {
		if (!DB_AVAILABLE) return;
		worker = new Worker(WORKER_PATH);
	});

	afterAll(async () => {
		if (worker !== null) {
			await worker.terminate();
			worker = null;
		}
	});

	test("init message produces ready response", async () => {
		if (!DB_AVAILABLE || worker === null) {
			console.warn("SKIP: real DB not available");
			return;
		}

		const readyPromise = waitForWorkerMessage<{ type: string }>(
			worker,
			(m) => typeof m === "object" && m !== null && (m as Record<string, unknown>).type === "ready",
		);

		worker.postMessage({
			type: "init",
			dbPath: DB_PATH,
			vecExtensionPath: VEC_EXT_PATH,
		});

		const msg = await readyPromise;
		expect(msg.type).toBe("ready");
	}, 15_000);

	test("render message produces result response", async () => {
		if (!DB_AVAILABLE || worker === null) {
			console.warn("SKIP: real DB not available");
			return;
		}

		const requestId = "test-render-001";
		const resultPromise = waitForWorkerMessage<Record<string, unknown>>(
			worker,
			(m) => {
				const obj = m as Record<string, unknown>;
				return (
					typeof obj === "object" &&
					obj !== null &&
					(obj.type === "result" || obj.type === "error") &&
					obj.requestId === requestId
				);
			},
			60_000,
		);

		worker.postMessage({ type: "render", agentId: "default", requestId });

		const msg = await resultPromise;
		expect(msg.requestId).toBe(requestId);
		expect(["result", "error"]).toContain(msg.type as string);
		if (msg.type === "result") {
			expect(typeof msg.content).toBe("string");
			expect(typeof msg.fileCount).toBe("number");
		}
	}, 90_000);

	test("render with unknown agentId returns error or empty result", async () => {
		if (!DB_AVAILABLE || worker === null) {
			console.warn("SKIP: real DB not available");
			return;
		}

		const requestId = "test-render-unknown-agent";
		const resultPromise = waitForWorkerMessage<Record<string, unknown>>(
			worker,
			(m) => {
				const obj = m as Record<string, unknown>;
				return (
					typeof obj === "object" &&
					obj !== null &&
					(obj.type === "result" || obj.type === "error") &&
					obj.requestId === requestId
				);
			},
			60_000,
		);

		worker.postMessage({
			type: "render",
			agentId: "nonexistent-agent-xyz-12345",
			requestId,
		});

		const msg = await resultPromise;
		expect(msg.requestId).toBe(requestId);
		expect(["result", "error"]).toContain(msg.type as string);
	}, 90_000);
});

describe("handleSynthesisRequest", () => {
	const origSigNetPath = process.env.SIGNET_PATH;
	let tmpDir: string | null = null;

	afterEach(() => {
		closeDbAccessor();
		setSynthesisWorker(null);
		if (origSigNetPath !== undefined) {
			process.env.SIGNET_PATH = origSigNetPath;
		} else {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		}
		if (tmpDir !== null && existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = null;
		}
	});

	test("returns SynthesisResponse with writeToDisk:false (null worker fallback)", async () => {
		if (!DB_AVAILABLE) {
			console.warn("SKIP: real DB not available");
			return;
		}
		setSynthesisWorker(null);
		initDbAccessorLite(DB_PATH, VEC_EXT_PATH as string);

		const req: SynthesisRequest = { trigger: "manual" };
		const resp = await handleSynthesisRequest(req, {
			agentId: "default",
			writeToDisk: false,
		});

		expect(resp.harness).toBe("daemon");
		expect(resp.model).toBe("projection");
		expect(typeof resp.prompt).toBe("string");
		expect(typeof resp.fileCount).toBe("number");
	}, 60_000);

	test("writeToDisk:true writes MEMORY.md to SIGNET_PATH", async () => {
		if (!DB_AVAILABLE) {
			console.warn("SKIP: real DB not available");
			return;
		}
		tmpDir = join(homedir(), `.signet-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tmpDir, "memory"), { recursive: true });
		process.env.SIGNET_PATH = tmpDir;

		setSynthesisWorker(null);
		initDbAccessorLite(DB_PATH, VEC_EXT_PATH as string);

		const req: SynthesisRequest = { trigger: "manual" };
		await handleSynthesisRequest(req, {
			agentId: "default",
			writeToDisk: true,
		});

		const memoryMdPath = join(tmpDir, "MEMORY.md");
		expect(existsSync(memoryMdPath)).toBe(true);
		const content = readFileSync(memoryMdPath, "utf8");
		expect(typeof content).toBe("string");
	}, 60_000);

	test("null worker fallback returns valid response shape", async () => {
		if (!DB_AVAILABLE) {
			console.warn("SKIP: real DB not available");
			return;
		}
		setSynthesisWorker(null);
		initDbAccessorLite(DB_PATH, VEC_EXT_PATH as string);

		const req: SynthesisRequest = { trigger: "scheduled" };
		const resp = await handleSynthesisRequest(req, { agentId: "default" });

		expect(resp).toHaveProperty("harness");
		expect(resp).toHaveProperty("model");
		expect(resp).toHaveProperty("prompt");
		expect(resp).toHaveProperty("fileCount");
		expect(resp.harness).toBe("daemon");
		expect(resp.model).toBe("projection");
	}, 60_000);

	test("worker render errors fall back to sync rendering instead of returning an empty success", async () => {
		if (!DB_AVAILABLE) {
			console.warn("SKIP: real DB not available");
			return;
		}
		initDbAccessorLite(DB_PATH, VEC_EXT_PATH as string);
		const worker = new Worker(
			`
				const { parentPort } = require("node:worker_threads");
				parentPort.on("message", (msg) => {
					if (msg.type === "render") {
						parentPort.postMessage({
							type: "error",
							requestId: msg.requestId,
							error: "boom",
						});
					}
				});
			`,
			{ eval: true },
		);
		setSynthesisWorker(worker);

		try {
			const req: SynthesisRequest = { trigger: "scheduled" };
			const resp = await handleSynthesisRequest(req, { agentId: "default" });

			expect(resp.harness).toBe("daemon");
			expect(resp.model).toBe("projection");
			expect(typeof resp.prompt).toBe("string");
			expect(typeof resp.fileCount).toBe("number");
			expect(getSynthesisWorker()).toBeNull();
		} finally {
			await worker.terminate();
		}
	});

	test("regression: getSynthesisWorker returns null after setSynthesisWorker(null)", () => {
		setSynthesisWorker(null);
		expect(getSynthesisWorker()).toBeNull();
	});
});
