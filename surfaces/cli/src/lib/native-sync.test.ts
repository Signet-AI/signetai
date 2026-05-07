import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireNativeSyncLock,
	embeddingProvider,
	hasNativeModelCache,
	isRecord,
	releaseNativeSyncLock,
} from "./native-sync.js";

describe("isRecord", () => {
	it("returns true for plain objects", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ a: 1 })).toBe(true);
	});

	it("returns false for null", () => {
		expect(isRecord(null)).toBe(false);
	});

	it("returns false for primitives", () => {
		expect(isRecord(42)).toBe(false);
		expect(isRecord("str")).toBe(false);
		expect(isRecord(undefined)).toBe(false);
		expect(isRecord(true)).toBe(false);
	});

	it("returns true for arrays (they are objects)", () => {
		expect(isRecord([])).toBe(true);
	});
});

describe("embeddingProvider", () => {
	let root: string;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("returns 'native' when no config file exists", () => {
		root = mkdtempSync(join(tmpdir(), "embed-provider-"));
		expect(embeddingProvider(root)).toBe("native");
	});

	it("reads provider from embedding.provider in agent.yaml", () => {
		root = mkdtempSync(join(tmpdir(), "embed-provider-"));
		writeFileSync(
			join(root, "agent.yaml"),
			"embedding:\n  provider: ollama\n  model: nomic-embed-text\n",
		);
		expect(embeddingProvider(root)).toBe("ollama");
	});

	it("reads provider from embedding.provider in AGENT.yaml", () => {
		root = mkdtempSync(join(tmpdir(), "embed-provider-"));
		writeFileSync(join(root, "AGENT.yaml"), "embedding:\n  provider: openai\n");
		expect(embeddingProvider(root)).toBe("openai");
	});

	it("reads provider from config.yaml as fallback", () => {
		root = mkdtempSync(join(tmpdir(), "embed-provider-"));
		writeFileSync(join(root, "config.yaml"), "embedding:\n  provider: llama-cpp\n");
		expect(embeddingProvider(root)).toBe("llama-cpp");
	});

	it("reads from memory.embeddings.provider (nested path)", () => {
		root = mkdtempSync(join(tmpdir(), "embed-provider-"));
		writeFileSync(
			join(root, "agent.yaml"),
			"memory:\n  embeddings:\n    provider: openai\n",
		);
		expect(embeddingProvider(root)).toBe("openai");
	});

	it("reads from embeddings.provider (legacy path)", () => {
		root = mkdtempSync(join(tmpdir(), "embed-provider-"));
		writeFileSync(join(root, "agent.yaml"), "embeddings:\n  provider: ollama\n");
		expect(embeddingProvider(root)).toBe("ollama");
	});

	it("prefers embedding.provider over legacy paths", () => {
		root = mkdtempSync(join(tmpdir(), "embed-provider-"));
		writeFileSync(
			join(root, "agent.yaml"),
			"embedding:\n  provider: native\nembeddings:\n  provider: ollama\n",
		);
		expect(embeddingProvider(root)).toBe("native");
	});

	it("returns 'native' for unrecognized provider value", () => {
		root = mkdtempSync(join(tmpdir(), "embed-provider-"));
		writeFileSync(join(root, "agent.yaml"), "embedding:\n  provider: unknown-thing\n");
		expect(embeddingProvider(root)).toBe("native");
	});

	it("returns 'none' when configured as none", () => {
		root = mkdtempSync(join(tmpdir(), "embed-provider-"));
		writeFileSync(join(root, "agent.yaml"), "embedding:\n  provider: none\n");
		expect(embeddingProvider(root)).toBe("none");
	});

	it("handles malformed YAML gracefully", () => {
		root = mkdtempSync(join(tmpdir(), "embed-provider-"));
		writeFileSync(join(root, "agent.yaml"), ":::invalid yaml{{[");
		expect(embeddingProvider(root)).toBe("native");
	});

	it("skips first file if malformed and reads fallback", () => {
		root = mkdtempSync(join(tmpdir(), "embed-provider-"));
		writeFileSync(join(root, "agent.yaml"), ":::broken");
		writeFileSync(join(root, "config.yaml"), "embedding:\n  provider: ollama\n");
		expect(embeddingProvider(root)).toBe("ollama");
	});
});

describe("hasNativeModelCache", () => {
	let root: string;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("returns false when .models directory does not exist", () => {
		root = mkdtempSync(join(tmpdir(), "model-cache-"));
		expect(hasNativeModelCache(root)).toBe(false);
	});

	it("returns false when .models directory is empty", () => {
		root = mkdtempSync(join(tmpdir(), "model-cache-"));
		mkdirSync(join(root, ".models"));
		expect(hasNativeModelCache(root)).toBe(false);
	});

	it("returns true when .models directory has files", () => {
		root = mkdtempSync(join(tmpdir(), "model-cache-"));
		mkdirSync(join(root, ".models"));
		writeFileSync(join(root, ".models", "model.onnx"), "");
		expect(hasNativeModelCache(root)).toBe(true);
	});
});

describe("acquireNativeSyncLock / releaseNativeSyncLock", () => {
	let root: string;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("acquires a lock and creates the lock file", async () => {
		root = mkdtempSync(join(tmpdir(), "lock-test-"));
		mkdirSync(join(root, ".daemon"), { recursive: true });

		const lock = await acquireNativeSyncLock(root);
		expect(lock).not.toBeNull();
		expect(existsSync(lock!.path)).toBe(true);

		releaseNativeSyncLock(lock!);
		expect(existsSync(lock!.path)).toBe(false);
	});

	it("returns null when lock is already held by this process", async () => {
		root = mkdtempSync(join(tmpdir(), "lock-test-"));
		mkdirSync(join(root, ".daemon"), { recursive: true });

		const lock1 = await acquireNativeSyncLock(root);
		expect(lock1).not.toBeNull();

		const startMs = Date.now();
		const lock2 = await acquireNativeSyncLock(root);
		const elapsed = Date.now() - startMs;

		// Should timeout (15s) trying to acquire. But current process is alive
		// so stale-lock detection won't clear it. Give it a smaller window —
		// the lock file's age threshold is 5 minutes, so it won't auto-clear.
		// In tests, the 15s timeout makes this slow. We verify it returns null
		// because the lock is held.
		expect(lock2).toBeNull();
		expect(elapsed).toBeGreaterThanOrEqual(14_000);

		releaseNativeSyncLock(lock1!);
	}, 20_000);

	it("clears stale lock from dead PID", async () => {
		root = mkdtempSync(join(tmpdir(), "lock-test-"));
		const lockDir = join(root, ".daemon");
		mkdirSync(lockDir, { recursive: true });

		const lockPath = join(lockDir, "sync-native.lock");
		writeFileSync(lockPath, "999999999\n0\n");

		const lock = await acquireNativeSyncLock(root);
		expect(lock).not.toBeNull();

		releaseNativeSyncLock(lock!);
	});
});
