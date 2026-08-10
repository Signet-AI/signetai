import { describe, expect, it } from "bun:test";
import {
	sourceClassForKind,
	sourceCountBucket,
	sourceDurationBucket,
	sourceFailureClass,
	sourceLagBucket,
	sourceSizeBucket,
} from "./source-lifecycle-telemetry";

describe("source lifecycle telemetry contract", () => {
	it("maps providers into a fixed taxonomy instead of forwarding provider input", () => {
		expect(sourceClassForKind("obsidian")).toBe("note_vault");
		expect(sourceClassForKind("github")).toBe("repository");
		expect(sourceClassForKind("user-defined-provider-with-a-path-/Users/alice/vault")).toBe("other");
	});

	it("bounds corpus, size, duration, and freshness values into finite buckets", () => {
		expect(sourceCountBucket(Number.MAX_SAFE_INTEGER)).toBe("10k_plus");
		expect(sourceCountBucket(-1)).toBe("0");
		expect(sourceSizeBucket(1_000_000_000)).toBe("1gb_plus");
		expect(sourceDurationBucket(Number.POSITIVE_INFINITY)).toBe("unknown");
		expect(sourceLagBucket(Number.MAX_SAFE_INTEGER)).toBe("7d_plus");
	});

	it("classifies failures without exposing their message", () => {
		expect(sourceFailureClass(new Error("401 https://private.example/user-token"))).toBe("authentication");
		expect(sourceFailureClass({ message: "429 rate limit" })).toBe("rate_limited");
		expect(sourceFailureClass(new Error("Obsidian root is required"))).toBe("configuration");
		expect(sourceFailureClass(new Error("Invalid Discord source configuration"))).toBe("configuration");
		expect(sourceFailureClass(new Error("invalid configuration"))).toBe("configuration");
		expect(sourceFailureClass(new Error("unexpected implementation detail with /Users/alice/private.md"))).toBe(
			"unknown",
		);
	});
});
