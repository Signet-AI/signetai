import { expect, test } from "bun:test";
import { QueryCache } from "./query-cache";

test("warm navigation reuses a read, concurrent stale reads share one request, explicit refresh bypasses freshness", async () => {
	let now = 1000;
	const cache = new QueryCache(undefined, () => now);
	let calls = 0;
	let release!: (value: { revision: number }) => void;
	const fetcher = async () => {
		calls++;
		return { revision: calls };
	};
	await cache.fetch("graph:48", fetcher, 30_000);
	expect(cache.read("graph:48").data).toEqual({ revision: 1 });
	await cache.fetch("graph:48", fetcher, 30_000);
	expect(calls).toBe(1);
	now += 30_000;
	const slow = () => {
		calls++;
		return new Promise<{ revision: number }>((resolve) => {
			release = resolve;
		});
	};
	const first = cache.fetch("graph:48", slow, 30_000);
	const second = cache.fetch("graph:48", slow, 30_000);
	await Promise.resolve();
	expect(calls).toBe(2);
	expect(cache.read("graph:48").data).toEqual({ revision: 1 });
	release({ revision: 2 });
	expect((await first).data).toEqual((await second).data);
	await cache.fetch("graph:48", fetcher, 30_000, true);
	expect(calls).toBe(3);
});

test("failed background reads preserve a good snapshot and expose failure, without extending freshness", async () => {
	const cache = new QueryCache();
	const good = await cache.fetch("graph", async () => ({ entities: ["one"] }), 30_000);
	const failed = await cache.fetch("graph", async () => null, 30_000, true);
	expect(failed.data).toEqual(good.data);
	expect(failed.error).toBeTruthy();
	expect(failed.updatedAt).toBe(good.updatedAt);
	const wrapped = await cache.fetch("harnesses", async () => ({ data: { installed: ["pi"] }, error: null }), 30_000);
	const failure = await cache.fetch("harnesses", async () => ({ data: null, error: "timed out" }), 30_000, true);
	expect(failure.data).toEqual({ ...wrapped.data, error: "timed out" });
});

test("invalidated in-flight reads cannot resurrect deleted or previous-session data", async () => {
	const cache = new QueryCache();
	let release!: (value: string[]) => void;
	const pending = cache.fetch(
		"memories",
		() =>
			new Promise<string[]>((resolve) => {
				release = resolve;
			}),
		30_000,
	);
	await Promise.resolve();
	cache.clear(false);
	release(["old private data"]);
	expect((await pending).data).toBeNull();
	expect(cache.read("memories").data).toBeNull();
});

test("cache evicts by least recent use, payload budget and inactive age, and skips oversized payloads", async () => {
	let now = 1000;
	const cache = new QueryCache({ entries: 2, bytes: 24, entryBytes: 16, retentionMs: 50 }, () => now);
	await cache.fetch("a", async () => "first", 30_000);
	now++;
	await cache.fetch("b", async () => "second", 30_000);
	now++;
	cache.read("a");
	now++;
	await cache.fetch("c", async () => "third", 30_000);
	expect(cache.read("b").data).toBeNull();
	expect(cache.read("a").data).toBe("first");
	await cache.fetch("large", async () => "a".repeat(100), 30_000);
	expect(cache.read("large").data).toBeNull();
	now += 51;
	expect(cache.read("a").data).toBeNull();
	expect(cache.read("c").data).toBeNull();
	const bytes = new QueryCache({ entries: 10, bytes: 12, entryBytes: 16, retentionMs: 50 });
	await bytes.fetch("a", async () => "1234567", 30_000);
	await bytes.fetch("b", async () => "7654321", 30_000);
	expect(bytes.read("a").data).toBeNull();
	expect(bytes.read("b").data).toBe("7654321");
});

test("targeted invalidation preserves unrelated fresh reads and rejects only affected pending results", async () => {
	const cache = new QueryCache();
	await cache.fetch("status", async () => ({ online: true }), 30_000);
	let release!: (value: { revision: number }) => void;
	const pending = cache.fetch(
		"graph",
		() =>
			new Promise<{ revision: number }>((resolve) => {
				release = resolve;
			}),
		30_000,
	);
	await Promise.resolve();
	cache.invalidate((key) => key === "graph");
	release({ revision: 1 });
	expect((await pending).data).toBeNull();
	let reads = 0;
	await cache.fetch(
		"status",
		async () => {
			reads++;
			return { online: false };
		},
		30_000,
	);
	expect(reads).toBe(0);
});
