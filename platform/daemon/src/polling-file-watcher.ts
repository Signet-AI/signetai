import { stat } from "node:fs/promises";

export type FileWatchEvent = "add" | "change" | "unlink";

interface FileFingerprint {
	readonly mtimeMs: number;
	readonly size: number;
}

export interface PollingFileWatcher {
	close(): void;
}

async function fingerprint(path: string): Promise<FileFingerprint | null> {
	try {
		const value = await stat(path);
		return value.isFile() ? { mtimeMs: value.mtimeMs, size: value.size } : null;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { readonly code?: unknown }).code === "ENOENT"
		) {
			return null;
		}
		throw error;
	}
}

export async function startPollingFileWatcher(options: {
	readonly paths: readonly string[];
	readonly intervalMs: number;
	readonly onError: (error: unknown) => void;
	readonly onEvent: (event: FileWatchEvent, path: string) => void;
}): Promise<PollingFileWatcher> {
	const state = new Map<string, FileFingerprint | null>();
	for (const path of options.paths) state.set(path, await fingerprint(path));

	let scanning = false;
	const timer = setInterval(() => {
		if (scanning) return;
		scanning = true;
		void (async () => {
			for (const path of options.paths) {
				const before = state.get(path) ?? null;
				const after = await fingerprint(path);
				state.set(path, after);
				if (!before && after) options.onEvent("add", path);
				else if (before && !after) options.onEvent("unlink", path);
				else if (before && after && (before.mtimeMs !== after.mtimeMs || before.size !== after.size)) {
					options.onEvent("change", path);
				}
			}
		})()
			.catch(options.onError)
			.finally(() => {
				scanning = false;
			});
	}, options.intervalMs);
	timer.unref?.();

	return {
		close() {
			clearInterval(timer);
		},
	};
}
