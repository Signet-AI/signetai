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

interface BuildOptions {
	readonly skipNativeBuild?: boolean;
	readonly cargoAvailable?: boolean;
	readonly nativeBuildFails?: boolean;
}

function runBuild(options: BuildOptions = {}): ReturnType<typeof spawnSync> {
	const binDir = mkdtempSync(join(tmpdir(), "signet-build-native-test-"));
	tempDirs.push(binDir);
	const which = join(binDir, "which");
	writeFileSync(which, `#!/bin/sh\nexit ${options.cargoAvailable ? 0 : 1}\n`);
	chmodSync(which, 0o755);
	if (options.nativeBuildFails) {
		const bun = join(binDir, "bun");
		writeFileSync(bun, "#!/bin/sh\nexit 1\n");
		chmodSync(bun, 0o755);
	}

	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: binDir,
		SIGNET_SKIP_NATIVE_BUILD: options.skipNativeBuild ? "1" : undefined,
	};

	return spawnSync(process.execPath, [buildScript], {
		cwd: root,
		encoding: "utf8",
		env,
	});
}

describe("build-native", () => {
	test("fails when cargo is missing instead of silently skipping the native build", () => {
		const result = runBuild();

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("cargo is required");
		expect(result.stderr).toContain("SIGNET_SKIP_NATIVE_BUILD=1");
	});

	test("supports an explicit opt-out when the native build is intentionally skipped", () => {
		const result = runBuild({ skipNativeBuild: true });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("SIGNET_SKIP_NATIVE_BUILD=1");
	});

	test("fails when the native build command fails", () => {
		const result = runBuild({ cargoAvailable: true, nativeBuildFails: true });

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("native build failed");
		expect(result.stderr).toContain("SIGNET_SKIP_NATIVE_BUILD=1");
	});
});
