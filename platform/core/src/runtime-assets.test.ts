import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRuntimeAsset, resolveRuntimeAssetDirectory } from "./runtime-assets";

const fixtures: string[] = [];
afterEach(() => {
	for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "runtime-assets-"));
	fixtures.push(root);
	mkdirSync(join(root, "src", "nested"), { recursive: true });
	mkdirSync(join(root, "dist"));
	writeFileSync(join(root, "package.json"), "{}");
	writeFileSync(join(root, "src", "worker.ts"), "throw new Error('source must never execute')");
	return root;
}

test("source and installed callers execute the same built worker", () => {
	const root = fixture();
	writeFileSync(join(root, "dist", "worker.js"), "console.log('built-worker')");
	for (const origin of [
		pathToFileURL(join(root, "src", "nested", "caller.ts")),
		pathToFileURL(join(root, "dist", "daemon.js")),
	]) {
		const asset = resolveRuntimeAsset("worker.js", origin);
		const result = Bun.spawnSync([process.execPath, asset]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim()).toBe("built-worker");
	}
});

test("missing built asset fails even while the corresponding source exists", () => {
	const root = fixture();
	expect(() => resolveRuntimeAsset("worker.js", join(root, "src", "caller.ts"))).toThrow(
		"Missing runtime asset worker.js",
	);
	expect(() => resolveRuntimeAsset("worker.ts", join(root, "src", "caller.ts"))).toThrow("not source files");
});

test("directories and overrides are validated without an alternate-path fallback", () => {
	const root = fixture();
	mkdirSync(join(root, "connectors"));
	expect(resolveRuntimeAssetDirectory("connectors", join(root, "dist", "daemon.js"))).toBe(join(root, "connectors"));
	expect(() => resolveRuntimeAssetDirectory(join(root, "missing"), join(root, "dist", "daemon.js"))).toThrow(
		"Missing runtime asset",
	);
	for (const name of ["../worker.js", "", "bad\0.js"]) {
		expect(() => resolveRuntimeAsset(name, join(root, "src", "caller.ts"))).toThrow();
	}
});
