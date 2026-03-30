/**
 * Shared git binary resolution for parsers that shell out to git.
 */

import { existsSync } from "fs";
import { execFileSync } from "child_process";

/**
 * Find the git binary path. Checks common locations, then falls back to `which`.
 * Returns null if git is not found.
 */
export function findGit(): string | null {
	const isWindows = process.platform === "win32";

	if (!isWindows) {
		const candidates = ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];

		for (const candidate of candidates) {
			if (existsSync(candidate)) return candidate;
		}
	}

	try {
		const locator = isWindows ? "where" : "/usr/bin/which";
		const result = execFileSync(locator, ["git"], {
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
		});
		const path = result.trim().split(/\r?\n/)[0];
		if (path && existsSync(path)) return path;
	} catch {
		// locator not available
	}

	return null;
}
