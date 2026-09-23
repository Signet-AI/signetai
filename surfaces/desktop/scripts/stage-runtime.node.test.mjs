import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { assertBunRuntime, platformVecPackage } from "./stage-runtime.mjs";

const nodeExecutable = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();

test("assertBunRuntime rejects Node even when platform and architecture match", () => {
	assert.throws(() => assertBunRuntime(nodeExecutable, process.arch, process.platform), /Runtime is not Bun/);
});

test("platformVecPackage rejects unsupported target combinations", () => {
	assert.throws(() => platformVecPackage("linux", "ia32"), /Unsupported sqlite-vec target: linux\/ia32/);
	assert.throws(() => platformVecPackage("win32", "arm64"), /Unsupported sqlite-vec target: win32\/arm64/);
	assert.throws(() => platformVecPackage("darwin", "ia32"), /Unsupported sqlite-vec target: darwin\/ia32/);
});
