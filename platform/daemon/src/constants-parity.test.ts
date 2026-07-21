/**
 * Cross-daemon constant parity check.
 *
 * The Rust daemon re-declares queue threshold constants that originate in
 * diagnostics.ts. This test asserts they stay in sync. If someone changes
 * one side without the other, this test fails.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	QUEUE_MAX_DEAD_RATE,
	QUEUE_MAX_DEPTH,
	QUEUE_MAX_OLDEST_AGE_SEC,
} from "./diagnostics";

const RUST_MAIN_RS = join(import.meta.dir, "..", "..", "daemon-rs", "crates", "signet-daemon", "src", "main.rs");
const rustSource = readFileSync(RUST_MAIN_RS, "utf-8");

function extractRustConst(type: "i64" | "f64", name: string): number {
	const pattern = new RegExp(`const ${name}: ${type} = ([0-9.]+)`);
	const match = rustSource.match(pattern);
	if (!match?.[1]) throw new Error(`Rust constant ${name} not found in main.rs`);
	return type === "i64" ? parseInt(match[1], 10) : parseFloat(match[1]);
}

test("QUEUE_MAX_DEPTH matches between TS and Rust", () => {
	const rust = extractRustConst("i64", "QUEUE_MAX_DEPTH");
	expect(QUEUE_MAX_DEPTH).toBe(rust);
});

test("QUEUE_MAX_DEAD_RATE matches between TS and Rust", () => {
	const rust = extractRustConst("f64", "QUEUE_MAX_DEAD_RATE");
	expect(QUEUE_MAX_DEAD_RATE).toBe(rust);
});

test("QUEUE_MAX_OLDEST_AGE_SEC matches between TS and Rust", () => {
	const rust = extractRustConst("f64", "QUEUE_MAX_OLDEST_AGE_SEC");
	expect(QUEUE_MAX_OLDEST_AGE_SEC).toBe(rust);
});
