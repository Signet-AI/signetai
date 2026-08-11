import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistNativeInstallPath } from "./native-install.js";

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

	test("skips persistence when PATH already contains the directory", () => {
		const home = makeHome();
		homes.push(home);
		const binDir = join(home, ".local", "bin");
		const result = persistNativeInstallPath(binDir, {
			home,
			platform: "darwin",
			shell: "/bin/bash",
			pathValue: `${binDir}:/usr/bin`,
		});

		expect(result).toEqual({ profilePath: null, persisted: false });
		expect(existsSync(join(home, ".bash_profile"))).toBe(false);
	});
});
