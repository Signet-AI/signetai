import { constants } from "node:fs";
import { readdir, open, lstat } from "node:fs/promises";
import { join } from "node:path";

export async function inspectConnectorFiles(
	configPaths: readonly string[],
): Promise<{ inlineKeyFiles: string[]; scanIncomplete: boolean }> {
	const inlineKeyFiles = new Set<string>();
	const seen = new Set<string>();
	let scanIncomplete = false;
	const deadline = Date.now() + 5000;
	async function visit(path: string, depth: number, declared = false): Promise<void> {
		if (seen.has(path)) return;
		if (seen.size >= 2048 || Date.now() >= deadline) {
			scanIncomplete = true;
			return;
		}
		seen.add(path);
		try {
			const info = await lstat(path);
			if (info.isSymbolicLink()) {
				scanIncomplete = true;
				return;
			}
			if (info.isDirectory()) {
				if (depth < 0) {
					scanIncomplete = true;
					return;
				}
				for (const entry of await readdir(path, { withFileTypes: true })) {
					if (["node_modules", "sessions", "projects", ".git", "skills", "cache", "__pycache__"].includes(entry.name))
						continue;
					await visit(join(path, entry.name), depth - 1);
				}
				return;
			}
			if (!declared && !/(?:\.jsonc?|\.ya?ml|\.toml|\.cmd|\.ps1|\.sh|\.m?[jt]s|\.py|\.md|\.env)$/.test(path)) return;
			const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
			try {
				const before = await handle.stat();
				if (!before.isFile() || before.size > 8 * 1024 * 1024) {
					scanIncomplete = true;
					return;
				}
				const buffer = Buffer.alloc(before.size);
				let offset = 0;
				while (offset < buffer.length) {
					if (Date.now() >= deadline) {
						scanIncomplete = true;
						return;
					}
					const { bytesRead } = await handle.read(buffer, offset, Math.min(65536, buffer.length - offset), offset);
					if (!bytesRead) {
						scanIncomplete = true;
						return;
					}
					offset += bytesRead;
				}
				const after = await handle.stat();
				if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) scanIncomplete = true;
				const content = buffer.toString("utf8");
				if (
					/sig_(?:sk|ses|ref)_[A-Za-z0-9_.-]{8,}/.test(content) ||
					/(?:^|[\s"'])SIGNET_(?:API_KEY|TOKEN)\s*=\s*["']?[A-Za-z0-9_./+=:-]+/m.test(content) ||
					/["']SIGNET_(?:API_KEY|TOKEN)["']\s*:\s*["'][^"'\s]+["']/.test(content)
				)
					inlineKeyFiles.add(path);
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) scanIncomplete = true;
		}
	}
	for (const path of configPaths) await visit(path, 3, true);
	return { inlineKeyFiles: [...inlineKeyFiles].sort(), scanIncomplete };
}
