import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function resolveTestPythonPath(): string {
	const result = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf-8" });
	const executable = result.stdout.trim();
	if (result.status !== 0 || !executable) throw new Error("Python 3 is required for the Hermes connector tests");
	return executable;
}

test("uninstall preserves a replacement entry swapped after the descriptor identity check", async () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	const originalEnv = {
		HOME: process.env.HOME,
		HERMES_HOME: process.env.HERMES_HOME,
		HERMES_REPO: process.env.HERMES_REPO,
		PYTHON: process.env.PYTHON,
		SIGNET_RACE_ENTRY: process.env.SIGNET_RACE_ENTRY,
		SIGNET_RACE_LOG: process.env.SIGNET_RACE_LOG,
		SIGNET_RACE_REAL_PYTHON: process.env.SIGNET_RACE_REAL_PYTHON,
	};
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), "signet-hermes-uninstall-race-")));
	const hermesHome = join(fixture, ".hermes");
	const target = join(hermesHome, "plugins", "signet");
	const raceEntry = join(target, "a-race-entry.txt");
	const markerPath = join(target, "signet.install.json");
	try {
		mkdirSync(target, { recursive: true });
		process.env.HOME = fixture;
		process.env.HERMES_HOME = hermesHome;
		delete process.env.HERMES_REPO;
		process.env.SIGNET_RACE_ENTRY = "a-race-entry.txt";
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

		const pythonPath = resolveTestPythonPath();
		const pythonLauncher = join(fixture, "python-race-launcher");
		const pythonLog = join(fixture, "python-launcher.log");
		process.env.SIGNET_RACE_LOG = pythonLog;
		writeFileSync(
			pythonLauncher,
			[
				`#!${pythonPath}`,
				"import os, subprocess, sys",
				"args = sys.argv[1:]",
				"with open(os.environ['SIGNET_RACE_LOG'], 'a') as log: log.write('CALL ' + repr(args) + '\\n')",
				"if '-c' in args:",
				"    script_index = args.index('-c') + 1",
				"    script = args[script_index]",
				"    needle = 'current = os.stat(name, dir_fd=3, follow_symlinks=False)'",
				"    if 'expected_ino = int(sys.argv[2])' in script and needle in script and args[script_index + 3] == 'file' and args[script_index + 4] == os.environ['SIGNET_RACE_ENTRY']:",
				"        race = \"\\n    if operation == 'file' and name == os.environ['SIGNET_RACE_ENTRY']:\\n        replacement = name + '.replacement'\\n        fd = os.open(replacement, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=3)\\n        os.write(fd, b'unowned replacement')\\n        os.close(fd)\\n        os.replace(replacement, name, src_dir_fd=3, dst_dir_fd=3)\"",
				"        args[script_index] = script.replace(needle, needle + race, 1)",
				"        with open(os.environ['SIGNET_RACE_LOG'], 'a') as log: log.write('INJECTED\\n')",
				"result = subprocess.run([os.environ['SIGNET_RACE_REAL_PYTHON'], *args], pass_fds=(3,), check=False)",
				"raise SystemExit(result.returncode)",
				"",
			].join("\n"),
		);
		chmodSync(pythonLauncher, 0o755);
		process.env.PYTHON = pythonLauncher;
		process.env.SIGNET_RACE_REAL_PYTHON = pythonPath;

		const { HermesAgentConnector } = await import("./src/index.ts");
		const connector = new HermesAgentConnector();
		const install = await connector.install(fixture);
		expect(install.success).toBe(true);
		const marker = readFileSync(markerPath, "utf8");
		for (const name of readdirSync(target)) unlinkSync(join(target, name));
		writeFileSync(raceEntry, "owned file contents");
		writeFileSync(markerPath, marker);

		let uninstallError: unknown;
		try {
			await connector.uninstall();
		} catch (error) {
			uninstallError = error;
		}

		expect(readFileSync(pythonLog, "utf8")).toContain("INJECTED");
		expect(uninstallError).toBeInstanceOf(Error);
		expect(existsSync(raceEntry)).toBe(true);
		expect(readFileSync(raceEntry, "utf8")).toBe("unowned replacement");
		expect(existsSync(markerPath)).toBe(true);
		expect(readdirSync(target).sort()).toEqual(["a-race-entry.txt", "signet.install.json"]);
	} finally {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		for (const [name, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(fixture, { recursive: true, force: true });
	}
});
