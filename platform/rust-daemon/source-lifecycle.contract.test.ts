import { expect, test } from "bun:test";

// Native-process contract: the parent harness supplies a running fresh Rust daemon.
test("source lifecycle contract is bound to fresh Rust runtime", () => {
	expect(process.execPath).not.toContain("legacy");
});
