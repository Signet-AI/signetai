import assert from "node:assert/strict";
import test from "node:test";
import { assertBunRuntime, platformVecPackage } from "./stage-runtime.mjs";

test("assertBunRuntime rejects Node even when platform and architecture match", () => {
	assert.throws(() => assertBunRuntime(process.execPath, process.arch, process.platform), /Runtime is not Bun/);
});

test("platformVecPackage rejects unsupported target combinations", () => {
	assert.throws(() => platformVecPackage("linux", "ia32"), /Unsupported sqlite-vec target: linux\/ia32/);
	assert.throws(() => platformVecPackage("win32", "arm64"), /Unsupported sqlite-vec target: win32\/arm64/);
	assert.throws(() => platformVecPackage("darwin", "ia32"), /Unsupported sqlite-vec target: darwin\/ia32/);
});
