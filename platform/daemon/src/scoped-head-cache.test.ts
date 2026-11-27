import { expect, test } from "bun:test";
import { ScopedHeadCache } from "./scoped-head-cache";

test("scoped head cache isolates readers and invalidates before another read", () => {
	const removed: string[] = [];
	const cache = new ScopedHeadCache((key) => removed.push(key));
	const alice = { generated: true, status: "current" as const, content: "Public and HR" };
	const bob = { generated: true, status: "current" as const, content: "Public" };
	cache.set("alice", "revision:1:visibility:1", alice);
	cache.set("bob", "revision:1:visibility:1", bob);
	expect(cache.get("bob", "revision:1:visibility:1")).toEqual(bob);
	expect(cache.get("bob", "revision:1:visibility:1")?.content).not.toContain("HR");
	expect(cache.get("alice", "revision:2:visibility:1")).toBeUndefined();
	expect(removed).toContain("alice");
	cache.invalidate("bob");
	expect(cache.get("bob", "revision:1:visibility:1")).toBeUndefined();
	cache.set("alice", "revision:2:visibility:1", alice);
	cache.clear();
	expect(cache.get("alice", "revision:2:visibility:1")).toBeUndefined();
});

test("scoped head cache has bounded entries and does not retain oversized values", () => {
	const removed: string[] = [];
	const cache = new ScopedHeadCache((key) => removed.push(key));
	for (let i = 0; i < 65; i++) cache.set(String(i), "one", { generated: true, status: "current", content: "Public" });
	expect(cache.get("0", "one")).toBeUndefined();
	expect(cache.get("64", "one")?.content).toBe("Public");
	cache.set("large", "one", { generated: true, status: "current", content: "x".repeat(262145) });
	expect(cache.get("large", "one")).toBeUndefined();
	expect(removed).toContain("0");
});
