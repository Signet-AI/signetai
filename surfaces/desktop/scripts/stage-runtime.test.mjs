import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBunRuntime } from "./stage-runtime.mjs";

describe("stage-runtime Bun validation", () => {
	it("rejects an architecture-mismatched staged runtime", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-stage-runtime-"));
		const runtimePath = join(directory, "bun");
		try {
			writeFileSync(runtimePath, "fake bun runtime\n");
			chmodSync(runtimePath, 0o755);

			expect(() => assertBunRuntime(runtimePath, "arm64", "linux", () => ({ platform: "linux", arch: "x64" }))).toThrow(
				"Bun runtime architecture mismatch: expected arm64, got x64",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
