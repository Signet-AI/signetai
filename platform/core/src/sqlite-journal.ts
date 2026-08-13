/**
 * SQLite journal settings for filesystems with and without reliable WAL
 * shared-memory and locking semantics.
 */

import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";

const NETWORK_FILESYSTEM_TYPES = new Set(["afpfs", "nfs", "smbfs", "webdav"]);

type FilesystemStats = {
	readonly f_fstypename?: unknown;
};

export type SqliteJournalMode = "WAL" | "DELETE";

export interface SqliteJournalConfig {
	readonly filesystemType: string | null;
	readonly networkFilesystem: boolean;
	readonly journalMode: SqliteJournalMode;
}

/** Return true for filesystem types where SQLite WAL sidecars are unsafe. */
export function isNetworkFilesystem(filesystemType: string | null): boolean {
	if (filesystemType === null) return false;
	return NETWORK_FILESYSTEM_TYPES.has(filesystemType.trim().toLowerCase());
}

/**
 * Read the Darwin filesystem name for a directory. Node's statfs wrapper does
 * not expose f_fstypename on every runtime, so use macOS's stat utility as a
 * fallback. This intentionally detects filesystem type only. In particular,
 * iCloud paths on APFS are not classified as network filesystems here.
 */
export function detectFilesystemType(
	path: string,
	opts?: {
		readonly platform?: NodeJS.Platform;
		readonly statfs?: (path: string) => FilesystemStats;
		readonly statCommand?: (path: string) => string;
	},
): string | null {
	const platform = opts?.platform ?? process.platform;
	if (platform !== "darwin") return null;

	try {
		const stats = (opts?.statfs ?? ((target: string) => statfsSync(target) as unknown as FilesystemStats))(path);
		if (typeof stats.f_fstypename === "string" && stats.f_fstypename.trim().length > 0) {
			return stats.f_fstypename.trim();
		}
	} catch {
		// The stat utility below provides the Darwin fallback.
	}

	try {
		const output =
			opts?.statCommand?.(path) ?? (execFileSync("/usr/bin/stat", ["-f", "%T", path], { encoding: "utf8" }) as string);
		const filesystemType = output.trim();
		return filesystemType.length > 0 ? filesystemType : null;
	} catch {
		return null;
	}
}

export function resolveSqliteJournalConfig(opts?: {
	readonly platform?: NodeJS.Platform;
	readonly directory?: string;
	readonly filesystemType?: string | null;
	readonly statfs?: (path: string) => FilesystemStats;
	readonly statCommand?: (path: string) => string;
}): SqliteJournalConfig {
	const filesystemType =
		opts?.filesystemType !== undefined
			? opts.filesystemType
			: opts?.directory === undefined
				? null
				: detectFilesystemType(opts.directory, {
						platform: opts.platform,
						statfs: opts.statfs,
						statCommand: opts.statCommand,
					});
	const networkFilesystem = (opts?.platform ?? process.platform) === "darwin" && isNetworkFilesystem(filesystemType);
	return {
		filesystemType,
		networkFilesystem,
		journalMode: networkFilesystem ? "DELETE" : "WAL",
	};
}
