import type { Dirent } from "node:fs";
import { readdir, readFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function inspectConnectorFiles(
	configPath: string,
): Promise<{ inlineKeyFiles: string[]; scanIncomplete: boolean }> {
	const inlineKeyFiles: string[] = [];
	let visited = 0;
	let scanIncomplete = false;
	async function walk(directory: string, depth: number): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			if (++visited > 2048) {
				scanIncomplete = true;
				return;
			}
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (depth > 0 && !["node_modules", "sessions", "projects", ".git", "skills", "cache"].includes(entry.name))
					await walk(path, depth - 1);
				continue;
			}
			if (!entry.isFile() || !/(?:\.jsonc?|\.yaml|\.toml|\.cmd|\.ps1|\.sh|\.m?js|\.env)$/.test(entry.name)) continue;
			const info = await lstat(path);
			if (info.size > 8 * 1024 * 1024) {
				scanIncomplete = true;
				continue;
			}
			const content = await readFile(path, "utf8");
			if (/sig_(?:sk|ses|ref)_[A-Za-z0-9_.-]{8,}/.test(content)) inlineKeyFiles.push(path);
		}
	}
	await walk(dirname(configPath), 3);
	return { inlineKeyFiles: inlineKeyFiles.sort(), scanIncomplete };
}
