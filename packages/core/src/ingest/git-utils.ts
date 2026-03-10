/**
 * Shared git binary resolution for parsers that shell out to git.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";

/**
 * Find the git binary path. Checks common locations, then falls back to `which`.
 * Returns null if git is not found.
 */
export function findGit(): string | null {
	const candidates = ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	try {
		const result = execFileSync("/usr/bin/which", ["git"], {
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
		});
		const path = result.trim();
		if (path && existsSync(path)) return path;
	} catch {
		// which not available
	}

	return null;
}
