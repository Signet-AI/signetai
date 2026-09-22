import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBunRuntime } from "./stage-runtime.mjs";

describe("default Bun runtime probe contract", () => {
	it("accepts plain version output from the real Bun executable when available", () => {
		const bun = Bun.which("bun");
		if (!bun) return;
		expect(() => assertBunRuntime(bun, process.arch, process.platform)).not.toThrow("invalid result");
	});

	it("requires injected probes to provide truthful platform and architecture metadata", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-bun-probe-"));
		const runtime = join(directory, "bun");
		try {
			writeFileSync(runtime, "fake");
			chmodSync(runtime, 0o755);
			expect(() =>
				assertBunRuntime(runtime, "arm64", "linux", () => ({ platform: "linux", arch: "x64", bun: "1.0.0" })),
			).toThrow("architecture mismatch");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
