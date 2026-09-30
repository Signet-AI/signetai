import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fs = await import("node:fs");
const childProcess = await import("node:child_process");

function resolveTestPythonPath(): string {
	for (const command of ["python3", "python"]) {
		const result = spawnSync(command, ["-c", "import sys; print(sys.executable)"], { encoding: "utf-8" });
		const executable = result.stdout.trim();
		if (result.status === 0 && executable) return executable;
	}
	throw new Error("A Python 3 interpreter is required for the Hermes connector tests");
}

test("uninstall does not trust a marker read through a swapped macOS target path", async () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	const originalEnv = {
		HOME: process.env.HOME,
		HERMES_HOME: process.env.HERMES_HOME,
		HERMES_REPO: process.env.HERMES_REPO,
		PYTHON: process.env.PYTHON,
		SIGNET_RACE_TARGET: process.env.SIGNET_RACE_TARGET,
		SIGNET_RACE_ATTACKER: process.env.SIGNET_RACE_ATTACKER,
		SIGNET_RACE_PARKED: process.env.SIGNET_RACE_PARKED,
		SIGNET_RACE_MOVED: process.env.SIGNET_RACE_MOVED,
		SIGNET_RACE_REAL_PYTHON: process.env.SIGNET_RACE_REAL_PYTHON,
	};
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), "signet-hermes-marker-race-")));
	const hermesRepo = join(fixture, "hermes-repo");
	const parent = join(hermesRepo, "plugins", "memory");
	const target = join(parent, "signet");
	const attacker = join(fixture, "attacker-plugin");
	const parked = join(fixture, "parked-plugin");
	const moved = join(fixture, "moved-attacker");
	const markerPath = join(target, "signet.install.json");
	const victimPath = join(target, "unowned-data.txt");
	mkdirSync(target, { recursive: true });
	mkdirSync(attacker);
	writeFileSync(victimPath, "unowned contents\n");
	writeFileSync(
		join(attacker, "signet.install.json"),
		JSON.stringify({
			connector: "@signet/connector-hermes-agent",
			schemaVersion: 1,
			connectorVersion: "0.228.8",
			sourceHash: "attacker-controlled",
			targetKind: "repo",
			installedAt: "2026-09-30T00:00:00.000Z",
		}),
	);

	const pythonPath = resolveTestPythonPath();
	const pythonLauncher = join(fixture, "python-race-launcher");
	writeFileSync(
		pythonLauncher,
		[
			`#!${pythonPath}`,
			"import os",
			"import subprocess",
			"import sys",
			"args = sys.argv[1:]",
			"script = args[1] if len(args) > 1 and args[0] == '-c' else ''",
			"is_marker_read = 'os.open' in script and 'dir_fd=3' in script and args[-1] == 'signet.install.json'",
			"pass_fds = (3,)",
			"if is_marker_read:",
			"    target = os.environ['SIGNET_RACE_TARGET']",
			"    attacker = os.environ['SIGNET_RACE_ATTACKER']",
			"    parked = os.environ['SIGNET_RACE_PARKED']",
			"    moved = os.environ['SIGNET_RACE_MOVED']",
			"    os.rename(target, parked)",
			"    os.rename(attacker, target)",
			"    try:",
			"        result = subprocess.run([os.environ['SIGNET_RACE_REAL_PYTHON'], *args], pass_fds=pass_fds, check=False)",
			"    finally:",
			"        os.rename(target, moved)",
			"        os.rename(parked, target)",
			"        os.rename(moved, attacker)",
			"    raise SystemExit(result.returncode)",
			"result = subprocess.run([os.environ['SIGNET_RACE_REAL_PYTHON'], *args], pass_fds=pass_fds, check=False)",
			"raise SystemExit(result.returncode)",
			"",
		].join("\n"),
	);
	chmodSync(pythonLauncher, 0o755);
	process.env.HOME = fixture;
	process.env.HERMES_HOME = join(fixture, ".hermes");
	process.env.HERMES_REPO = hermesRepo;
	process.env.PYTHON = pythonLauncher;
	process.env.SIGNET_RACE_TARGET = target;
	process.env.SIGNET_RACE_ATTACKER = attacker;
	process.env.SIGNET_RACE_PARKED = parked;
	process.env.SIGNET_RACE_MOVED = moved;
	process.env.SIGNET_RACE_REAL_PYTHON = pythonPath;
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

	const originalOpenSync = fs.openSync;
	let pathnameSwapPerformed = false;
	const interceptOpenSync: typeof fs.openSync = (file, flags, mode) => {
		if (file !== markerPath || pathnameSwapPerformed) return originalOpenSync(file, flags, mode);
		pathnameSwapPerformed = true;
		fs.renameSync(target, parked);
		fs.renameSync(attacker, target);
		try {
			return originalOpenSync(file, flags, mode);
		} finally {
			fs.renameSync(target, moved);
			fs.renameSync(parked, target);
			fs.renameSync(moved, attacker);
		}
	};
	const originalSpawnSync = childProcess.spawnSync;
	let descriptorReadSwapPerformed = false;
	const interceptSpawnSync: typeof childProcess.spawnSync = (command, args, options) => {
		const script = args?.[args.indexOf("-c") + 1];
		const isMarkerRead =
			script?.includes("os.open") === true && script.includes("dir_fd=3") && args?.at(-1) === "signet.install.json";
		if (!isMarkerRead || descriptorReadSwapPerformed) return originalSpawnSync(command, args, options);
		descriptorReadSwapPerformed = true;
		fs.renameSync(target, parked);
		fs.renameSync(attacker, target);
		try {
			return originalSpawnSync(command, args, options);
		} finally {
			fs.renameSync(target, moved);
			fs.renameSync(parked, target);
			fs.renameSync(moved, attacker);
		}
	};
	mock.module("node:fs", () => ({ ...fs, openSync: interceptOpenSync }));
	mock.module("node:child_process", () => ({ ...childProcess, spawnSync: interceptSpawnSync }));

	try {
		const { HermesAgentConnector } = await import("./src/index.js");
		let uninstallError: unknown;
		try {
			await new HermesAgentConnector().uninstall();
		} catch (error) {
			uninstallError = error;
		}

		expect(uninstallError === undefined || uninstallError instanceof Error).toBe(true);
		expect(descriptorReadSwapPerformed).toBe(true);
		expect(pathnameSwapPerformed).toBe(false);
		expect(fs.existsSync(target)).toBe(true);
		expect(fs.readFileSync(victimPath, "utf8")).toBe("unowned contents\n");
		expect(fs.existsSync(join(attacker, "signet.install.json"))).toBe(true);
	} finally {
		mock.restore();
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		for (const [name, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(fixture, { recursive: true, force: true });
	}
});
