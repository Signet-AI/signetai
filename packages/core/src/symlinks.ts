/**
 * @signet/core - Symlink utilities
 *
 * Functions for managing symlinks, particularly for skills directories
 * that need to be shared across different harness installations.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	statSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";

export interface SymlinkOptions {
	/** If true, don't actually create symlinks, just report what would happen */
	dryRun?: boolean;
	/** Force recreation of existing symlinks */
	force?: boolean;
}

export interface SymlinkResult {
	/** Paths where symlinks were created */
	created: string[];
	/** Paths that were skipped (already exist, not directories, etc.) */
	skipped: string[];
	/** Errors encountered */
	errors: Array<{ path: string; error: string }>;
}

/**
 * Symlink all subdirectories from source to target directory.
 *
 * This is used to share skills from ~/.agents/skills/ to harness-specific
 * directories like ~/.claude/skills/ or ~/.config/opencode/skills/.
 *
 * Behavior:
 * - Only directories are symlinked (files are ignored)
 * - Existing symlinks are replaced (removed then recreated)
 * - Real directories at target are skipped to avoid data loss
 * - Gracefully handles errors (continues with other items)
 */
export function symlinkSkills(
	sourceDir: string,
	targetDir: string,
	options: SymlinkOptions = {},
): SymlinkResult {
	const result: SymlinkResult = {
		created: [],
		skipped: [],
		errors: [],
	};

	// Check if source exists
	if (!existsSync(sourceDir)) {
		return result;
	}

	// Ensure target parent exists
	const targetParent = join(targetDir, "..");
	if (!existsSync(targetParent)) {
		mkdirSync(targetParent, { recursive: true });
	}

	// Ensure target directory exists
	if (!existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true });
	}

	// Read source directory
	let entries: string[];
	try {
		entries = readdirSync(sourceDir);
	} catch (e) {
		result.errors.push({
			path: sourceDir,
			error: `Failed to read directory: ${(e as Error).message}`,
		});
		return result;
	}

	for (const entry of entries) {
		const srcPath = join(sourceDir, entry);
		const destPath = join(targetDir, entry);

		// Skip if not a directory
		try {
			if (!statSync(srcPath).isDirectory()) {
				result.skipped.push(srcPath);
				continue;
			}
		} catch (e) {
			result.errors.push({
				path: srcPath,
				error: `Failed to stat: ${(e as Error).message}`,
			});
			continue;
		}

		// Check if destination exists
		try {
			const destStat = lstatSync(destPath);
			if (destStat.isSymbolicLink()) {
				// Remove existing symlink
				if (!options.dryRun) {
					unlinkSync(destPath);
				}
			} else {
				// It's a real directory or file - skip to avoid data loss
				result.skipped.push(destPath);
				continue;
			}
		} catch {
			// dest doesn't exist, that's fine
		}

		// Create symlink
		if (options.dryRun) {
			result.created.push(`${destPath} (dry-run)`);
		} else {
			try {
				symlinkSync(srcPath, destPath);
				result.created.push(destPath);
			} catch (e) {
				result.errors.push({
					path: destPath,
					error: `Failed to create symlink: ${(e as Error).message}`,
				});
			}
		}
	}

	return result;
}

/**
 * Create a single directory symlink.
 *
 * Creates the symlink at dest pointing to src.
 * If dest exists and is a symlink, it's replaced.
 * If dest exists and is real, the operation fails unless force is true.
 */
export function symlinkDir(
	src: string,
	dest: string,
	options: SymlinkOptions = {},
): boolean {
	// Check source exists
	if (!existsSync(src)) {
		return false;
	}

	// Handle existing destination
	if (existsSync(dest)) {
		try {
			const stat = lstatSync(dest);
			if (stat.isSymbolicLink()) {
				if (!options.dryRun) {
					unlinkSync(dest);
				}
			} else if (!options.force) {
				// Real file/dir exists and not forcing
				return false;
			}
		} catch {
			return false;
		}
	}

	if (options.dryRun) {
		return true;
	}

	try {
		symlinkSync(src, dest);
		return true;
	} catch {
		return false;
	}
}
