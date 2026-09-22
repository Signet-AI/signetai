import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
function linkDirSync(target: string, path: string): void {
	const type = process.platform === "win32" ? "junction" : "dir";
	symlinkSync(target, path, type);
}

export interface SymlinkOptions {
	dryRun?: boolean;
	force?: boolean;
}

export interface SymlinkResult {
	created: string[];
	skipped: string[];
	errors: Array<{ path: string; error: string }>;
}
export function symlinkSkills(sourceDir: string, targetDir: string, options: SymlinkOptions = {}): SymlinkResult {
	const result: SymlinkResult = {
		created: [],
		skipped: [],
		errors: [],
	};
	if (!existsSync(sourceDir)) {
		return result;
	}
	const targetParent = join(targetDir, "..");
	if (!existsSync(targetParent)) {
		mkdirSync(targetParent, { recursive: true });
	}
	if (!existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true });
	}
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
		try {
			const src = lstatSync(srcPath);
			if (src.isSymbolicLink() || !src.isDirectory()) {
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
		try {
			const destStat = lstatSync(destPath);
			if (destStat.isSymbolicLink()) {
				if (!options.dryRun) {
					unlinkSync(destPath);
				}
			} else {
				result.skipped.push(destPath);
				continue;
			}
		} catch {}
		if (options.dryRun) {
			result.created.push(`${destPath} (dry-run)`);
		} else {
			try {
				linkDirSync(srcPath, destPath);
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
export function symlinkDir(src: string, dest: string, options: SymlinkOptions = {}): boolean {
	if (!existsSync(src)) {
		return false;
	}
	if (existsSync(dest)) {
		try {
			const stat = lstatSync(dest);
			if (stat.isSymbolicLink()) {
				if (!options.dryRun) {
					unlinkSync(dest);
				}
			} else if (!options.force) {
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
		linkDirSync(src, dest);
		return true;
	} catch {
		return false;
	}
}
