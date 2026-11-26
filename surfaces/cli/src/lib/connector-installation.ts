import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface SavedFile {
	readonly kind: "file";
	readonly bytes: Buffer;
	readonly mode: number;
}
interface SavedLink {
	readonly kind: "link";
	readonly target: string;
}
interface SavedDirectory {
	readonly kind: "directory";
	readonly children: ReadonlyMap<string, SavedPath>;
}
type SavedPath = SavedFile | SavedLink | SavedDirectory | null;
function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export async function snapshotInstallation(paths: readonly string[]): Promise<() => Promise<void>> {
	let count = 0;
	let bytes = 0;
	const deadline = Date.now() + 5000;
	async function save(path: string, depth: number): Promise<SavedPath> {
		if (++count > 2048 || depth > 8 || Date.now() >= deadline) throw new Error("Installation snapshot limit exceeded");
		try {
			const info = await lstat(path);
			if (info.isSymbolicLink()) return { kind: "link", target: await readlink(path) };
			if (info.isDirectory()) {
				const children = new Map<string, SavedPath>();
				for (const name of await readdir(path)) children.set(name, await save(join(path, name), depth + 1));
				return { kind: "directory", children };
			}
			const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
			try {
				const before = await handle.stat();
				if (!before.isFile() || before.size > 8 * 1024 * 1024 || (bytes += before.size) > 32 * 1024 * 1024)
					throw new Error("Installation snapshot size limit exceeded");
				const buffer = Buffer.alloc(before.size);
				let offset = 0;
				while (offset < buffer.length) {
					if (Date.now() >= deadline) throw new Error("Installation snapshot deadline exceeded");
					const { bytesRead } = await handle.read(buffer, offset, Math.min(65536, buffer.length - offset), offset);
					if (!bytesRead) throw new Error("Installation input changed while reading");
					offset += bytesRead;
				}
				const after = await handle.stat();
				if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
					throw new Error("Installation input changed while reading");
				return { kind: "file", bytes: buffer, mode: before.mode & 0o777 };
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (missing(error)) return null;
			throw error;
		}
	}
	async function restore(path: string, saved: SavedPath): Promise<void> {
		if (saved === null) {
			await rm(path, { recursive: true, force: true });
			return;
		}
		let current: Stats | undefined;
		try {
			current = await lstat(path);
		} catch (error) {
			if (!missing(error)) throw error;
		}
		if (saved.kind === "directory") {
			if (current && !current.isDirectory()) await rm(path, { force: true });
			await mkdir(path, { recursive: true });
			for (const name of await readdir(path))
				if (!saved.children.has(name)) await rm(join(path, name), { recursive: true, force: true });
			for (const [name, value] of saved.children) await restore(join(path, name), value);
		} else if (saved.kind === "link") {
			if (current?.isSymbolicLink() && (await readlink(path)) === saved.target) return;
			await rm(path, { recursive: true, force: true });
			await mkdir(dirname(path), { recursive: true });
			await symlink(saved.target, path);
		} else {
			if (current?.isFile() && current.size === saved.bytes.length) {
				const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
				try {
					const buffer = Buffer.alloc(saved.bytes.length);
					let offset = 0;
					while (offset < buffer.length) {
						const { bytesRead } = await handle.read(buffer, offset, Math.min(65536, buffer.length - offset), offset);
						if (!bytesRead) break;
						offset += bytesRead;
					}
					if (offset === buffer.length && buffer.equals(saved.bytes)) {
						if ((current.mode & 0o777) !== saved.mode) await chmod(path, saved.mode);
						return;
					}
				} finally {
					await handle.close();
				}
			}
			if (current && !current.isFile()) await rm(path, { recursive: true, force: true });
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, saved.bytes, { mode: saved.mode });
			await chmod(path, saved.mode);
		}
	}
	const originals = new Map<string, SavedPath>();
	for (const path of new Set(paths)) originals.set(path, await save(path, 0));
	return async () => {
		for (const [path, saved] of originals) await restore(path, saved);
	};
}
