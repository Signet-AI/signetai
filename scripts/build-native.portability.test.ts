import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const buildScript = join(import.meta.dir, "build-native.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function writeCommand(path: string, exitCode: 0 | 1): void {
	if (process.platform === "win32") {
		writeFileSync(path, `@echo off\r\nexit /b ${exitCode}\r\n`);
		return;
	}
	writeFileSync(path, `#!/bin/sh\nexit ${exitCode}\n`);
	chmodSync(path, 0o755);
}

function commandName(name: string): string {
	return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(options: {
	readonly locator?: boolean;
	readonly cargoStatus: 0 | 1;
	readonly bunStatus: 0 | 1;
}): ReturnType<typeof spawnSync> {
	const binDir = mkdtempSync(join(tmpdir(), "signet-build-native-portability-"));
	tempDirs.push(binDir);
	if (options.locator !== false) {
		writeCommand(join(binDir, commandName(process.platform === "win32" ? "where" : "which")), 0);
	}
	writeCommand(join(binDir, commandName("cargo")), options.cargoStatus);
	writeCommand(join(binDir, commandName("bun")), options.bunStatus);
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: binDir };
	delete env.SIGNET_SKIP_NATIVE_BUILD;
	return spawnSync(process.execPath, [buildScript], {
		cwd: root,
		encoding: "utf8",
		env,
	});
}

describe("build-native portability", () => {
	test("probes Cargo directly when which/where is unavailable", () => {
		const result = run({ locator: false, cargoStatus: 0, bunStatus: 1 });

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("native build failed");
		expect(result.stderr).not.toContain("cargo is required");
	});

	test("distinguishes a located but broken Cargo executable from build failure", () => {
		const result = run({ locator: true, cargoStatus: 1, bunStatus: 1 });

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("cargo toolchain is not runnable");
		expect(result.stderr).not.toContain("native build failed");
	});
});
