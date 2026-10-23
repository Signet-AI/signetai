import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeInstallPathFix, persistNativeInstallPath, printNativeInstallResult } from "./native-install.js";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "signet-native-install-"));
}

const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

describe("persistNativeInstallPath", () => {
	test("persists the macOS zsh PATH entry in .zprofile", () => {
		const home = makeHome();
		homes.push(home);
		const binDir = join(home, ".local", "bin");

		const result = persistNativeInstallPath(binDir, {
			home,
			platform: "darwin",
			shell: "/bin/zsh",
			pathValue: "/usr/bin:/bin",
		});

		expect(result).toEqual({ profilePath: join(home, ".zprofile"), persisted: true });
		expect(readFileSync(join(home, ".zprofile"), "utf8")).toBe('export PATH="$HOME/.local/bin:$PATH"\n');
	});

	test("does not duplicate a persisted PATH entry", () => {
		const home = makeHome();
		homes.push(home);
		const binDir = join(home, ".local", "bin");
		const profilePath = join(home, ".zprofile");
		persistNativeInstallPath(binDir, { home, platform: "darwin", shell: "/bin/zsh", pathValue: "/usr/bin" });
		const first = readFileSync(profilePath, "utf8");

		const result = persistNativeInstallPath(binDir, {
			home,
			platform: "darwin",
			shell: "/bin/zsh",
			pathValue: "/usr/bin",
		});

		expect(result).toEqual({ profilePath, persisted: true });
		expect(readFileSync(profilePath, "utf8")).toBe(first);
	});

	test("persists the bash PATH entry in .bash_profile", () => {
		const home = makeHome();
		homes.push(home);
		const binDir = join(home, ".local", "bin");

		const result = persistNativeInstallPath(binDir, {
			home,
			platform: "darwin",
			shell: "/bin/bash",
			pathValue: "/usr/bin:/bin",
		});

		expect(result).toEqual({ profilePath: join(home, ".bash_profile"), persisted: true });
		expect(readFileSync(join(home, ".bash_profile"), "utf8")).toBe('export PATH="$HOME/.local/bin:$PATH"\n');
	});

	test("persists a custom bin directory even when the profile has the default alias", () => {
		const home = makeHome();
		homes.push(home);
		const binDir = join(home, "custom", "bin");
		const profilePath = join(home, ".bash_profile");
		writeFileSync(profilePath, 'export PATH="$HOME/.local/bin:$PATH"\n', "utf8");

		const result = persistNativeInstallPath(binDir, {
			home,
			platform: "linux",
			shell: "/bin/bash",
			pathValue: "/usr/bin:/bin",
		});

		expect(result).toEqual({ profilePath, persisted: true });
		expect(readFileSync(profilePath, "utf8")).toBe(
			`export PATH="$HOME/.local/bin:$PATH"\nexport PATH="${binDir}:$PATH"\n`,
		);
	});

	test("updates the first existing bash startup file instead of creating .bash_profile", () => {
		const home = makeHome();
		homes.push(home);
		const binDir = join(home, ".local", "bin");
		const profilePath = join(home, ".profile");
		writeFileSync(profilePath, "# existing profile\n", "utf8");

		const result = persistNativeInstallPath(binDir, {
			home,
			platform: "linux",
			shell: "/bin/bash",
			pathValue: "/usr/bin:/bin",
		});

		expect(result).toEqual({ profilePath, persisted: true });
		expect(existsSync(join(home, ".bash_profile"))).toBe(false);
		expect(readFileSync(profilePath, "utf8")).toBe('# existing profile\nexport PATH="$HOME/.local/bin:$PATH"\n');
	});

	test("does not treat a near-prefix default alias as the requested directory", () => {
		const home = makeHome();
		homes.push(home);
		const binDir = join(home, ".local", "bin");
		const profilePath = join(home, ".bash_profile");
		writeFileSync(profilePath, 'export PATH="$HOME/.local/bin-old:$PATH"\n', "utf8");

		const result = persistNativeInstallPath(binDir, {
			home,
			platform: "linux",
			shell: "/bin/bash",
			pathValue: "/usr/bin:/bin",
		});

		expect(result).toEqual({ profilePath, persisted: true });
		expect(readFileSync(profilePath, "utf8")).toBe(
			`export PATH="$HOME/.local/bin-old:$PATH"\nexport PATH="$HOME/.local/bin:$PATH"\n`,
		);
	});

	test("skips persistence when PATH already contains the directory", () => {
		const home = makeHome();
		homes.push(home);
		const binDir = "/home/test/.local/bin";
		const result = persistNativeInstallPath(binDir, {
			home,
			platform: "darwin",
			shell: "/bin/bash",
			pathValue: `${binDir}:/usr/bin`,
		});

		expect(result).toEqual({ profilePath: null, persisted: false });
		expect(existsSync(join(home, ".bash_profile"))).toBe(false);
	});

	test("skips persistence in a non-interactive shell and leaves a manual fallback", () => {
		const home = makeHome();
		homes.push(home);
		const binDir = join(home, ".local", "bin");

		const result = persistNativeInstallPath(binDir, {
			home,
			platform: "darwin",
			shell: "/bin/zsh",
			pathValue: "/usr/bin:/bin",
			interactive: false,
		});

		expect(result).toEqual({ profilePath: null, persisted: false });
		expect(existsSync(join(home, ".zprofile"))).toBe(false);
	});

	test("does not modify the profile when the exact directory is already on PATH", () => {
		const home = makeHome();
		homes.push(home);
		const binDir = "/home/test/.local/bin";
		const profilePath = join(home, ".zprofile");
		const existing = '# Signet\nexport PATH="$HOME/.local/bin:$PATH"\n';
		writeFileSync(profilePath, existing, "utf8");

		const result = persistNativeInstallPath(binDir, {
			home,
			platform: "darwin",
			shell: "/bin/zsh",
			pathValue: `${binDir}:/usr/bin`,
		});

		expect(result).toEqual({ profilePath: null, persisted: false });
		expect(readFileSync(profilePath, "utf8")).toBe(existing);
	});

	test("does not persist PATH on Windows", () => {
		const home = makeHome();
		homes.push(home);

		const result = persistNativeInstallPath(join(home, "Signet"), {
			home,
			platform: "win32",
			shell: "powershell.exe",
			pathValue: "C:\\\\Windows\\\\System32",
		});

		expect(result).toEqual({ profilePath: null, persisted: false });
	});

	test("prints the shell reload step after configuring PATH", () => {
		const lines: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
		try {
			printNativeInstallResult({
				source: "/tmp/signet",
				target: "/home/test/.local/bin/signet",
				installed: true,
				pathHint: null,
				pathProfile: "/home/test/.zprofile",
				pathPersisted: true,
				pathFix: null,
				connectorAssetsDir: null,
				daemonJsAssetsDir: null,
			});
		} finally {
			console.log = originalLog;
		}

		expect(lines.join("\n")).toContain("Open a new shell or run `source /home/test/.zprofile`");
	});

	test("prints copy-pastable PATH commands when the installer cannot edit the profile", () => {
		const lines: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
		try {
			printNativeInstallResult({
				source: "/tmp/signet",
				target: "/Users/test/.local/bin/signet",
				installed: true,
				pathHint: "/Users/test/.local/bin",
				pathProfile: null,
				pathPersisted: false,
				pathFix: nativeInstallPathFix("/Users/test/.local/bin", {
					home: "/Users/test",
					platform: "darwin",
					shell: "/bin/zsh",
					pathValue: "/usr/bin:/bin",
				}),
				connectorAssetsDir: null,
				daemonJsAssetsDir: null,
			});
		} finally {
			console.log = originalLog;
		}

		expect(lines).toContain(`  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile`);
		expect(lines).toContain('  export PATH="$HOME/.local/bin:$PATH"');
	});
});

describe("nativeInstallPathFix", () => {
	test("returns the zsh profile commands on macOS", () => {
		expect(
			nativeInstallPathFix("/Users/test/.local/bin", {
				home: "/Users/test",
				platform: "darwin",
				shell: "/bin/zsh",
				pathValue: "/usr/bin:/bin",
			}),
		).toEqual({
			commands: [`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile`, 'export PATH="$HOME/.local/bin:$PATH"'],
			persistent: true,
		});
	});

	test("targets the existing bash startup file", () => {
		const home = makeHome();
		homes.push(home);
		writeFileSync(join(home, ".profile"), "# existing profile\n", "utf8");

		const fix = nativeInstallPathFix(join(home, ".local", "bin"), {
			home,
			platform: "linux",
			shell: "/bin/bash",
			pathValue: "/usr/bin:/bin",
		});

		expect(fix?.commands[0]).toBe(`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile`);
	});

	test("uses fish_add_path for fish", () => {
		expect(
			nativeInstallPathFix("/home/test/.local/bin", {
				home: "/home/test",
				platform: "linux",
				shell: "/usr/bin/fish",
				pathValue: "/usr/bin",
			}),
		).toEqual({ commands: ["fish_add_path /home/test/.local/bin"], persistent: true });
	});

	test("returns a session-only export for an unknown shell profile", () => {
		expect(
			nativeInstallPathFix("/home/test/.local/bin", {
				home: "/home/test",
				platform: "linux",
				shell: "/bin/sh",
				pathValue: "/usr/bin",
			}),
		).toEqual({ commands: ['export PATH="$HOME/.local/bin:$PATH"'], persistent: false });
	});

	test("returns null when PATH already has the directory or on Windows", () => {
		const options = { home: "/home/test", shell: "/bin/zsh" } as const;
		expect(
			nativeInstallPathFix("/home/test/.local/bin", {
				...options,
				platform: "linux",
				pathValue: "/home/test/.local/bin:/usr/bin",
			}),
		).toBeNull();
		expect(nativeInstallPathFix("C:\\Signet", { ...options, platform: "win32", pathValue: "C:\\Windows" })).toBeNull();
	});

	test("printed profile command writes the same line the interactive installer writes", () => {
		const home = makeHome();
		homes.push(home);
		for (const binDir of [join(home, ".local", "bin"), join(home, "it's a dir", "bin")]) {
			const options = { home, platform: "darwin", shell: "/bin/zsh", pathValue: "/usr/bin:/bin" } as const;
			const fix = nativeInstallPathFix(binDir, options);
			const printed = spawnSync("sh", ["-c", fix?.commands[0] ?? "exit 1"], { env: { HOME: home } });
			expect(printed.status).toBe(0);
			const viaCommand = readFileSync(join(home, ".zprofile"), "utf8");
			rmSync(join(home, ".zprofile"));

			persistNativeInstallPath(binDir, options);
			expect(viaCommand).toBe(readFileSync(join(home, ".zprofile"), "utf8"));
			rmSync(join(home, ".zprofile"));
		}
	});
});
