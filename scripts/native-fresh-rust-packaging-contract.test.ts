import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { resolveFreshRustDaemon } from "./lib/fresh-rust-daemon";

describe("fresh Rust production cutover", () => {
	it("accepts native checkout debug and release artifacts", () => {
		for (const profile of ["debug", "release"]) {
			const root = mkdtempSync(join(tmpdir(), "signet-cutover-"));
			const directory = join(root, "platform", "rust-daemon", "target", profile);
			mkdirSync(directory, { recursive: true });
			const binary = join(directory, "signet-daemon");
			writeFileSync(binary, "native");
			chmodSync(binary, 0o755);
			expect(resolveFreshRustDaemon(root)).toBe(binary);
		}
	});

	it("does not fall back to displaced TypeScript daemon artifacts", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-cutover-"));
		const directory = join(root, "platform", "rust-daemon", "target", "release");
		mkdirSync(directory, { recursive: true });
		const binary = join(directory, "signet-daemon.ts");
		writeFileSync(binary, "legacy");
		chmodSync(binary, 0o755);
		expect(() => resolveFreshRustDaemon(root)).toThrow(/packaged Rust daemon binary missing/);
	});
});
