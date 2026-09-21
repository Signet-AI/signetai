import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { resolveFreshRustDaemon } from "./lib/fresh-rust-daemon";

describe("fresh Rust production cutover", () => {
	it("does not fall back to checkout debug or release artifacts", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-cutover-"));
		const release = join(root, "platform", "rust-daemon", "target", "release");
		mkdirSync(release, { recursive: true });
		const binary = join(release, "signet-daemon");
		writeFileSync(binary, "not a staged install");
		chmodSync(binary, 0o755);
		expect(() => resolveFreshRustDaemon(root)).toThrow(/packaged Rust daemon binary missing/);
	});
});
